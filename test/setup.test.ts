import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "os"
import { join } from "path"
import { setup, uninstall, loadSettings, isMoshiHook, HOOK_EVENTS, type HookEntry } from "../src/index.ts"

const TMP = join(tmpdir(), `moshi-hooks-test-${process.pid}`)

function settingsFile(name: string): string {
  return join(TMP, `${name}.json`)
}

beforeEach(async () => {
  await Bun.write(join(TMP, ".keep"), "")
})

afterEach(async () => {
  const { rm } = await import("fs/promises")
  await rm(TMP, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// setup
// ---------------------------------------------------------------------------

describe("setup", () => {
  test("creates hooks from scratch when no settings file exists", async () => {
    const path = settingsFile("fresh")
    await setup(path)

    const settings = await loadSettings(path)
    const hooks = settings.hooks as Record<string, HookEntry[]>

    for (const event of Object.keys(HOOK_EVENTS)) {
      expect(hooks[event]).toBeDefined()
      expect(hooks[event]!.length).toBe(1)
      expect(hooks[event]![0]!.hooks[0]!.async).toBe(true)
      expect(hooks[event]![0]!.hooks[0]!.command).toContain("moshi-hooks")
    }
  })

  test("preserves existing non-moshi hooks", async () => {
    const path = settingsFile("preserve")
    const peonHook: HookEntry = {
      matcher: "",
      hooks: [{ type: "command", command: "/usr/local/bin/peon.sh", async: true }],
    }

    await Bun.write(path, JSON.stringify({
      hooks: { Stop: [peonHook], PreToolUse: [peonHook] },
    }))

    await setup(path)

    const settings = await loadSettings(path)
    const hooks = settings.hooks as Record<string, HookEntry[]>

    // Stop should have peon + moshi
    expect(hooks.Stop!.length).toBe(2)
    expect(hooks.Stop![0]!.hooks[0]!.command).toBe("/usr/local/bin/peon.sh")
    expect(hooks.Stop![1]!.hooks[0]!.command).toContain("moshi-hooks")

    // PreToolUse should also have both
    expect(hooks.PreToolUse!.length).toBe(2)
  })

  test("is idempotent — no duplicates on repeated runs", async () => {
    const path = settingsFile("idempotent")

    await setup(path)
    await setup(path)
    await setup(path)

    const settings = await loadSettings(path)
    const hooks = settings.hooks as Record<string, HookEntry[]>

    for (const event of Object.keys(HOOK_EVENTS)) {
      expect(hooks[event]!.length).toBe(1)
    }
  })

  test("preserves non-hooks settings", async () => {
    const path = settingsFile("other-settings")
    await Bun.write(path, JSON.stringify({
      env: { SOME_VAR: "1" },
      alwaysThinkingEnabled: true,
    }))

    await setup(path)

    const settings = await loadSettings(path)
    expect(settings.env).toEqual({ SOME_VAR: "1" })
    expect(settings.alwaysThinkingEnabled).toBe(true)
    expect(settings.hooks).toBeDefined()
  })

  test("sets matcher on Notification hook", async () => {
    const path = settingsFile("matcher")
    await setup(path)

    const settings = await loadSettings(path)
    const hooks = settings.hooks as Record<string, HookEntry[]>

    expect(hooks.Notification![0]!.matcher).toBe("permission_prompt|idle_prompt")
    // Other events should not have matcher
    expect(hooks.Stop![0]!.matcher).toBeUndefined()
    expect(hooks.SessionStart![0]!.matcher).toBeUndefined()
  })

  test("registers all expected events", async () => {
    const path = settingsFile("all-events")
    await setup(path)

    const settings = await loadSettings(path)
    const hooks = settings.hooks as Record<string, HookEntry[]>
    const registered = Object.keys(hooks)

    expect(registered).toContain("SessionStart")
    expect(registered).toContain("Stop")
    expect(registered).toContain("SubagentStop")
    expect(registered).toContain("Notification")
    expect(registered).toContain("PreToolUse")
    expect(registered).toContain("PostToolUse")
    expect(registered.length).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// uninstall
// ---------------------------------------------------------------------------

describe("uninstall", () => {
  test("removes all moshi hooks", async () => {
    const path = settingsFile("remove")
    await setup(path)
    await uninstall(path)

    const settings = await loadSettings(path)
    const hooks = settings.hooks as Record<string, HookEntry[]>

    // All events should be gone (they only had moshi hooks)
    for (const event of Object.keys(HOOK_EVENTS)) {
      expect(hooks[event]).toBeUndefined()
    }
  })

  test("preserves non-moshi hooks after uninstall", async () => {
    const path = settingsFile("preserve-uninstall")
    const peonHook: HookEntry = {
      matcher: "",
      hooks: [{ type: "command", command: "/usr/local/bin/peon.sh", async: true }],
    }

    await Bun.write(path, JSON.stringify({
      hooks: { Stop: [peonHook] },
    }))

    await setup(path)

    const before = await loadSettings(path)
    expect((before.hooks as Record<string, HookEntry[]>).Stop!.length).toBe(2)

    await uninstall(path)

    const after = await loadSettings(path)
    const hooks = after.hooks as Record<string, HookEntry[]>

    // Stop should still have peon
    expect(hooks.Stop!.length).toBe(1)
    expect(hooks.Stop![0]!.hooks[0]!.command).toBe("/usr/local/bin/peon.sh")

    // Others should be gone
    expect(hooks.SessionStart).toBeUndefined()
  })

  test("is safe to run when no hooks exist", async () => {
    const path = settingsFile("no-hooks")
    await Bun.write(path, JSON.stringify({ env: { FOO: "1" } }))

    await uninstall(path)

    const settings = await loadSettings(path)
    expect(settings.env).toEqual({ FOO: "1" })
  })

  test("is safe to run on missing file", async () => {
    const path = settingsFile("nonexistent")
    // should not throw
    await uninstall(path)

    const settings = await loadSettings(path)
    expect(settings.hooks).toEqual({})
  })

  test("preserves non-hooks settings after uninstall", async () => {
    const path = settingsFile("preserve-settings")
    await Bun.write(path, JSON.stringify({
      alwaysThinkingEnabled: true,
      env: { KEY: "val" },
    }))

    await setup(path)
    await uninstall(path)

    const settings = await loadSettings(path)
    expect(settings.alwaysThinkingEnabled).toBe(true)
    expect(settings.env).toEqual({ KEY: "val" })
  })
})

// ---------------------------------------------------------------------------
// isMoshiHook
// ---------------------------------------------------------------------------

describe("isMoshiHook", () => {
  test("identifies moshi-hooks entries", () => {
    expect(isMoshiHook({
      hooks: [{ type: "command", command: "bun /path/to/index.ts # moshi-hooks" }],
    })).toBe(true)
  })

  test("does not match unrelated hooks", () => {
    expect(isMoshiHook({
      hooks: [{ type: "command", command: "/usr/local/bin/peon.sh" }],
    })).toBe(false)
  })

  test("handles empty hooks array", () => {
    expect(isMoshiHook({ hooks: [] })).toBe(false)
  })
})
