1. use bun, not node
2. `bun typecheck` and `bun test` to verify edits
3. zero runtime dependencies — Bun builtins only (fetch, crypto, Bun.file, etc.)
4. single-file CLI in `src/index.ts` — keep it under ~300 lines
5. all setup/uninstall logic must accept a `settingsPath` override for testability
6. hooks must never block Claude — all errors caught and swallowed silently during hook execution
7. kebab file names for any new files
