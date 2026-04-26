import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { tmpdir } from "os"
import { join, dirname } from "path"
import { setup, uninstall, loadSettings, isMoshiHook, HOOK_EVENTS, CODEX_HOOK_EVENTS, setupCodex, uninstallCodex, setupOpenCode, uninstallOpenCode, setCodexHooksFeature, type HookEntry } from "../src/index.ts"

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

// ---------------------------------------------------------------------------
// setup --local (settings.local.json)
// ---------------------------------------------------------------------------

describe("setup --local", () => {
  test("writes hooks to settings.local.json path", async () => {
    const path = join(TMP, "local.json")
    await setup(path)

    const settings = await loadSettings(path)
    const hooks = settings.hooks as Record<string, HookEntry[]>

    for (const event of Object.keys(HOOK_EVENTS)) {
      expect(hooks[event]).toBeDefined()
      expect(hooks[event]![0]!.hooks[0]!.command).toContain("moshi-hooks")
    }
  })

  test("uninstall removes hooks from local settings", async () => {
    const path = join(TMP, "local-remove.json")
    await setup(path)
    await uninstall(path)

    const settings = await loadSettings(path)
    const hooks = settings.hooks as Record<string, HookEntry[]>
    for (const event of Object.keys(HOOK_EVENTS)) {
      expect(hooks[event]).toBeUndefined()
    }
  })
})

// ---------------------------------------------------------------------------
// setupCodex / uninstallCodex
// ---------------------------------------------------------------------------

describe("setupCodex", () => {
  test("creates hooks.json and config.toml when neither exist", async () => {
    const hooks = join(TMP, "codex", "hooks.json")
    const config = join(TMP, "codex", "config.toml")
    await setupCodex(hooks, config)

    const hooksContent = JSON.parse(await Bun.file(hooks).text()) as { hooks: Record<string, HookEntry[]> }
    for (const event of Object.keys(CODEX_HOOK_EVENTS)) {
      expect(hooksContent.hooks[event]).toBeDefined()
      expect(hooksContent.hooks[event]![0]!.hooks[0]!.command).toBe("bunx --silent moshi-hooks --source codex")
      expect(hooksContent.hooks[event]![0]!.hooks[0]!.timeout).toBe(45)
    }
    expect(hooksContent.hooks.SessionStart![0]!.matcher).toBe("startup|resume")

    const configContent = await Bun.file(config).text()
    expect(configContent).toContain("[features]")
    expect(configContent).toContain("codex_hooks = true")
  })

  test("preserves unrelated config.toml content and hooks", async () => {
    const hooks = join(TMP, "codex2", "hooks.json")
    const config = join(TMP, "codex2", "config.toml")
    const { mkdir } = await import("fs/promises")
    await mkdir(dirname(config), { recursive: true })
    await Bun.write(config, 'model = "o3"\n[features]\nother = true\n')
    await Bun.write(hooks, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/peon.sh" }] }] },
    }))

    await setupCodex(hooks, config)

    const configContent = await Bun.file(config).text()
    expect(configContent).toContain('model = "o3"')
    expect(configContent).toContain("other = true")
    expect(configContent).toContain("codex_hooks = true")

    const hooksContent = JSON.parse(await Bun.file(hooks).text()) as { hooks: Record<string, HookEntry[]> }
    expect(hooksContent.hooks.Stop!.length).toBe(2)
    expect(hooksContent.hooks.Stop![0]!.hooks[0]!.command).toBe("/usr/local/bin/peon.sh")
  })

  test("is idempotent — no duplicates", async () => {
    const hooks = join(TMP, "codex3", "hooks.json")
    const config = join(TMP, "codex3", "config.toml")
    await setupCodex(hooks, config)
    await setupCodex(hooks, config)
    await setupCodex(hooks, config)

    const hooksContent = JSON.parse(await Bun.file(hooks).text()) as { hooks: Record<string, HookEntry[]> }
    for (const event of Object.keys(CODEX_HOOK_EVENTS)) {
      expect(hooksContent.hooks[event]!.length).toBe(1)
    }

    const configContent = await Bun.file(config).text()
    const flagMatches = configContent.match(/^codex_hooks\s*=/gm)
    expect(flagMatches?.length).toBe(1)
  })

  test("strips legacy notify line from old installs", async () => {
    const hooks = join(TMP, "codex-legacy", "hooks.json")
    const config = join(TMP, "codex-legacy", "config.toml")
    const { mkdir } = await import("fs/promises")
    await mkdir(dirname(config), { recursive: true })
    await Bun.write(config, 'model = "o3"\nnotify = ["bunx", "moshi-hooks", "codex-notify"]\n')

    await setupCodex(hooks, config)

    const configContent = await Bun.file(config).text()
    expect(configContent).not.toContain("codex-notify")
    expect(configContent).toContain('model = "o3"')
    expect(configContent).toContain("codex_hooks = true")
  })
})

describe("uninstallCodex", () => {
  test("removes moshi hooks and feature flag", async () => {
    const hooks = join(TMP, "codex4", "hooks.json")
    const config = join(TMP, "codex4", "config.toml")
    await setupCodex(hooks, config)
    await uninstallCodex(hooks, config)

    const hooksContent = JSON.parse(await Bun.file(hooks).text()) as { hooks: Record<string, HookEntry[]> }
    for (const event of Object.keys(CODEX_HOOK_EVENTS)) {
      expect(hooksContent.hooks[event]).toBeUndefined()
    }

    const configContent = await Bun.file(config).text()
    expect(configContent).not.toContain("codex_hooks")
  })

  test("preserves non-moshi hooks after uninstall", async () => {
    const hooks = join(TMP, "codex5", "hooks.json")
    const config = join(TMP, "codex5", "config.toml")
    const { mkdir } = await import("fs/promises")
    await mkdir(dirname(hooks), { recursive: true })
    await Bun.write(hooks, JSON.stringify({
      hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/local/bin/peon.sh" }] }] },
    }))

    await setupCodex(hooks, config)
    await uninstallCodex(hooks, config)

    const hooksContent = JSON.parse(await Bun.file(hooks).text()) as { hooks: Record<string, HookEntry[]> }
    expect(hooksContent.hooks.Stop!.length).toBe(1)
    expect(hooksContent.hooks.Stop![0]!.hooks[0]!.command).toBe("/usr/local/bin/peon.sh")
  })

  test("is safe when files do not exist", async () => {
    const hooks = join(TMP, "codex-missing", "hooks.json")
    const config = join(TMP, "codex-missing", "config.toml")
    // should not throw
    await uninstallCodex(hooks, config)
  })
})

describe("setCodexHooksFeature", () => {
  test("creates [features] section when missing", () => {
    expect(setCodexHooksFeature("", true)).toContain("[features]\ncodex_hooks = true")
    expect(setCodexHooksFeature('model = "o3"\n', true)).toContain("[features]\ncodex_hooks = true")
  })

  test("adds key under existing [features] section", () => {
    const result = setCodexHooksFeature("[features]\nother = true\n", true)
    expect(result).toContain("codex_hooks = true")
    expect(result).toContain("other = true")
  })

  test("is idempotent", () => {
    const once = setCodexHooksFeature("", true)
    const twice = setCodexHooksFeature(once, true)
    expect(twice).toBe(once)
  })

  test("removes key and cleans up empty [features] section", () => {
    const withFlag = setCodexHooksFeature("", true)
    const without = setCodexHooksFeature(withFlag, false)
    expect(without).not.toContain("codex_hooks")
    expect(without).not.toContain("[features]")
  })

  test("preserves [features] section when other keys remain", () => {
    const result = setCodexHooksFeature("[features]\nother = true\ncodex_hooks = true\n", false)
    expect(result).not.toContain("codex_hooks")
    expect(result).toContain("[features]")
    expect(result).toContain("other = true")
  })
})

// ---------------------------------------------------------------------------
// setupOpenCode / uninstallOpenCode
// ---------------------------------------------------------------------------

describe("setupOpenCode", () => {
  test("generates plugin file from template", async () => {
    await setupOpenCode(TMP)

    const pluginPath = join(TMP, ".opencode", "plugins", "moshi-hooks.ts")
    const content = await Bun.file(pluginPath).text()
    // Plugin posts directly to the Moshi API, no stdin hop.
    expect(content).toContain("api.getmoshi.app")
    expect(content).toContain(`"opencode"`)
    // Rich event coverage ported from opencode-moshi-live.
    expect(content).toContain("permission.asked")
    expect(content).toContain("permission.replied")
    expect(content).toContain("session.idle")
    expect(content).toContain("session.error")
    expect(content).toContain("tool.execute.before")
    expect(content).toContain("tool.execute.after")
    expect(content).toContain("Waiting for Reply")
    expect(content).toContain("Step Complete")
    // Credit preserved in generated plugin header.
    expect(content).toContain("opencode-moshi-live")
  })

  test("is idempotent — overwrites with same content", async () => {
    await setupOpenCode(TMP)
    await setupOpenCode(TMP)

    const pluginPath = join(TMP, ".opencode", "plugins", "moshi-hooks.ts")
    const content = await Bun.file(pluginPath).text()
    expect(content).toContain("moshi-hooks")
  })
})

describe("uninstallOpenCode", () => {
  test("removes plugin file", async () => {
    await setupOpenCode(TMP)
    const pluginPath = join(TMP, ".opencode", "plugins", "moshi-hooks.ts")
    expect(await Bun.file(pluginPath).exists()).toBe(true)

    await uninstallOpenCode(TMP)
    expect(await Bun.file(pluginPath).exists()).toBe(false)
  })

  test("is safe when plugin does not exist", async () => {
    // should not throw
    await uninstallOpenCode(join(TMP, "nonexistent"))
  })
})
