# MCP Connection Authority — Thin-Proxy Refactor

**Status:** Proposed (spec for review)
**Problem owner:** human-initiated connections must be the *only* way the MCP can reach a database.

## 1. The problem

An agent can connect to (and query) a database through the MCP server even when the
workbench UI is not running, or is running but not connected to that database. The
product requires that **a human always initiates the connection** — the MCP may only
operate against a database the UI is *currently, actively* connected to.

### Root cause (it's architectural, not a missing check)

The `--mcp` process (`lib.rs::run_mcp`) is a **separate process** with its **own**
`PoolRegistry` (`lib.rs`), its **own** credential reader (`pool.rs` → `connections::get_password`),
and a **direct** Postgres driver. The Unix socket to the UI carries only activity events
and permission verdicts — it is *not* in the connection-authority path.

Consequences:
- `core::connect` (`lifecycle.rs`) opens a pool with no UI check — but that's only one symptom.
- `PoolRegistry::ensure` (`pool.rs`) **lazily auto-opens** a pool on demand, so 6 of 7
  DB-touching tools self-connect even if `connect` were gated. **Gating `connect()` alone is useless.**
- When the UI is down, the bridge's socket connect fails silently and DB work proceeds anyway.

This is a **divergence from the documented design.** `design/README.md` §Stack and §Agent IPC
already specify *one* core that owns Postgres, with the agent forwarding SQL over a local IPC
and receiving results back ("the app inserts policy checks at this layer"). The two-`PoolRegistry`
split is the drift that created the bug; this refactor realigns to spec.

## 2. Decision

Adopt the **MCP-as-thin-proxy over a UI-owned core** architecture. Confirmed choices:

| Fork | Decision |
|------|----------|
| Path | Thin-proxy, straight to the ideal (no interim advisory gate). |
| Agent `connect` tool | Surfaces a **connect-request the human approves** in the UI (reuses the permission round-trip). |
| Multi-agent | **Full** per-connection / per-request routing from the start; `agent_id` threaded end-to-end. |
| Credential residual | Accept it; add cheap socket hardening; document the boundary. |

### Guarantee (state verbatim in the PR)

> Structural against the in-tree MCP process and against "UI not running / not connected."
> **Advisory against a tampered or standalone same-user process**, because DB credentials remain
> readable by any process of the same UID (and in debug builds sit in plaintext `dev-secrets.json`).
> True structural defense against the agent *itself* would require a credential broker the MCP's
> UID cannot read — out of scope for this change.

## 3. Target architecture

### 3.1 Process split

- **UI process** (`run()`): owns the **only** `PoolRegistry`, the **only** `connections::get_password`
  call site, the redactor, the policy evaluator, the permission gate, and the human. Binds the Unix socket.
- **MCP process** (`run_mcp()`): holds **no** `PoolRegistry` and **no** credential access — only a
  `ProxyClient` over the socket. Every DB-touching tool serializes a request and awaits a response.

Pools exist in the UI registry **only because a human clicked a connection row**
(`SchemaTree` → `api.connect` → `core::connect`). Disconnect drops the pool; the next agent request
fails closed. UI down → socket absent → `ProxyClient` hard-fails → every tool errors.

### 3.2 Socket as RPC (replaces the activity-only bridge)

Framing moves from newline-delimited JSON to **length-prefixed `u32 + JSON`** with a max-frame cap
(a 1000-row `QueryResult` is too large for the current line buffer). `BridgeMsg` collapses to:

- `Hello { agent_label }` — first frame from MCP after connect. UI validates peer UID, assigns an
  `agent_id`, registers the agent, emits a presence event.
- `Request { request_id, tool, args }` — MCP → UI.
- `Response { request_id, result }` / `ResponseError { request_id, error }` — UI → MCP.

**Activity and Verdict messages leave the socket entirely.** Execution now happens in the UI process,
so activity events are emitted locally to the frontend (tagged with `agent_id`), and permission
verdicts resolve locally (§3.4). The protocol is single-version (UI and MCP are the same binary),
so no cross-version compatibility is needed.

### 3.3 Pool-access capability split (closes the lazy-`ensure` hole structurally)

Add `PoolRegistry::get_open(name) -> Option<PgPool>` that **never** auto-opens. Route pool resolution
through a **single seam** keyed by an explicit, **type-level** capability — not an `auto_open: bool`
(a boolean would silently default wrong on a future call site, e.g. the transitive
`connect → classify_schema → sensitivity.rs → ensure()` path).

Concretely: the UI process constructs **two `Core` handles sharing one `PoolRegistry`** (and one meta
DB, redactor cache, pending-permission registries):
- a **human** core whose pool resolution may `ensure`/auto-open (drives the Tauri commands);
- an **agent-dispatch** core whose pool resolution is `get_open`-only and returns "not connected"
  when the human hasn't opened it.

Convert every current auto-open call site to the seam: `query.rs`, `schema.rs` (×3), `execute.rs` (×2),
and `sensitivity.rs`. `ensure`/`connect` remain reachable only from the human path.

### 3.4 Permission flow collapses to local

Today `execute_statement` emits a `permission_required` event over the socket and blocks on a oneshot
resolved by a verdict sent back over the socket (`execute.rs`). After the refactor, execution runs in
the UI process, so:
- `pending_permissions` / `pending_migrations` live in the UI's agent-dispatch core;
- `resolve_permission` / `resolve_migration` Tauri commands resolve the **in-process** oneshot
  (no `send_verdict_to_mcp`, no socket hop);
- the agent's in-flight `Request` simply stays open until the human answers, then the `Response` is sent
  — synchronous from the agent's perspective, exactly as `design/README.md` §Agent IPC specifies.

### 3.5 Multi-agent (`agent_id` end-to-end)

- **Backend:** replace the single `McpWriter` (`Arc<Mutex<Option<OwnedWriteHalf>>>`) with an
  **agent registry** (`agent_id → { write half, label, connected_at }`). Each accepted socket = one
  agent; its per-accept reader task owns its write half. Responses route back on that connection;
  the MCP side keeps a `request_id → oneshot` map for concurrent in-flight calls.
- **Identity:** UI assigns `agent_id` on accept; MCP supplies a human `agent_label` via `Hello`.
- **Types:** add `agent_id` to `ActivityEvent`, `PermissionRequest`, `MigrationRequest`
  (Rust `types.rs` + `api.ts`).
- **Frontend:** `mcpConnected: boolean` → `agents: Map<agentId, presence>` (per-agent four-state
  indicator); `pendingPermission: …| null` → a per-agent queue/stack of cards; activity stream and
  `agentTouched` grouped/attributed by `agent_id`.

> **Net-new design.** The current design (`design/README.md`) is single-agent (hardcoded "Claude Code"
> badge, one dock/stream) and lists multi-agent identity as an open question. The multi-agent **UI
> surfaces** need a design pass (artboards + JSX in `design/`) before implementation — see Phase 6.

### 3.6 Socket hardening (cheap, honest)

- Create the socket **0600** in the user-owned app-data dir.
- On `accept`, verify the **peer UID == our UID** (`getpeereid` on macOS) and reject otherwise.

> The originally-suggested per-launch nonce is **dropped**: the UI does not spawn the MCP (Claude
> Code/Desktop does, from `mcp_snippet`), so there is no private channel to deliver a secret, and any
> same-UID-readable token adds nothing over the peer-UID check. Peer-UID + 0600 is the complete cheap
> hardening for this topology.

## 4. Migration plan (phased; safety lands late and atomically)

Phases 0–3 build the proxy; only **Phase 4** — removing the MCP's pool + credentials — flips the
guarantee on. Per project convention: one branch up front, a commit per phase, one PR at the end.
Each phase ends with `cargo check` + tests, and (where it touches runtime UI) `tauri-pilot` validation.

- **Phase 0 — Capability-typed pool access (no behavior change).** Add `get_open`; introduce the
  single pool-resolution seam + the human/agent capability split; convert all auto-open call sites.
  Human path still auto-opens. *Verify:* existing Tauri-driven flows unchanged via `tauri-pilot`.

- **Phase 1 — Socket → RPC + multi-agent routing + auth.** Length-prefixed framing + max-frame cap;
  `Hello`/`Request`/`Response`/`ResponseError`; agent registry replacing `McpWriter`; peer-UID check +
  0600 socket; `agent_id` added to event/permission types. *Verify:* extend
  `full_round_trip_over_unix_socket` with a multi-KB payload and two concurrent agents routed independently.

- **Phase 2 — Proxy the read tools + authority gate.** UI listener `Request` arm: peer-UID → re-check
  `is_connected(connection)` under lock → dispatch reads (`list_connections`, `list_schemas`,
  `list_tables`, `describe_table`, `run_query`) to the agent-dispatch core (`get_open`) → `Response`.
  Flip those `mcp.rs` handlers to proxy. *Verify:* connected DB returns redacted rows; a DB the human
  isn't connected to returns "not connected"; no-UI standalone errors.

- **Phase 3 — Proxy the gated tools + collapse the prompt.** Move `execute_statement` /
  `execute_migration` to proxy; permission prompt originates and resolves locally in the UI
  (`pending_permissions` + `resolve_permission`); events carry `agent_id`; remove `send_verdict_to_mcp`
  and the socket Verdict variants. *Verify:* write/DDL pauses; allow/deny/modify; rollback on deny;
  frontend permission-card path intact.

- **Phase 4 — Remove the MCP core (the structural flip).** `run_mcp` builds a `ProxyClient` only — no
  `PoolRegistry`, no `get_password`. Delete the MCP-side core's pool/credential wiring and `mcp_bridge`.
  Add a CI/grep assertion that `connections::get_password` and `PgPoolOptions::connect_with` are
  unreachable from the `--mcp` entry; `ProxyClient` fails hard when the socket is absent. *Verify
  (tauri-pilot):* standalone `--mcp` with no UI → every DB tool errors; full golden path still works.

- **Phase 5 — Agent `connect` = human-approved request.** The proxied `connect` tool emits a
  connect-request that surfaces in the UI; on approve the UI runs the human-style `core::connect`
  (opens the pool), on deny the agent gets an error. Adds a small connect-approval card (design + mount).
  *Verify:* agent connect → UI prompt → approve → agent can query; deny → blocked.

- **Phase 6 — Multi-agent UI surfaces (design-led).** Design pass first (artboards + JSX in `design/`,
  resolving the agent-identity open question), then implement per-agent presence, a per-agent card
  queue, and agent-attributed activity, and mount them. *Verify (tauri-pilot):* two concurrent agents
  show independent presence, activity, and permission cards.

- **Phase 7 — Full validation.** `tauri-pilot` across: golden path; UI-not-connected; no-UI standalone;
  disconnect mid-session (next call fails); large result round-trip intact; two concurrent agents;
  connect-approval flow.

## 5. Residual / out of scope

- **Same-user credential isolation** (the agent-as-attacker case) — needs a credential broker; separate
  workstream if pursued.
- **Large-result proxying latency** — every agent query now crosses the socket as a serialized
  `QueryResult` (≤1000 rows, capped). Confirm the max-frame guard; accept the round-trip as the cost of
  the safety property.
