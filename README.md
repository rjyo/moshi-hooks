# moshi-hooks

Claude Code hook adapter that bridges agent lifecycle events to the Moshi API, which fans out push notifications to update the Live Activity on your iPhone.

```
Claude Code → hooks (stdin) → moshi-hooks → Moshi API → APNs → Live Activity
```

## Install

Requires [Bun](https://bun.sh). Zero runtime dependencies.

```bash
git clone <repo-url> ~/projects/moshi-hooks
cd ~/projects/moshi-hooks
bun install
```

## Setup

### 1. API token

```bash
mkdir -p ~/.config/moshi
echo "YOUR_API_TOKEN" > ~/.config/moshi/token
```

### 2. Register hooks

```bash
bun run setup
```

This auto-registers all hooks in `~/.claude/settings.json`. It's idempotent — safe to run multiple times. Existing hooks from other tools (e.g. peon-ping) are preserved.

To remove:

```bash
bun run uninstall
```

All hooks run with `async: true` so they never block Claude.

## Event mapping

| Hook Event | eventType | category | Sends to API? |
|---|---|---|---|
| `SessionStart` | — | — | No (persists model to state file) |
| `Stop` | `stop` | `task_complete` | Yes (visible push) |
| `SubagentStop` | `agent_turn_complete` | `task_complete` | Yes (visible push) |
| `Notification` | `notification` | `approval_required` | Yes (visible push) |
| `PreToolUse` | `pre_tool` | `tool_running` | Yes, filtered (silent) |
| `PostToolUse` | `post_tool` | `tool_finished` | Yes, filtered (silent) |
| `UserPromptSubmit` | — | — | No (skipped) |

Tool events are filtered to only fire for: `Bash`, `Edit`, `Write`, `WebFetch`, `WebSearch`, `Task`. Read-only tools (`Read`, `Glob`, `Grep`) are skipped.

## How it works

Each hook invocation is a separate process. Claude Code pipes JSON to stdin, the adapter reads it, maps the event, and POSTs to the Moshi API.

**Cross-event state** is persisted to `/tmp/moshi-hook-{session_id}.json` so that later events (like `Stop`) can include the model name and last tool from earlier events (like `SessionStart` and `PreToolUse`).

**Context window usage** is estimated by reading the last ~10KB of the transcript JSONL and parsing the most recent usage data.

## Testing

```bash
bun test
```

## Typecheck

```bash
bun typecheck
```
