# POC v0.0 — what shipped, what got punted

**Last updated:** 2026-05-21
**Status:** Compiles, boots, MCP server passes initialize+tools/list. End-to-end demo not yet run.

---

## What ships

A single Rust binary (`database-app`) that runs in **two modes** off the same source:

- **No args** → Tauri 2 UI. Three-region shell: connections+schema rail · editor+grid · bottom activity strip.
- **`--mcp`** → MCP stdio server (`rmcp` 1.7). No window. Six tools: `list_connections`, `connect`, `list_schemas`, `list_tables`, `describe_table`, `run_query`.

Both modes share `src-tauri/src/core.rs` — every tool handler (Tauri command or MCP method) calls the same async function. That's the whole architectural point of the POC: agent-initiated and user-initiated calls are indistinguishable from `core::*`'s point of view.

### Frontend (React + TS + Vite)

- `tokens.css` copied verbatim from `design/styles/tokens.css`; nothing else from `design/components/*.jsx` is in the runtime path (treated as visual reference per prompt).
- Components: `ConnectionRail`, `SchemaTree` (arrow-key navigable), `Workspace` (textarea editor + HTML table grid), `ActivityStrip`, two modals. Plain `<textarea>` — there's a `// Monaco seam` comment marking where the editor swap lands.

### Backend (Rust)

| Module             | Responsibility                                                       |
|--------------------|----------------------------------------------------------------------|
| `main.rs`          | `--mcp` argv dispatch                                                 |
| `lib.rs`           | Tauri builder, command registrations, `run()` and `run_mcp()`         |
| `types.rs`         | DTOs: `Connection`, `ColumnDescription`, `QueryResult`, `ActivityEvent` |
| `connections.rs`   | SQLite metadata persistence + `keyring` 3.x for passwords             |
| `pool.rs`          | `PoolRegistry` — name→`PgPool` cache with lazy ensure-on-demand        |
| `core.rs`          | The mode-agnostic functions; SELECT validator with the seam           |
| `activity.rs`      | `EmitFn` abstraction + UI socket listener + MCP socket writer         |
| `mcp.rs`           | rmcp server with `#[tool_router]` / `#[tool_handler]`                  |

### Activity wiring (the non-obvious bit)

- UI process: holds `AppHandle`. The UI emitter is a closure that calls `app.emit("activity", evt)` directly.
- MCP process: spawned by Claude Desktop. No `AppHandle`. The MCP emitter is a closure that writes a JSON line to a Unix domain socket at `<data_local_dir>/com.dbapp.poc/activity.sock`.
- UI process simultaneously runs a `UnixListener` on that socket. Any line it reads is re-emitted to the frontend.
- Net effect: agent-initiated and user-initiated calls hit the same `activity` event channel on the React side — the activity strip can't tell them apart except via the `source` field.

---

## Decisions surfaced during build

These are the answers to the prompt's "Surface, don't guess" list, plus the DESIGN_DOC open questions that the implementation forced a stance on:

1. **rmcp SDK over hand-roll.** rmcp 1.7.0 published; the `#[tool_router]` / `#[tool_handler]` macros + `transport::stdio()` give the protocol for free. Hand-rolling would have been ~250 lines of JSON-RPC framing for zero learning.
2. **Connection arg is explicit on every call.** No "current connection" coupling between UI focus and MCP tool semantics. MCP tools are pure functions of their arguments; the UI's notion of "active connection" is purely visual. Two windows or two MCP clients can act simultaneously without invisible cross-talk.
3. **Activity strip is a full-width bottom row above the status bar.** Matches the design's `bottom-strip` variant. Single-line, scrolling, mono. Inline overlays (the `inline` variant in the design) are richer but disproportionate for "a single-line log."
4. **Credential storage:** `keyring` 3.x with `apple-native` / `windows-native` / `sync-secret-service` features. No Stronghold, no plaintext. DESIGN_DOC's open question #2 is resolved in this direction for v0.1.
5. **MCP cross-process activity:** Unix domain socket. Works on macOS + Linux; Windows would need a named pipe (POC is macOS-first). Best-effort delivery — if the UI isn't running, MCP events drop silently rather than block.

---

## Things that aren't real yet (punted, per prompt's "out of scope")

- **Write-query gating.** SELECT-only validator at `core::validate_select_only`. The seam comment is explicit; v0.2 plugs the permission model in here.
- **Monaco editor.** `<textarea>` with a comment marker where the swap goes.
- **Virtualized grid.** Plain `<table>`. 1000-row cap in `core::run_query` with a `truncated` flag.
- **One-click MCP config writing.** Snippet is `Copy snippet` to clipboard; the user pastes into `~/Library/Application Support/Claude/claude_desktop_config.json` themselves.
- **Windows support.** Unix socket bridge means activity events from `--mcp` won't reach the UI on Windows. Connections + queries themselves still work cross-platform; only the live-event surface is degraded.
- **`Cmd+K` palette, light theme, CSV export, inline grid editing.** Explicit POC out-of-scope items.
- **Permission gates** (DESIGN_DOC open question #1): not relevant to v0.0 since writes are blocked at the validator. v0.2's permission model lives at `core::validate_select_only`.
- **Cursor / Claude Code installers** (DESIGN_DOC open question #3): snippet button serves Claude Desktop only. Other host configs are similar JSON but at different paths; v0.1 adds per-host snippets.
- **MCP failure modes** (DESIGN_DOC open question #5): only the obvious cases handled — socket connect is best-effort, stale socket file removed on UI start. Two simultaneous MCP clients on the same connection work because pools are per-process and Postgres handles concurrency. Crash isolation between the UI process and the MCP subprocess is automatic (separate processes), but the activity stream stops if the UI dies mid-session.

---

## Things future-Nathan should know before pushing to v0.1

1. **The same-process MCP server is an option I didn't take.** Right now MCP is a separate process spawned by Claude Desktop. The UI process and the MCP process each hold their own `PgPool` registry. That's fine for a POC but means a "connect from UI" doesn't open a pool the MCP subprocess can reuse, and vice versa. For v0.1's session-recording story (DESIGN_DOC v0.2 timeline), you almost certainly want a single shared state — likely: UI process keeps the canonical pools, MCP subprocess becomes a thin shim that forwards JSON-RPC over a local socket and lets the UI process execute. The current code is *one rename away from that* because the emitter abstraction already factors out the only piece that differs.

2. **`tauri::async_runtime::spawn`, not `tokio::spawn`, in the setup closure.** Cost me one boot panic. Tauri's main thread doesn't have a tokio reactor bound; you have to go through Tauri's wrapper. Anything you add to the setup closure should follow the same rule.

3. **The macOS-private-api feature on `tauri` is gated by a config flag.** Removed because we don't need it. If you re-enable for the v0.1 window chrome (no titlebar etc.), also flip `app.macOSPrivateApi: true` in `tauri.conf.json` — leave one without the other and the build script aborts.

4. **Icons are placeholder transparent PNGs.** `src-tauri/icons/*.png` are 32x32 transparent stubs. `tauri build` will not produce a usable app icon. Replace before v0.1 ships.

5. **The keyring service identifier is hard-coded to `"com.dbapp.poc"`.** Changing the bundle identifier without also changing the keyring service will orphan user credentials. Single constant in `connections.rs`; consider making it the same as the bundle ID via env.

6. **SQL "validator" is intentionally crude.** Strip comments, lowercase, check leading `select` / `with`, then reject WITH that contains any DML keyword as a substring. A pasted `WITH x AS (SELECT 'delete from foo' AS s) SELECT * FROM x` will trigger a false positive. For v0.2 write-gating, the right answer is the `pg_query` crate (libpg_query bindings) — actual SQL parsing. Don't grow the regex-style validator.

7. **`run_query` decodes a hand-picked set of Postgres types.** Anything outside `bool / int2 / int4 / int8 / float4 / float8 / text-family / uuid / timestamp(tz) / date / time / json(b) / bytea` falls back to `<TYPENAME>`. Arrays, enums, custom domains, and numeric (BigDecimal) are not handled. Probably good enough for the v0.1 demo, but the grid will look bad on any schema heavy in custom types.

8. **Test database for the demo:** `postgres -p 5432` with the standard Postgres image works. The DOD's step 4 ("a SELECT returns results") just needs `SELECT now()`. Verify keychain persistence by adding a connection, closing the app, opening Keychain Access → searching for `com.dbapp.poc`, and seeing the entry by connection name.

---

## How to run

```bash
pnpm install            # one-time
pnpm tauri dev          # UI mode
```

To attach Claude Desktop:

1. Click **MCP config** in the workspace tabbar.
2. **Copy snippet**.
3. Open `~/Library/Application Support/Claude/claude_desktop_config.json` and paste under `mcpServers`. The snippet hardcodes the absolute path to your dev binary, so if you move the source tree, re-copy it.
4. Restart Claude Desktop.
5. In Claude, ask: "use the database-app tools to list connections, then list_tables for one of them." You should see each call land in the bottom activity strip in the UI in real time.
