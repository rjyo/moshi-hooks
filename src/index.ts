#!/usr/bin/env bun

// moshi-hooks — Claude Code hook adapter
// Reads hook events from stdin, normalizes them, and POSTs to the Moshi API.
// Zero runtime dependencies — uses Bun builtins only.

import { homedir } from "os"
import { basename, dirname, resolve } from "path"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface HookInput {
  hook_event_name: string
  session_id: string
  transcript_path?: string
  cwd?: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  title?: string
  message?: string
  model?: string
  stop_hook_reason?: string
  last_assistant_message?: string
  source?: string
  [key: string]: unknown
}

interface HookState {
  model?: string
  lastToolName?: string
  lastStopTime?: number
  sessionStartTime?: number
}

type EventType = "user_prompt" | "pre_tool" | "post_tool" | "notification" | "stop" | "agent_turn_complete"
type Category = "approval_required" | "task_complete" | "tool_running" | "tool_finished" | "info" | "error"

interface AgentEvent {
  source: "claude" | "codex" | "opencode"
  eventType: EventType
  sessionId: string
  category: Category
  title: string
  message: string
  eventId: string
  projectName?: string
  modelName?: string
  toolName?: string
  contextPercent?: number
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INTERESTING_TOOLS = new Set(["Bash", "Edit", "Write", "WebFetch", "WebSearch", "Task"])
const TOKEN_PATH = `${homedir()}/.config/moshi/token`
const API_URL = "https://api.getmoshi.app/api/v1/agent-events"
const STOP_COOLDOWN_S = 5
const REPLAY_SUPPRESS_S = 3
const HOOK_IDENTIFIER = "moshi-hooks"
const HOOK_TIMEOUT = 45

const DEFAULT_SETTINGS_PATH = `${homedir()}/.claude/settings.json`
const DEFAULT_LOCAL_SETTINGS_PATH = `${homedir()}/.claude/settings.local.json`
const CLAUDE_HOOK_COMMAND = `bunx moshi-hooks # ${HOOK_IDENTIFIER}`

const CODEX_DIR = `${homedir()}/.codex`
const CODEX_HOOKS_PATH = `${CODEX_DIR}/hooks.json`
const CODEX_CONFIG_PATH = `${CODEX_DIR}/config.toml`
const CODEX_HOOK_COMMAND = "bunx moshi-hooks --source codex"

export const HOOK_EVENTS: Record<string, { matcher?: string }> = {
  SessionStart: {},
  Stop: {},
  SubagentStop: {},
  Notification: { matcher: "permission_prompt|idle_prompt" },
  PreToolUse: {},
  PostToolUse: {},
}

// Codex uses the same hooks.json shape as Claude Code. Events listed here are
// the ones Codex emits that our main stdin handler cares about.
export const CODEX_HOOK_EVENTS: Record<string, { matcher?: string }> = {
  SessionStart: { matcher: "startup|resume" },
  PreToolUse: {},
  PostToolUse: {},
  Stop: {},
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function statePath(sessionId: string): string {
  return `/tmp/moshi-hook-${sessionId}.json`
}

async function readState(sessionId: string): Promise<HookState> {
  try {
    return await Bun.file(statePath(sessionId)).json()
  } catch {
    return {}
  }
}

async function writeState(sessionId: string, patch: Partial<HookState>): Promise<void> {
  const existing = await readState(sessionId)
  await Bun.write(statePath(sessionId), JSON.stringify({ ...existing, ...patch }))
}

// ---------------------------------------------------------------------------
// Token
// ---------------------------------------------------------------------------

async function loadToken(): Promise<string | null> {
  try {
    const text = await Bun.file(TOKEN_PATH).text()
    return text.trim() || null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Context percent — parse last assistant usage from transcript
// ---------------------------------------------------------------------------

async function getContextPercent(transcriptPath: string | undefined, modelContextWindow = 200_000): Promise<number | undefined> {
  if (!transcriptPath) return undefined
  try {
    const file = Bun.file(transcriptPath)
    const size = file.size
    const tail = await file.slice(Math.max(0, size - 10240)).text()
    const lines = tail.split("\n").filter(Boolean)

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]!)
        const usage = entry?.usage
        if (usage?.input_tokens != null) {
          const total = (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0)
          return Math.min(100, Math.round((total / modelContextWindow) * 100))
        }
      } catch {
        continue
      }
    }
  } catch {
    // transcript unreadable — not fatal
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Last assistant message — extract from transcript
// ---------------------------------------------------------------------------

async function getLastAssistantMessage(transcriptPath: string | undefined): Promise<string> {
  if (!transcriptPath) return ""
  try {
    const file = Bun.file(transcriptPath)
    const size = file.size
    const tail = await file.slice(Math.max(0, size - 10240)).text()
    const lines = tail.split("\n").filter(Boolean)

    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]!)
        if (entry?.role === "assistant" && entry?.message?.content) {
          const content = entry.message.content
          if (typeof content === "string") return content.slice(0, 200)
          if (Array.isArray(content)) {
            const text = content
              .filter((b: { type: string }) => b.type === "text")
              .map((b: { text: string }) => b.text)
              .join(" ")
            return text.slice(0, 200)
          }
        }
      } catch {
        continue
      }
    }
  } catch {
    // not fatal
  }
  return ""
}

// ---------------------------------------------------------------------------
// Tool input summary
// ---------------------------------------------------------------------------

function summarizeToolInput(toolName: string, toolInput: Record<string, unknown> | undefined): string {
  if (!toolInput) return ""
  if (toolName === "Bash") return String(toolInput.command ?? "").slice(0, 200)
  if (toolName === "Edit" || toolName === "Write") return String(toolInput.file_path ?? "").slice(0, 200)
  if (toolName === "WebFetch") return String(toolInput.url ?? "").slice(0, 200)
  if (toolName === "WebSearch") return String(toolInput.query ?? "").slice(0, 200)
  if (toolName === "Task") return String(toolInput.description ?? "").slice(0, 200)
  return ""
}

// ---------------------------------------------------------------------------
// Model name helper
// ---------------------------------------------------------------------------

function formatModelName(model: string | undefined): string | undefined {
  if (!model) return undefined
  return model.replace(/^claude-/, "")
}

// ---------------------------------------------------------------------------
// Send event to API
// ---------------------------------------------------------------------------

async function sendEvent(token: string, event: AgentEvent): Promise<void> {
  const body = JSON.stringify(event)
  const headers = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${token}`,
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(API_URL, {
        method: "POST",
        headers,
        body,
        signal: AbortSignal.timeout(5000),
      })
      if (res.ok || res.status < 500) return
    } catch {
      if (attempt > 0) return
    }
  }
}

// ---------------------------------------------------------------------------
// Setup / Uninstall — auto-register hooks in settings.json
// ---------------------------------------------------------------------------

export interface HookEntry {
  matcher?: string
  hooks: { type: string; command: string; async?: boolean; timeout?: number }[]
}

export function isMoshiHook(entry: HookEntry): boolean {
  return entry.hooks?.some((h) => h.command?.includes(HOOK_IDENTIFIER) || h.command?.includes("moshi-hooks")) ?? false
}

export async function loadSettings(settingsPath: string): Promise<Record<string, unknown>> {
  try {
    return await Bun.file(settingsPath).json()
  } catch {
    return {}
  }
}

async function saveSettings(settingsPath: string, settings: Record<string, unknown>): Promise<void> {
  await Bun.write(settingsPath, JSON.stringify(settings, null, 2) + "\n")
}

async function installHooksJson(
  path: string,
  events: Record<string, { matcher?: string }>,
  command: string,
  hookOpts: { async?: boolean; timeout?: number },
): Promise<void> {
  const settings = await loadSettings(path)
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>

  for (const [event, config] of Object.entries(events)) {
    const existing = hooks[event] ?? []
    const filtered = existing.filter((e) => !isMoshiHook(e))

    const entry: HookEntry = {
      hooks: [{ type: "command", command, ...hookOpts }],
    }
    if (config.matcher) entry.matcher = config.matcher

    filtered.push(entry)
    hooks[event] = filtered
  }

  settings.hooks = hooks
  const { mkdir } = await import("fs/promises")
  await mkdir(dirname(path), { recursive: true })
  await saveSettings(path, settings)
}

async function uninstallHooksJson(
  path: string,
  events: Record<string, { matcher?: string }>,
): Promise<void> {
  const settings = await loadSettings(path)
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>

  for (const event of Object.keys(events)) {
    const existing = hooks[event]
    if (!existing) continue
    const filtered = existing.filter((e) => !isMoshiHook(e))
    if (filtered.length > 0) {
      hooks[event] = filtered
    } else {
      delete hooks[event]
    }
  }

  settings.hooks = hooks
  await saveSettings(path, settings)
}

export async function setup(settingsPath?: string): Promise<void> {
  const resolved = settingsPath ?? DEFAULT_SETTINGS_PATH
  await installHooksJson(resolved, HOOK_EVENTS, CLAUDE_HOOK_COMMAND, { async: true })
  console.log(`moshi-hooks: registered in ${resolved}`)
}

export async function uninstall(settingsPath?: string): Promise<void> {
  const resolved = settingsPath ?? DEFAULT_SETTINGS_PATH
  await uninstallHooksJson(resolved, HOOK_EVENTS)
  console.log(`moshi-hooks: removed from ${resolved}`)
}

// ---------------------------------------------------------------------------
// Setup / Uninstall — Codex CLI
//
// Codex supports Claude-style hooks via ~/.codex/hooks.json, gated behind a
// `codex_hooks = true` flag under `[features]` in ~/.codex/config.toml.
// The hook payload schema matches Claude's closely enough that our main
// stdin handler processes both (dispatched by the --source flag).
// ---------------------------------------------------------------------------

export function setCodexHooksFeature(contents: string, enable: boolean): string {
  const lines = contents.split("\n")
  const featuresHeader = lines.findIndex((l) => l.trim() === "[features]")

  const findKeyIndex = (start: number, end: number): number => {
    for (let i = start + 1; i < end; i++) {
      if (lines[i]!.trim().startsWith("codex_hooks")) return i
    }
    return -1
  }

  const findSectionEnd = (start: number): number => {
    for (let i = start + 1; i < lines.length; i++) {
      const trimmed = lines[i]!.trim()
      if (trimmed.startsWith("[") && trimmed.endsWith("]")) return i
    }
    return lines.length
  }

  if (featuresHeader === -1) {
    if (!enable) return contents
    const out = [...lines]
    if (out.length > 0 && out[out.length - 1]?.trim() !== "") out.push("")
    out.push("[features]", "codex_hooks = true")
    return out.join("\n")
  }

  const sectionEnd = findSectionEnd(featuresHeader)
  const keyIndex = findKeyIndex(featuresHeader, sectionEnd)

  if (!enable) {
    if (keyIndex === -1) return contents
    lines.splice(keyIndex, 1)
    const newEnd = findSectionEnd(featuresHeader)
    const bodyIsEmpty = lines
      .slice(featuresHeader + 1, newEnd)
      .every((l) => !l.trim() || l.trim().startsWith("#"))
    if (bodyIsEmpty) {
      lines.splice(featuresHeader, newEnd - featuresHeader)
      if (featuresHeader < lines.length && lines[featuresHeader]!.trim() === "") {
        lines.splice(featuresHeader, 1)
      }
    }
    return lines.join("\n")
  }

  if (keyIndex === -1) {
    lines.splice(sectionEnd, 0, "codex_hooks = true")
  } else {
    lines[keyIndex] = "codex_hooks = true"
  }
  return lines.join("\n")
}

async function updateCodexConfig(configPath: string, enable: boolean): Promise<void> {
  let content = ""
  try {
    content = await Bun.file(configPath).text()
  } catch {
    if (!enable) return
  }

  // Strip any legacy `notify = [..., "moshi-hooks", ...]` line from older installs.
  content = content
    .split("\n")
    .filter((l) => !(l.includes("notify") && l.includes(HOOK_IDENTIFIER)))
    .join("\n")
  content = setCodexHooksFeature(content, enable)

  if (content && !content.endsWith("\n")) content += "\n"
  const { mkdir } = await import("fs/promises")
  await mkdir(dirname(configPath), { recursive: true })
  await Bun.write(configPath, content)
}

export async function setupCodex(hooksPath?: string, configPath?: string): Promise<void> {
  const hp = hooksPath ?? CODEX_HOOKS_PATH
  const cp = configPath ?? CODEX_CONFIG_PATH

  await installHooksJson(hp, CODEX_HOOK_EVENTS, CODEX_HOOK_COMMAND, { timeout: HOOK_TIMEOUT })
  await updateCodexConfig(cp, true)
  console.log(`moshi-hooks: codex hooks registered in ${hp}`)
}

export async function uninstallCodex(hooksPath?: string, configPath?: string): Promise<void> {
  const hp = hooksPath ?? CODEX_HOOKS_PATH
  const cp = configPath ?? CODEX_CONFIG_PATH

  try {
    await uninstallHooksJson(hp, CODEX_HOOK_EVENTS)
  } catch {
    // hooks.json missing is fine
  }
  await updateCodexConfig(cp, false)
  console.log(`moshi-hooks: codex hooks removed from ${hp}`)
}

// ---------------------------------------------------------------------------
// Setup / Uninstall — OpenCode (.opencode/plugins/moshi-hooks.ts)
//
// The OpenCode plugin runs in-process inside OpenCode and POSTs events
// directly to the Moshi API (rather than shelling out to `moshi-hooks` per
// event). The plugin body is shipped alongside this CLI at
// `templates/opencode-plugin.ts` and copied verbatim into the user's project.
//
// The plugin body is adapted from young5lee/opencode-moshi-live (MIT).
// ---------------------------------------------------------------------------

const OPENCODE_PLUGIN_TEMPLATE_REL = "../templates/opencode-plugin.ts"

async function loadOpenCodePluginTemplate(): Promise<string> {
  const url = new URL(OPENCODE_PLUGIN_TEMPLATE_REL, import.meta.url)
  return await Bun.file(url).text()
}

export async function setupOpenCode(dir?: string): Promise<void> {
  const resolved = dir ?? process.cwd()
  const pluginPath = resolve(resolved, ".opencode", "plugins", "moshi-hooks.ts")

  const template = await loadOpenCodePluginTemplate()
  const { mkdir } = await import("fs/promises")
  await mkdir(dirname(pluginPath), { recursive: true })
  await Bun.write(pluginPath, template)
  console.log(`moshi-hooks: opencode plugin written to ${pluginPath}`)
}

export async function uninstallOpenCode(dir?: string): Promise<void> {
  const resolved = dir ?? process.cwd()
  const pluginPath = resolve(resolved, ".opencode", "plugins", "moshi-hooks.ts")

  const { unlink } = await import("fs/promises")
  try {
    await unlink(pluginPath)
    console.log(`moshi-hooks: opencode plugin removed from ${pluginPath}`)
  } catch {
    console.log(`moshi-hooks: no opencode plugin found at ${pluginPath}`)
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function resolveDir(dir?: string, local?: boolean): string {
  if (!dir) return local ? DEFAULT_LOCAL_SETTINGS_PATH : DEFAULT_SETTINGS_PATH
  const filename = local ? "settings.local.json" : "settings.json"
  return resolve(resolve(dir), ".claude", filename)
}

function printUsage(): void {
  console.error("Usage:")
  console.error("  moshi-hooks setup [dir]          Register Claude Code hooks")
  console.error("  moshi-hooks setup --local [dir]  Register hooks in settings.local.json")
  console.error("  moshi-hooks setup --codex        Register Codex CLI hooks (~/.codex/hooks.json)")
  console.error("  moshi-hooks setup --opencode     Generate OpenCode plugin")
  console.error("  moshi-hooks uninstall [dir]      Remove Claude Code hooks")
  console.error("  moshi-hooks uninstall --local     Remove hooks from settings.local.json")
  console.error("  moshi-hooks uninstall --codex    Remove Codex CLI hooks")
  console.error("  moshi-hooks uninstall --opencode Remove OpenCode plugin")
  console.error("  moshi-hooks token [value]        Show or set API token")
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const isFlag = cmd?.startsWith("-") ?? false

  if (cmd === "setup") {
    const args = argv.slice(1)
    const local = args.includes("--local")
    const flag = args.find((a) => a !== "--local")
    if (flag === "--codex") return setupCodex()
    if (flag === "--opencode") return setupOpenCode(args[args.indexOf("--opencode") + 1])
    return setup(resolveDir(flag, local))
  }

  if (cmd === "uninstall") {
    const args = argv.slice(1)
    const local = args.includes("--local")
    const flag = args.find((a) => a !== "--local")
    if (flag === "--codex") return uninstallCodex()
    if (flag === "--opencode") return uninstallOpenCode(args[args.indexOf("--opencode") + 1])
    return uninstall(resolveDir(flag, local))
  }

  if (cmd === "token") {
    const value = argv[1]
    if (!value) {
      const token = await loadToken()
      console.log(token ?? `no token found (expected at ${TOKEN_PATH})`)
      return
    }
    const { mkdir } = await import("fs/promises")
    await mkdir(dirname(TOKEN_PATH), { recursive: true })
    await Bun.write(TOKEN_PATH, value + "\n")
    console.log(`moshi-hooks: token saved to ${TOKEN_PATH}`)
    return
  }

  // Unknown subcommand (and not a flag like --source) → print usage
  if (cmd && !isFlag) {
    console.error(`Unknown command: ${cmd}\n`)
    printUsage()
    process.exit(1)
  }

  // No subcommand and no stdin piped → print usage
  if (!cmd && process.stdin.isTTY) {
    printUsage()
    process.exit(0)
  }

  // Hook mode — reads JSON from stdin (invoked by Claude Code / Codex).
  // --source <agent> can be passed by the installer-generated hook command
  // so events are tagged correctly even if the agent doesn't set a source
  // field in its stdin payload.
  const sourceIdx = argv.indexOf("--source")
  const cliSource = sourceIdx >= 0 ? argv[sourceIdx + 1] : undefined

  const raw = await Bun.stdin.text()
  if (!raw.trim()) return

  let input: HookInput
  try {
    input = JSON.parse(raw)
  } catch {
    return
  }

  const { hook_event_name, session_id } = input
  if (!hook_event_name || !session_id) return

  const resolvedSource = cliSource ?? input.source
  const source = (resolvedSource === "codex" || resolvedSource === "opencode") ? resolvedSource : "claude" as const
  const projectName = input.cwd ? basename(input.cwd) : undefined

  // --- SessionStart: persist model + timestamp, don't POST ---
  if (hook_event_name === "SessionStart") {
    await writeState(session_id, {
      ...(input.model ? { model: input.model } : {}),
      sessionStartTime: Date.now() / 1000,
    })
    return
  }

  // --- UserPromptSubmit: skip entirely ---
  if (hook_event_name === "UserPromptSubmit") return

  // --- Session replay suppression (3s after SessionStart) ---
  const now = Date.now() / 1000
  {
    const state = await readState(session_id)
    if (state.sessionStartTime && now - state.sessionStartTime < REPLAY_SUPPRESS_S) {
      return // suppress replayed events right after session start
    }
  }

  // --- PreToolUse / PostToolUse: filter to interesting tools ---
  if (hook_event_name === "PreToolUse" || hook_event_name === "PostToolUse") {
    const toolName = input.tool_name
    if (!toolName || !INTERESTING_TOOLS.has(toolName)) return

    if (hook_event_name === "PreToolUse") {
      await writeState(session_id, { lastToolName: toolName })
    }

    const token = await loadToken()
    if (!token) return

    const state = await readState(session_id)
    const summary = summarizeToolInput(toolName, input.tool_input)

    const event: AgentEvent = {
      source,
      eventType: hook_event_name === "PreToolUse" ? "pre_tool" : "post_tool",
      sessionId: session_id,
      category: hook_event_name === "PreToolUse" ? "tool_running" : "tool_finished",
      title: `${hook_event_name === "PreToolUse" ? "Running" : "Finished"} ${toolName}`,
      message: summary,
      eventId: crypto.randomUUID(),
      projectName,
      modelName: formatModelName(state.model),
      toolName,
      contextPercent: await getContextPercent(input.transcript_path),
    }

    await sendEvent(token, event)
    return
  }

  // --- Notification: permission prompt or idle ---
  if (hook_event_name === "Notification") {
    const token = await loadToken()
    if (!token) return

    const state = await readState(session_id)

    const event: AgentEvent = {
      source,
      eventType: "notification",
      sessionId: session_id,
      category: "approval_required",
      title: input.title || "Permission Required",
      message: (input.message || "").slice(0, 256),
      eventId: crypto.randomUUID(),
      projectName,
      modelName: formatModelName(state.model),
      contextPercent: await getContextPercent(input.transcript_path),
    }

    await sendEvent(token, event)
    return
  }

  // --- Stop / SubagentStop (with 5s debounce) ---
  if (hook_event_name === "Stop" || hook_event_name === "SubagentStop") {
    const state = await readState(session_id)

    // Debounce: suppress if another Stop/SubagentStop fired within 5s
    if (state.lastStopTime && now - state.lastStopTime < STOP_COOLDOWN_S) {
      return
    }
    await writeState(session_id, { lastStopTime: now })

    const token = await loadToken()
    if (!token) return

    const lastMessage = input.last_assistant_message?.slice(0, 200)
      ?? await getLastAssistantMessage(input.transcript_path)

    const event: AgentEvent = {
      source,
      eventType: hook_event_name === "Stop" ? "stop" : "agent_turn_complete",
      sessionId: session_id,
      category: hook_event_name === "Stop" ? "task_complete" : "info",
      title: hook_event_name === "Stop" ? "Task Complete" : "Subagent Complete",
      message: lastMessage,
      eventId: crypto.randomUUID(),
      projectName,
      modelName: formatModelName(state.model),
      toolName: state.lastToolName,
      contextPercent: await getContextPercent(input.transcript_path),
    }

    await sendEvent(token, event)
    return
  }
}

main().catch(() => {
  // never throw — don't block Claude
})
