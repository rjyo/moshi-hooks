#!/usr/bin/env bun

// moshi-hooks — Claude Code hook adapter
// Reads hook events from stdin, normalizes them, and POSTs to the Moshi API.
// Zero runtime dependencies — uses Bun builtins only.

import { homedir } from "os"
import { basename, resolve } from "path"

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
  source: "claude"
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
const HOOK_COMMAND = `bun ${resolve(import.meta.dirname, "index.ts")}`
const HOOK_IDENTIFIER = "moshi-hooks"

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

function resolveSettingsPath(project: boolean, explicit?: string): string {
  if (explicit) return explicit
  return project ? resolve(process.cwd(), ".claude", "settings.json") : DEFAULT_SETTINGS_PATH
}

export async function setup(settingsPath?: string, { project = false }: { project?: boolean } = {}): Promise<void> {
  const resolved = resolveSettingsPath(project, settingsPath)
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

export async function uninstall(settingsPath?: string, { project = false }: { project?: boolean } = {}): Promise<void> {
  const resolved = resolveSettingsPath(project, settingsPath)
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const subcommand = process.argv[2]
  const project = process.argv.includes("--project")
  if (subcommand === "setup") return setup(undefined, { project })
  if (subcommand === "uninstall") return uninstall(undefined, { project })

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
      source: "claude",
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
      source: "claude",
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
      source: "claude",
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
