# UI Design Prompt — Postgres Workbench for AI-Agent Workflows

Paste the section below into Claude (or a Claude-powered design tool) to generate UI mockups, layouts, or component designs. Adjust the "What to design in this pass" section to scope each iteration.

---

## Prompt

You are designing the UI for a native desktop Postgres workbench built for a very specific user: a backend/full-stack engineer who is supervising an external AI agent (Claude Code, Cursor, etc.) as it works on a real database. The human is not typing queries — the agent is. The human is watching, gating writes, scrubbing through what the agent did, and intervening when something looks wrong. **The viewer is the canvas the AI annotates while the human supervises.**

This framing is the entire product. Every design decision has to serve it. Tools like DBeaver, TablePlus, and pgAdmin were designed for a human at the keyboard; this one isn't. The differentiator is not "AI chat bolted onto a SQL editor" — it's a first-class **agent activity surface** that shows what the agent saw, what it ran, what it's about to run, and where the human says no.

### Product personality

- **Obsidian-shaped, not Postman-shaped.** A workspace the user lives in, not a tool they open when they need it. It should feel inhabitable — comfortable on a second monitor for hours, not transactional.
- **Native and local.** Tauri + React. Should feel like a real macOS/Linux/Windows app, not a webpage in a window. Respect platform conventions (traffic lights, native menus, OS-level shortcuts).
- **Dark theme is the canonical theme.** Light theme exists but is secondary. Calm, low-contrast neutrals; restrained accent colors; type-forward; generous whitespace; nothing that screams "developer tool from 2014."
- **Keyboard-first throughout.** Every action reachable without the mouse. ⌘K command palette is the navigational spine.
- **Information density without clutter.** Engineers will have 100k-row result grids open. The chrome has to disappear when data is on screen.

### What to design in this pass

Focus on **v0.1**, the surface that has to feel legibly different from existing workbenches on first open. Specifically:

1. **Main application shell** — the chrome that holds everything. Window layout, sidebar, tab bar, status bar. How does the agent activity surface coexist with the user's own workspace?
2. **Schema browser** — left rail. Hierarchical tree of connections → schemas → tables/views → columns. Fast search. Must support an agent pinning annotations to nodes later (v0.3), so think about how annotations would live here even if v0.1 doesn't ship them.
3. **Query editor + results grid** — Monaco editor on top, virtualized results grid (TanStack Table + react-virtual) below. Tabbed. Inline cell editing. JSON sidebar viewer for jsonb columns. Export menu.
4. **Agent activity surface** — *this is the centerpiece.* When the external agent inspects a table, runs a query, or reads a result, the viewer reflects it in real time. Show what the agent is currently focused on (the table, the query, the plan it's reading) alongside a live stream of what it has done. Think split view: focus on one side, activity stream on the other. The user should be able to glance at this and instantly understand "the agent is looking at the `appointments` table and just ran a query joining it to `patients`." Include affordances for permission gates ("Allow this write?") even though full policy UI is v0.2.
5. **Command palette (⌘K)** — fuzzy search across connections, tables, columns, recent queries, commands. The way you navigate the app.
6. **Connection management** — adding/editing Postgres connections, credential storage (OS keychain), TLS toggle, per-connection read-only toggle (visually prominent — read-only connections should look different from writable ones at a glance).

For each surface, deliver:
- A primary layout (annotated)
- Empty / first-run state
- Loading / streaming state (especially for the agent activity surface — agent actions arrive over time, not all at once)
- A high-traffic state (lots of activity, lots of rows, multiple tabs open)
- Keyboard shortcut overlay where relevant

### Hard design constraints

- The agent activity surface must be visible without being demanding. It is ambient when calm, prominent when an action needs human attention (permission gate, error, destructive operation).
- Writes and destructive operations must be visually distinct from reads everywhere they appear — in the activity stream, in the query editor, in permission prompts. Color alone is not sufficient; use shape/iconography too.
- The split between "what the user is doing" and "what the agent is doing" must be obvious. The user should never be confused about whether a query in front of them was theirs or the agent's.
- Replay/session UI is v0.2 but should be anticipated — leave room in the shell for a timeline scrubber to appear later without redesigning everything.

### Out of scope for this pass

No cloud/collaboration UI. No billing or auth surfaces beyond local credentials. No web responsive layouts — this is a desktop app. No EXPLAIN ANALYZE visualizations, hypothesis notebooks, or test-data-generation flows yet (those are v0.3).

### Deliverables

High-fidelity mockups (or component-level designs) for the surfaces above, with a short rationale for each major layout choice. Where you make a judgment call between two reasonable options, name the alternative and say why you didn't pick it. Call out anything in the source doc that I should resolve before you can design further — particularly the open questions around permission-gate UX in the bulk case and the activity surface in pixels.

---

## Notes for using this prompt

- Hand-off works best one surface at a time. Replace the "What to design in this pass" section with a single item (e.g., just the agent activity surface) for a focused iteration.
- If you want a specific aesthetic reference, append it — e.g., "Lean toward the visual language of Linear and Raycast" or "Reference Beekeeper Studio's restraint."
- For v0.2+ surfaces (session replay, permission policy editor, hypothesis notebooks, schema graph), spawn a new pass with the same shell context and a different scope block.
