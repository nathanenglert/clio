# clio

A Postgres workbench you watch from. Connect, browse, query — and let an agent do the same work through the same app over [MCP](https://modelcontextprotocol.io/).

> **Status:** POC. Reads only — `SELECT` and `WITH`-prefixed `SELECT`. Writes and DDL are rejected at the seam.

## What it is

A single Rust binary that runs in two modes off the same source:

- **No args** → Tauri 2 desktop UI (React frontend, Rust core).
- **`--mcp`** → stdio MCP server. No window. Six tools: `list_connections`, `connect`, `list_schemas`, `list_tables`, `describe_table`, `run_query`.

Both modes share `core.rs`. From the engine's point of view, a query you typed and a query the agent ran are indistinguishable — same pool, same validator, same activity event. The bottom strip shows them interleaved.

## Quickstart

```bash
pnpm install
pnpm tauri dev
```

Then add a Postgres connection in the left rail. The MCP modal (top-right) gives you the snippet to drop into your agent's config — point it at the same binary with `--mcp`.

## Layout

```
src/             React UI — workspace, schema tree, agent activity surface
src-tauri/src/   Rust core, MCP server, Postgres pool, activity bus
design/          UI source of truth — screenshots + JSX prototypes
docs/            Design doc + POC notes
```

## How a few pieces fit

- **Connections** are persisted in a local SQLite metadata DB; passwords live in the OS keyring (`keyring` 3.x).
- **Pools** are lazy: `PoolRegistry` opens a `PgPool` on first use, keyed by connection name.
- **MCP ↔ UI activity bridge.** The UI process listens on a Unix domain socket; the MCP process writes JSON lines to it. Either source emits the same `activity` event on the frontend — best-effort, the MCP side drops if the UI isn't up.
- **Row cap.** `run_query` caps at 1000 rows and flags `truncated`.

See [`docs/POC_NOTES.md`](./docs/POC_NOTES.md) for what shipped vs. what got punted, and [`CLAUDE.md`](./CLAUDE.md) for contributor guidelines.
