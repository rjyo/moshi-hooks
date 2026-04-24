# moshi-hooks

Hook adapter for Claude Code, Codex CLI, and OpenCode that bridges agent lifecycle events to the Moshi API, which fans out push notifications to update the Live Activity on your iPhone.

```
Claude Code → hooks (stdin)  → moshi-hooks → Moshi API → APNs → Live Activity
Codex CLI   → hooks (stdin)  → moshi-hooks → Moshi API → APNs → Live Activity
OpenCode    → in-process plugin             → Moshi API → APNs → Live Activity
```

## Install

Requires [Bun](https://bun.sh). Zero runtime dependencies.

```bash
bun i -g moshi-hooks
```

Or run directly without installing:

```bash
bunx moshi-hooks setup
```

## Setup

First, set your Moshi API token:

```bash
moshi-hooks token <YOUR_TOKEN>
```

### Claude Code

```bash
moshi-hooks setup                 # user scope (~/.claude/settings.json)
moshi-hooks setup --local         # user scope (~/.claude/settings.local.json, not committed)
moshi-hooks setup .               # project scope (.claude/settings.json in cwd)
moshi-hooks setup --local .       # project scope (.claude/settings.local.json in cwd)
```

### Codex CLI

```bash
moshi-hooks setup --codex         # writes ~/.codex/hooks.json + enables codex_hooks feature flag
```

### OpenCode

```bash
moshi-hooks setup --opencode      # generates plugin at .opencode/plugins/moshi-hooks.ts
```

## Uninstall

```bash
moshi-hooks uninstall             # Claude Code (settings.json)
moshi-hooks uninstall --local     # Claude Code (settings.local.json)
moshi-hooks uninstall --codex     # Codex CLI
moshi-hooks uninstall --opencode  # OpenCode
```

All setup/uninstall commands are idempotent and preserve existing hooks from other tools.

## Event mapping

### Claude Code

| Hook Event | eventType | category | Sends to API? |
|---|---|---|---|
| `SessionStart` | — | — | No (persists model to state file) |
| `Stop` | `stop` | `task_complete` | Yes (visible push) |
| `SubagentStop` | `agent_turn_complete` | `info` | Yes (visible push) |
| `Notification` | `notification` | `approval_required` | Yes (visible push) |
| `PreToolUse` | `pre_tool` | `tool_running` | Yes, filtered (silent) |
| `PostToolUse` | `post_tool` | `tool_finished` | Yes, filtered (silent) |
| `UserPromptSubmit` | — | — | No (skipped) |

Tool events are filtered to only fire for: `Bash`, `Edit`, `Write`, `WebFetch`, `WebSearch`, `Task`.

### Codex CLI

| Hook Event | eventType | category | Sends to API? |
|---|---|---|---|
| `SessionStart` (matcher `startup\|resume`) | — | — | No (persists model to state file) |
| `Stop` | `stop` | `task_complete` | Yes (visible push) |
| `PreToolUse` | `pre_tool` | `tool_running` | Yes, filtered (silent) |
| `PostToolUse` | `post_tool` | `tool_finished` | Yes, filtered (silent) |

Registered via `~/.codex/hooks.json` (same shape as Claude's `settings.json`) and enabled by setting `codex_hooks = true` under `[features]` in `~/.codex/config.toml`.

### OpenCode

| OpenCode event | Notification title | eventType | category |
|---|---|---|---|
| `tool.execute.before` (bash/edit/write/read/glob/grep/task/apply_patch/webfetch/websearch) | `Running <Tool>` | `pre_tool` | `tool_running` |
| `tool.execute.after` (same set) | `Finished <Tool>` | `post_tool` | `tool_finished` |
| `tool.execute.before` (question) | `Question` | `notification` | `approval_required` |
| `permission.asked` / `permission.updated` | `Permission Required` | `notification` | `approval_required` |
| `message.part.updated` (text, question-shaped) | `Waiting for Reply` | `notification` | `approval_required` |
| `message.part.updated` (step-start) | `Thinking` | `notification` | `info` |
| `message.part.updated` (reasoning) | `Reasoning` | `notification` | `info` |
| `message.part.updated` (step-finish) | `Step Complete` | `notification` | `info` |
| `message.part.updated` (subtask) | `Delegating` | `notification` | `info` |
| `session.status` (retry) | `Retrying` | `notification` | `error` |
| `session.error` | `Session Error` | `notification` | `error` |
| `session.idle` (when not awaiting input / has activity) | `Task Complete` | `stop` | `task_complete` |

The plugin suppresses `session.idle` completions while awaiting a permission / question / assistant reply, deduplicates repeated permission and reasoning events with short TTLs, and skips child (subagent) sessions to avoid duplicate noise.

## How it works

Claude Code and Codex CLI pipe JSON to stdin for each hook event — a fresh `moshi-hooks` process normalizes the payload and POSTs to the Moshi API. OpenCode is different: its generated plugin runs **in-process** inside OpenCode and POSTs directly to the Moshi API, so it can maintain wait-state, dedup, and child-session info across events without paying a process-spawn tax per event.

**Cross-event state** (Claude / Codex) is persisted to `/tmp/moshi-hook-{session_id}.json` so that later events (like `Stop`) can include the model name and last tool from earlier events. The OpenCode plugin keeps equivalent state in memory for its session lifetime.

**Context window usage** is estimated by reading the last ~10KB of the Claude transcript JSONL and parsing the most recent usage data.

## Credits

The OpenCode plugin (`templates/opencode-plugin.ts`) is adapted from [opencode-moshi-live](https://github.com/young5lee/opencode-moshi-live) by [young5lee](https://github.com/young5lee), MIT licensed. It contributed the in-process architecture, wait-state tracking, TTL deduplication, child-session filtering, assistant-question inference, tool-argument formatting, and the rich progress event mapping (Thinking / Reasoning / Step Complete / Delegating / Retrying).

## Testing

```bash
bun test
```

## Typecheck

```bash
bun typecheck
```
