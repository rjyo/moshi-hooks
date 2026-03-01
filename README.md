# moshi-hooks

Claude Code hook adapter that bridges agent lifecycle events to the Moshi API, which fans out push notifications to update the Live Activity on your iPhone.

```
Claude Code → hooks (stdin) → moshi-hooks → Moshi API → APNs → Live Activity
```

## Install

Requires [Bun](https://bun.sh) (Node.js support planned). Zero runtime dependencies.

```bash
bun i -g moshi-hooks
```

Or run directly without installing:

```bash
bunx moshi-hooks setup
```

## Setup

```bash
moshi-hooks token <YOUR_TOKEN>
moshi-hooks setup              # user scope (~/.claude/settings.json)
moshi-hooks setup .            # project scope (.claude/settings.json in cwd)
moshi-hooks setup /path/to/dir # project scope (absolute path)
```

Project-scoped hooks can be committed to the repo and shared with your team. Both scopes are idempotent — safe to run multiple times. Existing hooks from other tools are preserved.

To remove:

```bash
moshi-hooks uninstall              # user scope
moshi-hooks uninstall .            # project scope
moshi-hooks uninstall /path/to/dir # project scope
```

All hooks run with `async: true` so they never block Claude.

## Event mapping

| Hook Event | eventType | category | Sends to API? |
|---|---|---|---|
| `SessionStart` | — | — | No (persists model to state file) |
| `Stop` | `stop` | `task_complete` | Yes (visible push) |
| `SubagentStop` | `agent_turn_complete` | `info` | Yes (visible push) |
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
