# Postgres Workbench for AI-Agent Workflows — Design Doc

**Status:** working doc, v0
**Author:** Nathan
**Last updated:** 2026-05-20

---

## One-line pitch

A native Postgres workbench where an external AI agent (Claude Code, Cursor, your own) is the primary user and you're the supervisor watching it work. The viewer isn't where the AI lives — it's the canvas the AI annotates while you both work on the database together.

## Why this exists

Engineers in the vibe-coding / AI-agent era keep ending up in the same uncomfortable spot: the agent is doing the work, but the human is responsible for it. The existing tools (DBeaver, TablePlus, pgAdmin, Postico) were designed for a human at the keyboard. Web-based MCP-aware tools are emerging, but most either bury the agent's activity in a chat log or hand the agent unsupervised access to prod. There's no first-class surface that says: *here's what the agent saw, here's what it ran, here's what it's about to do, here's where you say no.*

The wedge user is **me, and engineers like me** — working backend/full-stack engineers who use AI agents on real databases (including production-adjacent ones) and need observability over what the agent is doing, not just a transcript of it. That framing is load-bearing: it rules out an agency-friendly test-data-first product, and it pulls EXPLAIN ANALYZE and hypothesis notebooks into v0.3 rather than v1.0+.

## The architectural primitive

The viewer exposes itself as an **MCP server** that any external agent can connect to. This is not bundling for convenience — it's the thing the whole product hinges on.

A separate Postgres MCP server can give an agent query access. What it can't do, because it lives outside the UI process, is:

1. **Record the full session** — every tool call, every result, every observation — as a first-class timeline the user can scrub through.
2. **Gate writes and destructive operations** through a UI the human is already watching.
3. **Augment the agent's queries with workbench tooling** — EXPLAIN ANALYZE rendering, HypoPG simulations, plan diffs — exposed as MCP tools the agent can drive.

Because tool calls flow through the viewer, the viewer becomes the place where supervision, recording, and tool augmentation all live in the same process. Everything else in the roadmap is downstream of this.

## Why native (Tauri), not VS Code extension or web

The honest reason: this needs to be an **adaptable canvas**, not a panel inside someone else's editor. A VS Code extension inherits Monaco and distribution for free, but it can't be a database-health dashboard, can't be the screen you put on a second monitor while you watch the agent work, can't grow into a multi-agent canvas later. The product wants to be Obsidian-shaped (a workspace you live in), not Postman-shaped (a tool you open when you need it).

Native also unlocks OS keychain access, no cloud round-trip on 100k-row results, file-system-level session storage, and the option to run fully air-gapped. Those are real, but they're the secondary case. The primary case is room to grow.

## Roadmap

### v0.1 — "This is legibly different"

The bar for v0.1 is: a developer sees the agent activity surface and recognizes that this is doing something existing workbenches don't.

- **Connection management** — multiple Postgres connections, secure credential storage via OS keychain (with Stronghold as a fallback only — see open questions), TLS/SSL, per-connection read-only toggle.
- **Schema browser** — hierarchical tree of schemas/tables/views/columns. Keyboard navigable. Fast search.
- **Query editor** — Monaco with Postgres syntax highlighting and autocomplete. Tabbed.
- **Results grid** — virtualized for 100k+ rows, inline editing, JSON sidebar viewer, export.
- **Built-in MCP server** — the viewer exposes itself as an MCP server. Installer auto-writes to `claude_desktop_config.json` (and equivalents for Cursor / Claude Code) so connection is one click, not a JSON-editing chore. Optionally ship as a `.mcpb` Desktop Extension for the Claude Desktop path.
- **Agent activity surface** — when the external agent runs a query or inspects a table, the viewer updates in real time. Split view: agent activity stream on one side, the agent's current focus (table, query, plan) on the other. The user sees what the agent sees.
- **Command palette** — ⌘K for everything, fuzzy search, recent commands.

### v0.2 — "People share this"

- **Session recording** — every agent action (query, table inspection, schema lookup, result observation) recorded as a timeline.
- **Time-travel replay** — scrub backward, see exactly what the agent saw at each step, what it decided, what it ran next.
- **Session export** — share a session as a self-contained HTML page. Local-only for v0.2; no hosted side. Marketing-as-side-effect, not as goal.
- **Permission gates** — adaptable policy model. A global default (e.g. "ask on writes, auto-allow reads"), overridable at the session level ("approve everything in this session"), overridable at the table level ("never auto-allow writes to `users`"). All consents are logged in the session record.

**Primary jobs for replay/sessions, ranked:**
1. Debugging an agent run that went wrong — finding where the agent got confused.
2. Audit trail for AI touching production-adjacent data.
3. Learning artifact — material a self-improving agent (or its operator) can study.

The "people share this for marketing" framing is a side benefit, not a design constraint. Storage, retention, and UX decisions should be driven by the three jobs above, in order.

### v0.3 — "Genuinely useful, not just clever"

- **Hypothesis notebooks** — first-class units beyond "the query." Agent stakes a hypothesis ("the slowdown is in the join on `user_id`"), gathers evidence via queries and plans, produces a verdict with citations back to the evidence. The notebook is the deliverable, not the SQL.
- **Agent-native test data generation** — agent generates a plan ("6 months of practice data, 70% new-patient appointments, realistic seasonality"), the user reviews and approves, it executes. Plans are versionable and repeatable. Respects PK/unique/FK constraints. The differentiator vs. Mockaroo/Synth/Faker isn't the data — it's that the *plan is the artifact* and the agent owns its execution.
- **Query plan tooling** — EXPLAIN ANALYZE rendering, hypothetical index simulation via HypoPG, plan diffing between two queries or two versions of the same query. Exposed as MCP tools so the agent can drive them autonomously.
- **Schema relationship view** — interactive graph of tables and FKs. The agent can pin annotations to nodes ("this column is deprecated," "this FK isn't indexed yet").

### v0.4 — "Fully private"

- **Ollama integration** — if the user prefers a local model, the viewer acts as both MCP server *and* MCP client, with a built-in local agent backed by Ollama. Useful for sensitive data or air-gapped environments.
- **Local embeddings** — semantic search over schema and saved queries via a local embedding model.

### v1.0+ — the bigger bets (gate on v0.x traction)

- **Ephemeral fork-and-experiment** — agent requests a forked Postgres, runs experiments, reports back, fork is auto-destroyed. Combined with replay, this is the safe-experimentation primitive the agent world is missing.
  - For generic Postgres: Docker-seeded forks.
  - For Tiger Data / Neon: integrate with their native forking rather than reimplementing it. Tiger's Agentic Postgres ships zero-copy forks + an MCP server; that's a platform to ride, not compete with.
- **Living schema annotations** — agent maintains a continuously updated annotated schema based on observed query patterns, `pg_stat_statements`, index usage. Schema becomes a knowledge surface, not a dead ERD.
- **Multi-agent sessions** — multiple agents annotating the same canvas. One profiling, one drafting migrations, one generating test data. Human as orchestrator. Research-y, but it's the unbuilt frontier.
- **Explain-this-database briefings** — point the agent at a new DB, get a living briefing document. Onboarding artifact for new engineers and new client work.

## Cross-cutting principles

- **Keyboard-first** throughout.
- **Dark theme native**, light theme available.
- **Fully local by default** — nothing leaves the machine unless the user explicitly enables a cloud feature.
- **Free and open** — Obsidian/Postman in spirit. A quality app anyone can have. No paid tier currently planned. The "bigger bets" stay in core. If a sustainable model is needed later, that's a future-Nathan decision; don't architect for paywalls preemptively.

## Out of scope (deliberate)

Cloud workspaces, team collaboration features, billing, auth beyond local credentials, SaaS hosting, web version. Sharing primitives (hosted exports, comments, cross-session search) come later — possibly never. Building any of these pre-traction is how you become an enterprise tool nobody wanted.

## Open questions to resolve before serious coding

These didn't get answered in the v0 pass and probably need a follow-up session.

1. **Permission-gate UX in the bulk case.** Test data generation may want to INSERT 50k rows in a single plan. Does the human approve once per plan, per table, per query, or above a row threshold? Default policy needs to be sketched concretely before v0.2 design.
2. **Credential storage choice.** Stronghold works in Tauri 2 but is slated for removal in v3. Default plan: OS keychain via the `keyring` Rust crate or `tauri-plugin-keyring`. Decide before v0.1 so we don't migrate later.
3. **Cursor / Claude Code installer story.** The Claude Desktop `claude_desktop_config.json` path is clear. Cursor and Claude Code have their own mechanisms — the "one-click registration" promise needs a concrete implementation plan per host.
4. **What does the activity surface look like in pixels?** This is the v0.1 differentiator and it's still described in prose. Worth a separate UX sketch session before committing to the architecture.
5. **Failure-mode story for the MCP server.** What happens when the agent's query crashes the viewer? When the viewer is closed mid-session? When two agents connect to the same viewer? Mostly v0.2+ concerns but worth listing.

## Stack sketch

- **Tauri 2** + Rust backend, React/TypeScript frontend.
- **DB layer:** `sqlx` or `tokio-postgres`. Probably `sqlx` for the developer ergonomics; revisit if performance bites.
- **Editor:** Monaco.
- **Results grid:** TanStack Table + `react-virtual`.
- **MCP server:** Rust, inside the Tauri binary so it ships with the app.
- **Local model integration:** Ollama HTTP API.
- **Credential storage:** OS keychain (`keyring` crate or a Tauri keychain plugin). Stronghold only as fallback for systems without a keychain — and accept the v3 migration debt explicitly.
- **Session storage:** SQLite alongside the app.

## Competitive landscape (one paragraph, for honesty)

DBeaver, TablePlus, Postico, pgAdmin — built for humans, no agent surface. Beekeeper Studio — closest in spirit (native, open core, good taste) but agent-unaware. Drizzle Studio, Outerbase, Neon Console — web-first, increasingly AI-aware, but not local-first. Tiger Data's Agentic Postgres ships an MCP server and zero-copy forking at the *database* level, which is adjacent rather than competitive — they own the DB-side primitives, this product owns the workbench-side primitives. The gap this product fills: native, local, agent-supervised, generic Postgres (not platform-locked).
