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
const DEFAULT_SETTINGS_PATH = `${homedir()}/.claude/settings.json`
const DEFAULT_LOCAL_SETTINGS_PATH = `${homedir()}/.claude/settings.local.json`
const HOOK_COMMAND = "bunx moshi-hooks"
const HOOK_IDENTIFIER = "moshi-hooks"
const CODEX_CONFIG_PATH = `${homedir()}/.codex/config.toml`
const CODEX_NOTIFY_VALUE = '["bunx", "moshi-hooks", "codex-notify"]'

export const HOOK_EVENTS: Record<string, { matcher?: string }> = {
  SessionStart: {},
  Stop: {},
  SubagentStop: {},
  Notification: { matcher: "permission_prompt|idle_prompt" },
  PreToolUse: {},
  PostToolUse: {},
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

export async function setup(settingsPath?: string): Promise<void> {
  const resolved = settingsPath ?? DEFAULT_SETTINGS_PATH
  const settings = await loadSettings(resolved)
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>

  for (const [event, config] of Object.entries(HOOK_EVENTS)) {
    const existing = hooks[event] ?? []
    const filtered = existing.filter((e) => !isMoshiHook(e))

    const entry: HookEntry = {
      hooks: [
        {
          type: "command",
          command: `${HOOK_COMMAND} # ${HOOK_IDENTIFIER}`,
          async: true,
        },
      ],
    }
    if (config.matcher) entry.matcher = config.matcher

    filtered.push(entry)
    hooks[event] = filtered
  }

  settings.hooks = hooks
  await saveSettings(resolved, settings)
  console.log(`moshi-hooks: registered in ${resolved}`)
}

export async function uninstall(settingsPath?: string): Promise<void> {
  const resolved = settingsPath ?? DEFAULT_SETTINGS_PATH
  const settings = await loadSettings(resolved)
  const hooks = (settings.hooks ?? {}) as Record<string, HookEntry[]>

  for (const event of Object.keys(HOOK_EVENTS)) {
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
  await saveSettings(resolved, settings)
  console.log(`moshi-hooks: removed from ${resolved}`)
}

// ---------------------------------------------------------------------------
// Setup / Uninstall — Codex CLI (~/.codex/config.toml)
// ---------------------------------------------------------------------------

export async function setupCodex(configPath?: string): Promise<void> {
  const resolved = configPath ?? CODEX_CONFIG_PATH
  let content = ""
  try {
    content = await Bun.file(resolved).text()
  } catch {
    // file doesn't exist yet
  }

  // Remove any existing notify line referencing moshi-hooks
  const lines = content.split("\n").filter((l) => !(l.includes("notify") && l.includes(HOOK_IDENTIFIER)))
  // Append our notify line
  lines.push(`notify = ${CODEX_NOTIFY_VALUE}`)
  // Clean up extra blank lines at the end
  const result = lines.filter((l, i) => i < lines.length - 1 || l.trim() !== "").join("\n") + "\n"

  const { mkdir } = await import("fs/promises")
  await mkdir(dirname(resolved), { recursive: true })
  await Bun.write(resolved, result)
  console.log(`moshi-hooks: codex notify registered in ${resolved}`)
}

export async function uninstallCodex(configPath?: string): Promise<void> {
  const resolved = configPath ?? CODEX_CONFIG_PATH
  let content = ""
  try {
    content = await Bun.file(resolved).text()
  } catch {
    console.log(`moshi-hooks: no codex config found at ${resolved}`)
    return
  }

  const lines = content.split("\n").filter((l) => !(l.includes("notify") && l.includes(HOOK_IDENTIFIER)))
  await Bun.write(resolved, lines.join("\n"))
  console.log(`moshi-hooks: codex notify removed from ${resolved}`)
}

// ---------------------------------------------------------------------------
// Setup / Uninstall — OpenCode (.opencode/plugins/moshi-hooks.ts)
// ---------------------------------------------------------------------------

const OPENCODE_PLUGIN_TEMPLATE = `// Auto-generated by moshi-hooks — do not edit
import { spawn } from "bun"

interface ToolEvent {
  tool?: { name?: string; input?: Record<string, unknown> }
  session?: { id?: string; cwd?: string }
  [key: string]: unknown
}

function sendToMoshi(hookInput: Record<string, unknown>) {
  const proc = spawn(["bunx", "moshi-hooks"], { stdin: "pipe" })
  proc.stdin.write(JSON.stringify(hookInput))
  proc.stdin.end()
}

export default {
  name: "moshi-hooks",
  subscribe: ["tool.execute.before", "tool.execute.after"],
  onEvent(eventName: string, data: ToolEvent) {
    const sessionId = data.session?.id ?? "opencode"
    const cwd = data.session?.cwd
    const toolName = data.tool?.name

    if (eventName === "tool.execute.before") {
      sendToMoshi({
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        source: "opencode",
        tool_name: toolName,
        tool_input: data.tool?.input,
        cwd,
      })
    } else if (eventName === "tool.execute.after") {
      sendToMoshi({
        hook_event_name: "PostToolUse",
        session_id: sessionId,
        source: "opencode",
        tool_name: toolName,
        tool_input: data.tool?.input,
        cwd,
      })
    }
  },
}
`

export async function setupOpenCode(dir?: string): Promise<void> {
  const resolved = dir ?? process.cwd()
  const pluginPath = resolve(resolved, ".opencode", "plugins", "moshi-hooks.ts")

  const { mkdir } = await import("fs/promises")
  await mkdir(dirname(pluginPath), { recursive: true })
  await Bun.write(pluginPath, OPENCODE_PLUGIN_TEMPLATE)
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
// Codex notify handler
// ---------------------------------------------------------------------------

async function handleCodexNotify(jsonArg: string): Promise<void> {
  const token = await loadToken()
  if (!token) return

  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(jsonArg)
  } catch {
    return
  }

  const sessionId = String(payload.session_id ?? payload.sessionId ?? crypto.randomUUID())
  const message = String(payload.message ?? payload.result ?? "Task complete")
  const projectName = payload.cwd ? basename(String(payload.cwd)) : undefined

  const event: AgentEvent = {
    source: "codex",
    eventType: "stop",
    sessionId,
    category: "task_complete",
    title: "Task Complete",
    message: message.slice(0, 256),
    eventId: crypto.randomUUID(),
    projectName,
  }

  await sendEvent(token, event)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function resolveDir(dir?: string, local?: boolean): string {
  if (!dir) return local ? DEFAULT_LOCAL_SETTINGS_PATH : DEFAULT_SETTINGS_PATH
  const filename = local ? "settings.local.json" : "settings.json"
  return resolve(resolve(dir), ".claude", filename)
}

async function main() {
  const subcommand = process.argv[2]

  if (subcommand === "setup") {
    const args = process.argv.slice(3)
    const local = args.includes("--local")
    const flag = args.find((a) => a !== "--local")
    if (flag === "--codex") return setupCodex(args[args.indexOf("--codex") + 1])
    if (flag === "--opencode") return setupOpenCode(args[args.indexOf("--opencode") + 1])
    return setup(resolveDir(flag, local))
  }
  if (subcommand === "uninstall") {
    const args = process.argv.slice(3)
    const local = args.includes("--local")
    const flag = args.find((a) => a !== "--local")
    if (flag === "--codex") return uninstallCodex(args[args.indexOf("--codex") + 1])
    if (flag === "--opencode") return uninstallOpenCode(args[args.indexOf("--opencode") + 1])
    return uninstall(resolveDir(flag, local))
  }

  if (subcommand === "codex-notify") {
    const jsonArg = process.argv[3]
    if (jsonArg) return handleCodexNotify(jsonArg)
    return
  }

  if (subcommand === "token") {
    const value = process.argv[3]
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

  // Not hook mode — print usage
  if (subcommand || process.stdin.isTTY) {
    if (subcommand) console.error(`Unknown command: ${subcommand}\n`)
    console.error("Usage:")
    console.error("  moshi-hooks setup [dir]          Register Claude Code hooks")
    console.error("  moshi-hooks setup --local [dir]  Register hooks in settings.local.json")
    console.error("  moshi-hooks setup --codex        Register Codex CLI notify")
    console.error("  moshi-hooks setup --opencode     Generate OpenCode plugin")
    console.error("  moshi-hooks uninstall [dir]      Remove Claude Code hooks")
    console.error("  moshi-hooks uninstall --local     Remove hooks from settings.local.json")
    console.error("  moshi-hooks uninstall --codex    Remove Codex CLI notify")
    console.error("  moshi-hooks uninstall --opencode Remove OpenCode plugin")
    console.error("  moshi-hooks token [value]        Show or set API token")
    process.exit(subcommand ? 1 : 0)
  }

  // Hook mode — reads JSON from stdin (invoked by Claude Code)
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

  const source = (input.source === "codex" || input.source === "opencode") ? input.source : "claude" as const
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

    const lastMessage = await getLastAssistantMessage(input.transcript_path)

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
