# Tasks

## Now

> **Live PII leak test — 2026-11-02.** Drove the dev build with `tauri-pilot` and attacked a
> seeded copy of the workbench DB over MCP as the agent. Bare columns, `SELECT *`, and the #36
> expression/error fixes held. 12 leak paths were confirmed, each returning real values that matched
> ground truth from psql. The quick wins it found are fixed in #41 (see Done). **Still open:**
> - WHERE/JOIN laundering, e.g. `JOIN generate_series(...) ON ascii(substr(p.ssn,pos,1)) = c.i`
>   rebuilds every SSN in one query; `lineage.rs`'s own `where_clause_reference_does_not_redact_output`
>   test allows this.
> - `pg_stat_activity.query` exposes the human's editor queries, including literal values.
> - Classifier misses on unmatched names (`billing.unpaid_balances.patient`, `appointments.notes`,
>   `lab_results`). Fixed in #43 (see Done).
>
> A DB-enforced agent role (column-level `REVOKE SELECT`) isn't an option, so the app closes these
> itself: fail-closed classification (#43) and the three tasks in Next.

## Next

- [ ] **Security (R2 — critical):** Agent SQL still runs over real classified values, so predicates
  launder them. Redaction only fakes the *output*. WHERE, JOIN, ORDER BY, CASE, row counts, errors
  and timing all see the real value, e.g. `JOIN generate_series(...) ON ascii(substr(p.ssn,pos,1))
  = c.i` rebuilds every SSN in one query.
  - **Fix direction:** mask at the source. Before agent SQL reaches Postgres, rewrite every reference
    to a classified table as a derived table that swaps each classified column for a keyed hash,
    e.g. `(SELECT id, encode(sha256($key || convert_to(ssn::text, 'UTF8')), 'hex') AS ssn, … FROM
    clinical.patients) AS p`.
    - Key the hash per connection only, not per table or column, so joins on a classified key still
      match. The redactor maps hashes to fakes on the way out and stops being the security boundary.
    - Comparisons against real literals (`WHERE email = 'jane@…'`) stop matching. Don't hash the
      literal for the agent, since that confirms guesses; point it at `propose_query` instead.
    - The key travels as a bind parameter, so it can reach server logs that record parameters.
      Acceptable (the DBA can already read the real data), but note it.
  - Depends on the allowlist below: the rewrite is only safe when every relation reference resolves.

- [ ] **Security (R2 — high):** Agent SQL is screened by a blocklist (`SQL_EXECUTING_FUNCTIONS`,
  `VALUE_SAMPLING_CATALOGS` in `lineage.rs`), so anything not listed passes. For example,
  `pg_stat_activity.query` returns the human's editor queries with literal values, and a
  user-defined function can read a classified table internally.
  - **Fix direction:** on classified connections, accept only a SQL subset the rewriter fully
    understands:
    - `SELECT` with CTEs, joins and subqueries over tables and views the scan knows.
    - Allowlisted built-in functions only. No user-defined functions, no `pg_sleep`.
    - Value-free catalogs only (`information_schema`, `pg_class`, `pg_attribute`, `pg_namespace`,
      `pg_index`, `pg_constraint`). Not `pg_stats*`, `pg_stat_activity`, `pg_stat_statements` or
      `pg_proc.prosrc`.
    - Pin `search_path` with `SET LOCAL` inside the agent's read-only transaction, so the rewriter
      resolves names the way Postgres does.
    - Refuse everything else with a pointer to `propose_query`, which hands the SQL to the human.
  - Ships with the source-masking task above and replaces the blocklist.

- [ ] **Security (R2 — medium):** Nothing checks result values before they go to the agent, so an
  identifier in a column the classifier missed goes out as-is.
  - **Fix direction:** on the agent path, run the content detectors from fail-closed classification
    (SSN shape, Luhn-valid card numbers, email, phone) over unredacted cells before the result
    crosses `bridge.rs`. On a hit, fake the cell and queue a Pending classification for its source
    column.
  - Backstop only: it can't catch predicate laundering, where the output is counts or booleans. The
    source-masking task covers that.

## Later

- [ ]

## Done

- [x] **Security (R2 — high) — fixed in #43:** The classifier only matched column names, once, at
  connect, so a column it missed reached agents unredacted: unhelpful names
  (`billing.unpaid_balances.patient`, `appointments.notes`, `lab_results`), a view renaming a
  classified column, a copy made by `CREATE TABLE AS`, a column renamed by a migration.
  - Text-like columns now redact until marked Safe. Sampled values flag SSNs, emails, phones and
    card numbers. Views and copies inherit, classifications follow renames, and the agent path
    rescans when its SQL names a relation that changed.
  - Also fixed: a dropped-and-recreated table's bare classified columns went out unredacted,
    because sqlx's cached prepared statement kept the old table OID.

- [x] **Security (R2 — critical) — fixed in #41:** The agent's "read-only" paths aren't read-only, so it can copy
  PII into an unclassified table with no prompt. `validate_select_only` (`query.rs:58`) only checks
  that the SQL *starts with* `select`/`with`, and `run_decoded` (`query.rs:218`) runs it outside any
  read-only transaction.
  - Live repro through `run_query`: `SELECT mrn, first_name, last_name, dob, ssn INTO TABLE
    public.zz_exfil FROM clinical.patients` created the table with no approval. A plain
    `SELECT * FROM public.zz_exfil` then returned every real value, because the copy has no
    classified OID and no classified name.
  - It is also a DDL bypass of the write gate.
  - `execute_statement` likely has the same hole: `policy::stmt_info` classifies any non-writing
    `Statement::Query` as `Select` → Allow. Not live-tested.
  - **Fix direction:**
    - Run agent reads (`run_query`, and `execute_statement` when the verdict is a `Select` Allow)
      inside `BEGIN READ ONLY`. That also blocks side-effecting functions.
    - Classify `SELECT … INTO` as `CreateTable` in policy.

- [x] **Security (R2 — critical) — fixed in #41:** Writes to `public.*` are auto-allowed, so one `execute_statement`
  launders PII through `RETURNING`. The default rule "Write to public.* (≤1000 rows)"
  (`policy.rs:518`) lets INSERT/UPDATE run with no permission card.
  - Live repro: `INSERT INTO public.audit_log (action, target_kind, target_id) SELECT 'x', 'y',
    mrn||'|'||first_name||' '||last_name||'|'||ssn FROM clinical.patients RETURNING target_id`
    returned real MRN, name, and SSN immediately.
  - `RETURNING target_id` is a bare ref to an unclassified column, so neither the OID path nor
    lineage redacts it.
  - **Fix direction:**
    - Drop the auto-allow, or prompt whenever the write's source reads a classified table.
    - Fix the row estimate (next item) before relying on any row-bounded Allow.

- [x] **Bug (permission gate) — fixed in #41:** The row estimate for writes is always 0, so every row-bounded rule
  is effectively unbounded. `estimate_rows` (`execute.rs:146`) reads `Plan Rows` from the top plan
  node. For INSERT/UPDATE/DELETE without RETURNING that node is `ModifyTable`, which always reports 0.
  - Verified: `EXPLAIN (FORMAT JSON) UPDATE public.leads SET status = status` → `ModifyTable Plan
    Rows=0`, while the child scan reports 100.
  - So "≤1000 rows" auto-allows a write of any size.
  - **Fix direction:** read the `ModifyTable` node's child plan (`Plans[0]`) and add a test pinning
    the shape.

- [x] **Security (R2 — critical) — fixed in #41:** Human-path operations open pools without classifying, so the
  agent reads fully unredacted data. `Core::pool` (`core.rs:115`) calls `pools.ensure` for *any*
  human op (`describe_table`, `list_schemas`, `run_sql`, …). The classifier only runs in
  `core::connect` (`lifecycle.rs:52`).
  - Live repro: added `sectest-fresh`, fired only the human `describe_table` IPC (no connect) →
    `connected:true` with 0 classifications. A plain agent `SELECT mrn, first_name, ssn …` then
    returned every real value.
  - Observed by accident on app launch: a restored `dev` table tab (`Workspace.tsx:137`
    `editing.ensureMeta`, not gated on `connected`) ran `describe_table("dev", …)`. That silently
    opened **cloudsql-dev**, and the agent could reach it while the UI still showed
    "disconnected". It was redacted only because `dev` had classifications from earlier sessions.
  - The same restored tab loops: about 40 `describe_table` calls per 100 ms after a reload.
  - Related: the fail-open classifier item below (same root issue: "never classified" is treated as
    "nothing to redact") and the UI/registry divergence item in Next.
  - **Fix direction:**
    - Agent reads on a connection with zero persisted classifications must refuse or fully mask.
      This also closes the fail-open item.
    - Stop non-`connect` human ops from opening pools: return "not connected", or classify on any
      first open.
    - Gate `ensureMeta` on `active.connected`.

- [x] **Security (R2 — critical) — fixed in #41:** Lineage gaps let expression columns return real values.
  `SensitiveExprVisitor` (`lineage.rs:297`) matches classified columns by *name* and only sees
  `Expr` nodes. Two live repros returned real name/DOB/SSN/email and whole rows:
  1. **Table column-alias lists rename columns out from under it:** `SELECT x5||'' FROM
     clinical.patients AS p(x1,…,x12)`.
  2. **`p.*` inside a function call is a `FunctionArgExpr::QualifiedWildcard`, not an `Expr`, so
     the visitor never sees it:** `SELECT to_jsonb(p.*) FROM clinical.patients p` returned the
     full real row.
  - **Fix direction:**
    - Resolve `TableAlias.columns` positionally against the table's classified columns (or fail
      closed whenever a classified table carries a column-alias list).
    - Treat a `QualifiedWildcard`/`Wildcard` function argument over a classified table as a
      whole-row reference.

- [x] **Security (R2 — critical) — fixed in #41:** Lineage can't see SQL executed from strings or values read from
  stats catalogs, so both pass through raw.
  - **Live repro, SQL in a string:** `SELECT query_to_xml('select mrn, first_name, last_name, dob,
    ssn from clinical.patients', true, false, '')` returned real values. No relation appears in
    the AST, so `should_redact_derived` returns false at `lineage.rs:72`. `table_to_xml`,
    `schema_to_xml`, `database_to_xml`, `cursor_to_xml` and their `*_xmlschema` variants behave the
    same way.
  - **Live repro, stats catalogs:** `pg_stats.most_common_vals` / `histogram_bounds` returned real
    SSNs, last names, DOBs, and emails of classified columns.
  - **Fix direction:**
    - On a classified connection, reject agent SQL that calls any SQL-executing function.
    - Reject agent SQL that references `pg_stats`, `pg_stats_ext`, `pg_stats_ext_exprs`, or
      `pg_statistic`.
    - Match on the parsed AST (function and relation names), not raw text.
    - This is a blocklist, so the DB-enforced agent role (see the blockquote above) remains the
      real fix.

> **Security review — 2026-06-30 (agent connection-authority + PII redaction).** Adversarial pass
> over the two product invariants: (R1) an agent may only operate on a DB a human connected, and
> (R2) an agent may never read the real value of a classified column. **R1 is structurally sound**
> (every agent DB op routes through the `PoolAccess::Agent` `get_open` seam; `run_mcp` owns no
> pool/credentials; approval-forgery, socket hardening, and migration row-discard all verified
> closed). **R2 has confirmed agent-reachable bypasses** — logged below. The same-UID credential
> read is a documented, accepted out-of-scope residual.

- [x] **Security (R2 — high) — fixed in #41:** Fail-open classifier silently disables redaction. `lifecycle.rs:52`
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

- [x] **Bug — fixed in #41:** Clicking a table to open a new query for it generates an unquoted table name. It shows e.g. `roi.Patient`, but it should be `roi."Patient"` so mixed-case/reserved identifiers resolve correctly.
- [x] **Bug — fixed in #41:** The workbench's SQL parser doesn't support `DO` (anonymous PL/pgSQL) blocks. An agent hit this when trying to run a `DO $$ ... $$;` statement — the parser rejects it.
- [x] **UX — fixed in #41:** UPDATE/INSERT (and other write statements) show "0 rows" in the result, which actually means "no rows returned" — misleading for writes. Show the affected row count instead (e.g. "3 rows updated") so the user sees how many rows the statement touched.
- [x] **Bug — fixed in #41:** When scrolling the results pane, the `Read-only result` callout overlaps the result column headers, obscuring the column names. The callout should stay clear of (or scroll with) the header row so headers remain readable while scrolling.
- [x] **UX — fixed in #41:** Distinguish redacted/faked result values with a distinct font style (e.g. italic or a muted/tinted color) so they read as clearly redacted. Real values have been mistaken for unredacted several times because faked values are visually indistinguishable from genuine data.

- [x] **Security (R1 — low / regression guard) — fixed in #41:** The spec-mandated Phase-4 guard is missing
  (`design/mcp-connection-authority.md:161`): nothing asserts `connections::get_password` /
  `PgPoolOptions::connect_with` are unreachable from the `--mcp` entry. The invariant holds today
  (`run_mcp` builds only a `ProxyClient`, `lib.rs:697`), but UI and MCP share one binary, so the
  credential reader/pool opener are linked in and one `use` away from regressing with CI green
  (`ci.yml` runs only `cargo check` + `cargo test`). **Fix direction:** add a CI grep step or a
  `#[test]` asserting `run_mcp`'s call graph references no `Core`/`PoolRegistry`/credential symbol —
  ideally move the proxy path into its own crate so the linker enforces it.

- [x] **Security (R1 — low / regression guard) — fixed in #41:** `execute_migration` Phase B (`execute.rs:374-411`)
  runs approved statements against the `PgPool` captured at `execute.rs:321` *before* the human
  approval prompts, with no post-prompt authority re-check — unlike the single-statement path, which
  re-acquires via `core.pool()`→`get_open` inside `run_decoded` and fails closed if the human
  disconnected mid-prompt. No live break today (disconnect calls `PgPool::close()`, so
  `begin()`/`execute()` error out), but R1 per-use authority here leans solely on `close()` rather
  than the registry seam. **Fix direction:** re-acquire the pool via `core.pool(conn)` at the top of
  Phase B so `get_open` re-validates authority after the prompts.

- [x] **Security (R1 — low / hardening) — fixed in #41:** The UI "connected" indicator and the backend
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

- [x] **Security (R2 — low) — fixed in #41:** Redaction secret falls back to an all-zero HMAC key. `redactor.rs:90`
  does `get_redaction_secret(...)?.unwrap_or([0u8;32])`; if classifications exist but the secret is
  missing (e.g. a transient keychain failure after `insert_classification` committed but before
  `ensure_redaction_secret`), fakes are generated under a publicly-known key. Not a real-value leak
  (fakes still replace reals; the shape generators are many-to-one and non-invertible) — it only
  weakens cross-connection unlinkability. **Fix direction:** in `build_view`, when classifications
  are non-empty but the secret is `None`, generate-and-persist on the spot or error — never
  substitute the constant key.

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
