# Tasks

## Now

> **Security review — 2026-06-30 (agent connection-authority + PII redaction).** Adversarial pass
> over the two product invariants: (R1) an agent may only operate on a DB a human connected, and
> (R2) an agent may never read the real value of a classified column. **R1 is structurally sound**
> (every agent DB op routes through the `PoolAccess::Agent` `get_open` seam; `run_mcp` owns no
> pool/credentials; approval-forgery, socket hardening, and migration row-discard all verified
> closed). **R2 has confirmed agent-reachable bypasses** — logged below. The same-UID credential
> read is a documented, accepted out-of-scope residual.

- [ ] **Security (R2 — high):** Fail-open classifier silently disables redaction. `lifecycle.rs:52`
  runs `classify_schema(...).await.ok()`, discarding the error *after* the pool is already opened
  (line 47). On a first-ever connect where `classify_schema` errors (info_schema scan timeout/blip,
  or `ensure_redaction_secret` keychain write failure), the connection goes live with **zero**
  classifications and no toast; `build_view` returns an empty view, the redactor pass is skipped, and
  the agent reads fully unredacted PII for the life of that connection. Both human-connect and
  agent-`request_connect`→`resolve_connect` route through `core::connect`, so both share it. Root
  issue: `view_for` can't tell "classified, nothing sensitive" from "never classified" — both yield
  an empty `by_oid`. **Fix direction:** fail closed — if classify errors and the connection has zero
  persisted classifications, surface it to the human and have the agent read path refuse / fully-mask
  rather than treat empty `by_oid` as "no redaction needed."

- [ ] **Bug:** Clicking a table to open a new query for it generates an unquoted table name. It shows e.g. `roi.Patient`, but it should be `roi."Patient"` so mixed-case/reserved identifiers resolve correctly.
- [ ] **Bug:** The workbench's SQL parser doesn't support `DO` (anonymous PL/pgSQL) blocks. An agent hit this when trying to run a `DO $$ ... $$;` statement — the parser rejects it.
- [ ] **UX:** UPDATE/INSERT (and other write statements) show "0 rows" in the result, which actually means "no rows returned" — misleading for writes. Show the affected row count instead (e.g. "3 rows updated") so the user sees how many rows the statement touched.
- [ ] **Bug:** When scrolling the results pane, the `Read-only result` callout overlaps the result column headers, obscuring the column names. The callout should stay clear of (or scroll with) the header row so headers remain readable while scrolling.
- [ ] **UX:** Distinguish redacted/faked result values with a distinct font style (e.g. italic or a muted/tinted color) so they read as clearly redacted. Real values have been mistaken for unredacted several times because faked values are visually indistinguishable from genuine data.

## Next

- [ ] **Security (R1 — low / regression guard):** The spec-mandated Phase-4 guard is missing
  (`design/mcp-connection-authority.md:161`): nothing asserts `connections::get_password` /
  `PgPoolOptions::connect_with` are unreachable from the `--mcp` entry. The invariant holds today
  (`run_mcp` builds only a `ProxyClient`, `lib.rs:697`), but UI and MCP share one binary, so the
  credential reader/pool opener are linked in and one `use` away from regressing with CI green
  (`ci.yml` runs only `cargo check` + `cargo test`). **Fix direction:** add a CI grep step or a
  `#[test]` asserting `run_mcp`'s call graph references no `Core`/`PoolRegistry`/credential symbol —
  ideally move the proxy path into its own crate so the linker enforces it.

- [ ] **Security (R1 — low / regression guard):** `execute_migration` Phase B (`execute.rs:374-411`)
  runs approved statements against the `PgPool` captured at `execute.rs:321` *before* the human
  approval prompts, with no post-prompt authority re-check — unlike the single-statement path, which
  re-acquires via `core.pool()`→`get_open` inside `run_decoded` and fails closed if the human
  disconnected mid-prompt. No live break today (disconnect calls `PgPool::close()`, so
  `begin()`/`execute()` error out), but R1 per-use authority here leans solely on `close()` rather
  than the registry seam. **Fix direction:** re-acquire the pool via `core.pool(conn)` at the top of
  Phase B so `get_open` re-validates authority after the prompts.

- [ ] **Security (R1 — low / hardening):** The UI "connected" indicator and the backend
  `PoolRegistry` (the *actual* authority for agent access) can diverge. The human path opens pools via
  `PoolAccess::Human` → `pools.ensure` on **any** DB op (`Core::pool`; reached by `run_query`
  →`core::run_sql`, `list_schemas`, `describe_table`, `export`, `classify_schema`, …), not only via
  the explicit `connect` command that drives the frontend's connected chip. **Surfaced during PR #36
  live validation (2026-07-01):** a human-path `run_query` IPC auto-opened `local`, so
  `list_connections` reported `connected:true` and the MCP agent could query it, while the app window
  still showed "no database connected." **Not an R1 break** — a human action still opens every pool
  and the agent never opens one (verified: `disconnect` → the agent's next call fails "not
  connected") — but a human reading a "disconnected" chip can under-estimate what an agent can
  currently reach. **Fix direction:** make the frontend connection state reflect registry truth
  (poll/subscribe `is_connected`), and/or gate agent access on an explicit "human-connected" flag
  rather than "any open pool," and/or require the explicit `connect` flow to open pools instead of
  auto-`ensure`-ing on ad-hoc query ops.

- [ ] **Security (R2 — low):** Redaction secret falls back to an all-zero HMAC key. `redactor.rs:90`
  does `get_redaction_secret(...)?.unwrap_or([0u8;32])`; if classifications exist but the secret is
  missing (e.g. a transient keychain failure after `insert_classification` committed but before
  `ensure_redaction_secret`), fakes are generated under a publicly-known key. Not a real-value leak
  (fakes still replace reals; the shape generators are many-to-one and non-invertible) — it only
  weakens cross-connection unlinkability. **Fix direction:** in `build_view`, when classifications
  are non-empty but the secret is `None`, generate-and-persist on the spot or error — never
  substitute the constant key.

## Later

- [ ]

## Done

- [x] **Security (R2 — critical) — fixed in #36:** An agent reads real PII by wrapping a classified column in *any*
  expression. Redaction in `run_decoded` (`src-tauri/src/core/query.rs:211`) only fires when sqlx
  reports a result column's source `relation_id()` + `relation_attribute_no()`; Postgres sends `0/0`
  (→ `None`) for *any* computed column, so the redactor never matches it and the raw value flows out
  via the `_ => raw` arm. Reachable with **no human prompt** through both `run_query` (SELECT-only)
  and `execute_statement` (a SELECT is policy `Allow`, runs immediately, `reveal=false`). Repro:
  `SELECT ssn||'' AS s, lower(email) AS e FROM patients` → real values; `SELECT to_jsonb(p) FROM
  patients p` or `SELECT string_agg(ssn,',') FROM patients` dump whole classified columns/rows in one
  query; `SELECT ssn::text`, `COALESCE(ssn,'')`, `(SELECT ssn …)`, `CASE … ssn …`, window/aggregate
  forms all work. `redaction_meta` comes back `null`, so the agent isn't even told data was masked.
  Bare refs / aliases / `SELECT *` *do* still redact — the gap is purely transformed columns.
  Documented as a v0 "derived columns" limitation (`design/redaction.md:486`), but under the agent
  threat model the SQL author is the adversary, so it's a direct R2 violation. **Fix direction:** add
  a value-side/lineage safety net on the agent path — when a result column has no `(oid,attnum)`
  mapping (or its lineage touches a classified column), redact-by-default / pattern-redact / reject
  rather than emit raw. The same OID-only gap also exists in `export.rs` (human-only path); fix at a shared layer.

- [x] **Security (R2 — critical) — fixed in #36:** Postgres error messages echo the real classified value back to
  the agent. A failed query's DB error propagates verbatim: `run_decoded` (`query.rs:196`
  `.with_context("query failed")`) → `bridge.rs:414` `format!("{e:#}")` → `mcp.rs` with no
  sanitization; the redactor only touches *successful* rows, never the error channel. **Live-verified
  against the dev DB:** `SELECT ssn::int FROM patients` → `invalid input syntax for type integer:
  "111-22-3333"`; `SELECT email::date FROM users` / `SELECT mrn::uuid FROM charts` leak their real
  values (CTE branch too). Affects `run_query` and `execute_statement`; unique-constraint violations
  via `execute_statement`/`execute_migration` similarly echo `Key (email)=(real@x.com) …`. Category-
  agnostic — bypasses the redactor entirely. **Fix direction:** on a connection that has
  classifications, strip `DatabaseError` message/detail/hint from the anyhow chain and return a
  generic failure before it crosses the bridge.
