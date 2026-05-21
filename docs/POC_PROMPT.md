# Goal Prompt — POC v0.0

Read `docs/DESIGN_DOC.md` first — framing is load-bearing. One line: a native Postgres workbench where an external AI agent is the primary user, the human supervises, and **the viewer itself is an MCP server** agents connect to. This is the POC, not v0.1 — smallest slice that proves the primitive.

## Goal

A developer can:

1. Create/save a Postgres connection (credentials in OS keychain).
2. Connect to it.
3. Browse the schema (schemas → tables → columns) in a left tree.
4. Write a query and see results in a grid.
5. Point Claude Desktop at the running app via MCP and have the agent do 1–4 by calling tools the app exposes. The UI updates in real time as the agent works.

Point 5 is the whole reason this is a POC and not a weekend project.

## Stack

- **Tauri 2**, Rust backend, React + TypeScript frontend.
- Postgres via `sqlx`. Credentials via `keyring` crate — no Stronghold, no plaintext.
- **MCP server:** in-process inside the Tauri binary, stdio transport. Use a Rust MCP SDK if one is mature; else hand-roll minimal JSON-RPC-over-stdio.
- Session storage in SQLite alongside the app.
- Editor: plain `<textarea>` is fine; leave a Monaco seam. Grid: plain HTML table; virtualize later.
- Port `design/styles/tokens.css` verbatim. Treat `design/components/*.jsx` as visual reference, not production code.

## MCP tools to expose

- `list_connections` (no secrets)
- `connect(name)`
- `list_schemas()`, `list_tables(schema)`, `describe_table(schema, table)`
- `run_query(sql)` — **SELECT/WITH-SELECT only.** Reject anything else; leave a clearly marked seam for write-gating (v0.2).

Every tool call emits a Tauri event so the React side renders it in an agent-activity strip. A single-line log is enough — the point is wiring, not polish.

## Out of scope

Everything beyond v0.1, plus: write-query gating, light theme, Cmd+K palette, virtualized grid, inline editing, CSV export, one-click config writing. POC ships a "copy MCP config snippet" button instead of writing `claude_desktop_config.json` directly.

## Definition of done

On a fresh checkout:

1. `pnpm tauri dev` launches the app.
2. User adds a connection, it persists across restarts, connects. Credentials verifiable in Keychain Access.
3. Schema tree populates from a real DB, arrow keys move selection.
4. A `SELECT` returns results in the grid.
5. Claude Desktop, configured via the app's snippet, calls `list_tables` and `run_query` against the active connection and the UI shows each call as it happens. Reopen app, reconnect, still works.

## Implementation order

1. Tauri init, project structure, tokens.css ported, empty shell rendering three regions (schema rail / editor+grid / agent activity strip).
2. Connection model: Rust struct, persistence to SQLite, secrets to keyring. UI to add/list/delete. No Postgres traffic yet.
3. Real connection + schema: `sqlx` pool keyed by connection id. Tauri commands for connect and introspection. Schema tree.
4. Query path: SELECT-only validator, editor + grid wired up.
5. **MCP server on the same Rust state.** Stdio transport. Handlers call the *same* functions the Tauri commands call — that's the point. Events fire from shared functions so UI- and agent-initiated activity render identically.
6. "Copy MCP config" button. Connect Claude Desktop. Demo end-to-end.

The instinct will be to do MCP last as an add-on. Resist — step 5 is cheap on shared state, expensive to retrofit.

## Surface, don't guess

Stop and ask if any of these come up:

- Which Rust MCP SDK vs. hand-roll.
- How the MCP server identifies the "current connection" — implicit (focused in UI) or explicit (agent passes name).
- Whether the agent activity strip is its own panel or overlays the grid.
- Anything in `docs/DESIGN_DOC.md` § "Open questions" the implementation forces a stance on.

When done, write `docs/POC_NOTES.md`: what shipped, what got punted, decisions future-Nathan should know before pushing to v0.1.
