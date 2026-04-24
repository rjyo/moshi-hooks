# moshi-hooks

Hook adapter for Claude Code, Codex CLI, and OpenCode that bridges agent lifecycle events to the Moshi API, which fans out push notifications to update the Live Activity on your iPhone.

```
Claude Code → hooks (stdin) → moshi-hooks → Moshi API → APNs → Live Activity
Codex CLI   → hooks (stdin) → moshi-hooks → Moshi API → APNs → Live Activity
OpenCode    → plugin (spawn) → moshi-hooks → Moshi API → APNs → Live Activity
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

| OpenCode event | Mapped hook | eventType | category |
|---|---|---|---|
| `session.created` | `SessionStart` | — | — |
| `session.status` (idle) | `Stop` | `stop` | `task_complete` |
| `message.part.updated` (tool, running/pending) | `PreToolUse` | `pre_tool` | `tool_running` |
| `message.part.updated` (tool, completed/error) | `PostToolUse` | `post_tool` | `tool_finished` |
| `permission.asked` | `Notification` | `notification` | `approval_required` |

The plugin also tracks assistant message text from `message.part.updated` so that `Stop` events include the last assistant message as context.

## How it works

Each hook invocation is a separate process. Claude Code and Codex CLI pipe JSON to stdin (Codex hooks invoke `bunx moshi-hooks --source codex`), and OpenCode spawns `moshi-hooks` from a generated plugin file with `--source opencode`.

**Cross-event state** is persisted to `/tmp/moshi-hook-{session_id}.json` so that later events (like `Stop`) can include the model name and last tool from earlier events.

**Context window usage** is estimated by reading the last ~10KB of the transcript JSONL and parsing the most recent usage data.

## Testing

```bash
bun test
```

## Typecheck

```bash
bun typecheck
```
