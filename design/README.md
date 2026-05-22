# Handoff: Database App (v0.1)

A native desktop Postgres workbench built for a single role: **a backend/full-stack engineer supervising an external coding agent** (Claude Code, Cursor, etc.) as it works on a real database. The human is not typing queries — the agent is. The human is watching, gating writes, and intervening.

This document hands off the v0.1 design surface to a developer implementing the Tauri + React app.

---

## About the design files

The files in this bundle are **HTML design references** — interactive prototypes showing intended look and behavior. They are **not production code to copy**.

The task is to recreate these designs in **Tauri + React** (the chosen stack), using whatever component library and styling approach the codebase settles on. The HTML is a fidelity reference for layout, color, type, and motion — not a starting point to fork.

The full design canvas (`Database App.html`) is the single source of truth. Open it and pan/zoom; every artboard is labelled by surface and state.

## Fidelity

**High-fidelity.** Every measurement, color, weight, and corner radius in the prototypes is intentional. Reproduce pixel-for-pixel where reasonable. The exception is platform chrome (the macOS traffic lights are stylized SVG in the prototype — the real app should use Tauri's native window decorations).

## Stack

- **Tauri** for the desktop shell. Native menus, OS-level shortcuts, OS keychain for credential storage.
- **React** for UI. TypeScript strongly recommended.
- **Monaco** for the SQL editor (autocomplete, syntax, multi-cursor — don't roll your own).
- **TanStack Table + TanStack Virtual** for the results grid (100k+ rows must be smooth).
- **Postgres connection** via `tokio-postgres` or `sqlx` on the Rust side, with a typed IPC bridge to the React frontend.
- The external agent connects via a local IPC server the app exposes — the agent sends its intended SQL through this channel and receives results back. The app inserts policy checks at this layer.

---

## Design tokens

All tokens live in `styles/tokens.css`. Reproduce them in your styling layer (CSS variables, Tailwind config, or styled-components theme).

### Surfaces (warm dark — the canonical theme)

| Token | Value | Use |
|---|---|---|
| `--bg-canvas` | `#151310` | Deepest backdrop |
| `--bg-app` | `#1a1714` | App body, query editor |
| `--bg-panel` | `#1f1c18` | Sidebars, status bar, dock chrome |
| `--bg-elevated` | `#25211c` | Cards, popovers, hover |
| `--bg-elevated-2` | `#2b2721` | Nested cards, active row |
| `--bg-input` | `#1a1714` | Inputs, code editor |
| `--bg-overlay` | `rgba(10, 8, 6, 0.72)` | Modal scrim |

Light theme exists but is secondary; design it later by lightening these values and flipping text. **Dark is canonical.**

### Lines

`--line-faint` `rgba(255, 240, 220, 0.05)` · `--line-soft` `0.08` · `--line-default` `0.12` · `--line-strong` `0.20`

Lines are warm-tinted white at low alpha, never pure gray. They get warmer/brighter as they get more prominent.

### Text

| Token | Value |
|---|---|
| `--text-primary`   | `#ebe4d8` (warm off-white) |
| `--text-secondary` | `#a89f8f` |
| `--text-muted`     | `#6e6759` |
| `--text-faint`     | `#4a4538` |

### Agent identity — copper

This is the most important color in the system. **The agent owns it.** It must never appear on user-initiated UI.

| Token | Value | Use |
|---|---|---|
| `--agent`        | `#d4915a` | Agent badge, agent dot, edge marker |
| `--agent-soft`   | `#8a5a36` | Hover/dim agent elements |
| `--agent-dim`    | `#4a3320` | Borders inside agent zones |
| `--agent-wash`   | `rgba(212, 145, 90, 0.08)` | Background tint for any agent zone |
| `--agent-wash-hi`| `rgba(212, 145, 90, 0.14)` | Hover/active agent zone |
| `--agent-line`   | `rgba(212, 145, 90, 0.32)` | Borders around agent zones |
| `--agent-glow`   | `0 0 0 1px rgba(212, 145, 90, 0.35), 0 0 24px -6px rgba(212, 145, 90, 0.35)` | Attention-getter |

### Op semantics (color + shape — never color alone)

Color-blind-safe. Every op-type indicator carries both a color and a shape glyph.

| Op kind | Color | Shape | Use |
|---|---|---|---|
| `read`     | `#7fa886` | circle    | `SELECT`, `EXPLAIN` |
| `write`    | `#d4a155` | square    | `INSERT`, `UPDATE` |
| `ddl`      | `#b591c4` | diamond   | `CREATE`, `ALTER` |
| `destruct` | `#d96c54` | triangle  | `DELETE`, `DROP`, `TRUNCATE` |

Each has a `*-soft` variant (`rgba(…, 0.14)`) for fills.

### Status

`--status-ok` `#7fa886` · `--status-pending` `#d4a155` · `--status-blocked` `#d96c54` · `--status-idle` `#6e6759`

### Type

| Family | CSS var | Use |
|---|---|---|
| Geist        | `--font-ui`    | All UI |
| Geist Mono   | `--font-mono`  | Code, SQL, identifiers, data, timestamps, kbd |
| Source Serif 4 | `--font-serif` | **Sparing accents only** — modal titles, the agent's natural-language voice (e.g. "Reconciling lead → patient conversion"), cover slide |

Geist Mono uses font-feature-settings `'zero', 'ss02'` for the slashed zero. Geist UI uses `'cv11', 'ss01', 'ss03'`.

Type scale (px): `11 / 12 / 13 / 14 / 16 / 20 / 28`. Body is 13.

Line-height 1.45 for UI; 1.55 for paragraph copy; 1.65 for code.
Letter-spacing -0.005em for UI; -0.015em for serif headings.

### Radii

`4 / 6 / 10 / 14` — `--r-sm`, `--r-md`, `--r-lg`, `--r-xl`. Most elements use 5 or 6.

### Shadows

```
--shadow-sm: 0 1px 2px rgba(0,0,0,0.25);
--shadow-md: 0 4px 16px rgba(0,0,0,0.35), 0 1px 2px rgba(0,0,0,0.25);
--shadow-lg: 0 24px 64px rgba(0,0,0,0.55), 0 2px 8px rgba(0,0,0,0.4);
```

---

## The two laws of this product

These bind every decision below.

1. **The agent has a color. The user does not.** The agent's presence is always identifiable — copper wash, hex glyph, left-edge stripe — anywhere it appears. User-initiated content uses default chrome and never wears the agent color. There must never be a moment of doubt about who initiated what.

2. **Destructive operations carry shape, not just color.** A red square is not a destructive marker; a red triangle is. The shape system (`OpGlyph`) is everywhere ops appear — the activity stream, the query editor toolbar, permission cards, the policy editor.

---

## Application shell

The window is the workspace, not a tool. Optimized to be open all day on a second monitor.

### Layout (1440 × 900 reference)

```
┌─────────────────────────────────────────────────────────────────────┐
│ ⋅ ⋅ ⋅      title (centered, with agent dot)         search shield │ ← chrome 36px
├──────────────┬──────────────────────────────────────┬───────────────┤
│ schema rail  │  tab bar (36px)                       │ agent dock   │
│ 260px        ├──────────────────────────────────────┤ 340px         │
│              │  query editor                          │              │
│              │  (Monaco) ~200px                      │ focus + stream│
│              ├──────────────────────────────────────┤               │
│              │  results grid                          │              │
│              │  (TanStack + react-virtual)            │              │
├──────────────┴──────────────────────────────────────┴───────────────┤
│ status bar 24px · connection · pool · tx · agent · policy           │
└─────────────────────────────────────────────────────────────────────┘
```

All zones are independently resizable. Persist widths in app state per connection.

### Window chrome (36px)

- macOS traffic lights left, padded 12px from window edge.
- Centered title shows `database · schema` (e.g. `lassomd-staging · public`). Optional 10px mono subtitle below (`postgres 16.4`).
- A 6px copper dot precedes the title **when the agent is active in any tab** — this is the smallest possible always-on signal.
- Right side: search icon (⌘P), shield icon (open policy editor), `AgentBadge` (links to the dock; pulses while agent is running).
- Use Tauri's native window chrome on Linux/Windows. macOS uses Tauri's custom titlebar set to `transparent` with the traffic lights overlaid.

### Sidebar — schema rail (260px default)

See **Schema browser** section for the tree itself. Resizable 200–400px. Toggle with `⌘B`.

### Tab bar (36px)

- Tabs are `max-width: 220px`, ellipsis the label.
- Tabs whose content was authored by the agent get a left-edge copper stripe (`AgentEdge`) and a copper icon. The label still renders in user chrome — the stripe is the marker.
- Dirty indicator: 5px circle in `--text-secondary` to the right of the label.
- Close button only on hover.
- Right-most `+` tab opens the command palette in "new tab" mode.

### Status bar (24px) — `<StatusBar>`

| Region | Content | Notes |
|---|---|---|
| Left | `● connection-name · postgres 16.4` | Green dot = healthy |
| | `14 conn · idle 12 · active 2` | Pool stats, mono |
| | `tx: none` or `tx: active 4s` | Active transaction indicator |
| Right | `● agent active · 3 queued` | Copper dot; only present when agent is connected |
| | `UTC −08:00` | Local timezone of the user |
| | `policy: read-any · write-public` | **Click to open the policy editor.** Engineers read this the way they read git branch. |

Separator: `│` in `--line-strong`, 1px high.

---

## Schema browser

The left rail. Hierarchical: connection → schemas → tables/views → columns.

### Hierarchy

```
● lassomd-staging  [RW]            ← connection header
  prod.lassomd.internal             ← mono subtitle in --text-muted
  [refresh icon]

  [⌘P  Filter schema…]              ← search input

  ▾ PUBLIC                    7      ← schema collapsible, uppercase 11px
    ⊟ patients              12,840  ● pin
    ⊟ appointments         231,008  ●
    ⊟ providers                 38
    ⊟ leads                  4,728  ●
    ⊟ visits                89,142
    ⊟ insurance_claims     120,891
    ⊟ prescriptions         43,200
    ⊟ lead_sources             14   (view — dashed icon)
    ⊟ patient_summary       12,840  (view)

  ▾ AUDIT                     2
    ⊟ change_log              8.4M
    ⊟ access_log             24.1M

  ▾ REPORTING                 2
    ⊟ daily_metrics           1,247 (view)
    ⊟ cohort_retention        −     (matview)
```

### Visual rules

- Table names are **mono** (12px, `--font-mono`) — engineers copy/paste them constantly.
- Schema headers are uppercase 11px `--font-ui`, 0.02em letter-spacing, semibold.
- Active table: `--bg-elevated` background, 2px left-edge marker in `--text-secondary`.
- Views/matviews: same icon as tables but with `stroke-dasharray: 2 1.5`, color `--op-ddl`.
- Row count is mono 10px `--text-muted`, right-aligned.

### Agent-touched dot (5px, `--agent`)

Any table the agent has read or written in the current session shows a 5px copper dot right of the table name. Hover tooltip: `agent read 4 times · last 14:22`. Wears off when the agent disconnects.

### Agent annotations (v0.3 — design now, ship later)

When the agent pins a note to a table or column, two things happen in the rail:
1. A copper pin glyph (`Icons.pin`) appears next to the node.
2. The note expands inline in the rail (not a separate inspector), with:
   - Copper wash background, left-edge stripe
   - Hex glyph + "Note · `<table>`" header
   - Timestamp right-aligned
   - 2–3 line note text in `--text-secondary`

The shell already reserves room for these. **Implement the data model now** so v0.3 doesn't reshape the tree.

### Search state (⌘P)

- Search input gains the agent-glow shadow when focused.
- Results group by type: Tables, Columns, Views.
- Match term highlighted with `rgba(212, 145, 90, 0.22)` background.
- Columns show as `public.visits · appointment_id`.

### Table detail (right panel, opens on click in some flows)

400px wide. Tabs: **Columns** · Indexes · Constraints · Triggers · Activity.

Columns list shows:
- Key icon (gold) for primary key
- `↳` for foreign key
- Index icon for indexed columns
- Column name in mono
- `NULL` badge for nullable
- Type in mono `--text-muted`, right-aligned

A copper-washed footer at the bottom shows agent activity on this specific table: "Agent activity here — 4 reads · 14:22", with last query snippet.

---

## Query editor

Monaco-based. SQL syntax highlighting tuned to this palette.

### Toolbar (32px)

```
[▶ Run  ⌘↵]   [Format  ⌥⇧F]   [EXPLAIN]                  [SQL · UTF-8 · LF]
```

- Run button background: `--op-read-soft` for SELECT-only, `--op-write-soft` for writes, `--op-destruct-soft` for destructive. Border 1px in matching op color at 0.3 alpha. Label changes to "Run · destructive" for destructive queries.
- The destructive variant is **mandatory** — the toolbar must telegraph the danger of running this query before you click.
- All buttons are 22px tall, 11px font.

### Agent-authored queries

When the agent wrote the query (vs. the user typing):
- The entire editor zone gets a copper wash background and a left-edge copper stripe (`AgentEdge`).
- The toolbar shows a small `AgentBadge` ("written by agent") in the right region.
- The tab itself shows the copper stripe and copper icon.

### Syntax highlighting

```
SQL keyword:      #c98a72  weight 500    (SELECT, FROM, WHERE, JOIN)
SQL function:     #d4a155                (count, now, lower)
SQL string:       #9ab38a                ('literals')
SQL number:       #b591c4                (42, 3.14)
SQL identifier:   #c4b89c                (column/table refs)
SQL comment:      #6e6759  italic        (-- comments)
SQL operator:     #a89f8f                (=, >, <)
SQL destructive:  var(--op-destruct)  weight 600   (DELETE, DROP, TRUNCATE)
SQL write:        var(--op-write)     weight 500   (INSERT, UPDATE)
```

### Line numbers

`--text-faint` (`#4a4538`), right-aligned in a 24px gutter, mono, no separator line.

### Editor body

- Code: Geist Mono 12.5px, line-height 1.65.
- Selection: `rgba(212, 145, 90, 0.18)`.
- Cursor: 1.5px wide, `--agent` when agent-typed, `--text-primary` when user-typed.

---

## Results grid

TanStack Table + react-virtual. Must stay smooth at 100k+ rows.

### Result toolbar (30px)

```
[● 12,840 rows · 86 ms]   │   select * from patients … LIMIT 200      [Filter] [Export] [⟳]
```

- Status pill on left with `StatusPill tone="ok"`.
- Echoed query in mono, `--text-muted`, ellipsed.
- Buttons on right are 22px, the standard editor button style.

### Header row (28px)

- Sticky top.
- Background `--bg-panel`.
- Column name in mono, then a small index glyph (`Icons.index`) if indexed, then type label right-aligned in `--text-faint` 10px.
- 1px right border between columns in `--line-faint`.
- Row counter column on far left: 40px wide, right-aligned, mono, `--text-faint`, header label `#`.

### Body rows (28px)

- Mono 11.5px.
- Alternating background: even rows `rgba(255, 240, 220, 0.012)`, odd rows transparent. **Almost imperceptible** — keep it subtle, this is a tool not a spreadsheet.
- Cells ellipsis on overflow.
- `null` values render as italic `null` in `--text-faint`.
- `jsonb` values render in `--op-ddl` (the schema color — JSON is structure).
- Active cell: `rgba(212, 145, 90, 0.14)` background, 1px inset copper border.

### Cell edit

Click or `⏎` to edit a cell:
- An inset editor floats over the cell with a 2px `--agent` border.
- The mono input retains its mono font and size.
- Below the cell, a 10px tooltip in `--text-muted` shows the implied SQL: `UPDATE patients SET phone_e164 = …`. The verb is colored by op kind.
- `⏎` commits, `Esc` cancels. Both keys are shown as Kbd badges in the tooltip.

**The implied SQL preview is non-negotiable.** Users must always know what the edit will become. This is the "no surprise writes" contract applied to direct edits.

See **[`result-editing.md`](result-editing.md)** for the full editing model: when the grid is editable, dirty-cell stripe, add row, delete row, the pending-changes tray, the review-SQL modal, type-aware editors, and the backend transactional contract.

### JSON sidebar (jsonb viewer)

Right-side panel, 320px, toggleable with `⌘⇧J`.

- Header (30px): JSON icon (in `--op-ddl`), column name in mono, `· row N`, close button.
- Body: pretty-printed JSON, mono 11.5px, indented 16px per level.
- Keys in string color (`#9ab38a`), values colored by type.

### Filter and Export

Filter opens a popover with column-by-column filter inputs. Export menu offers CSV, JSON, SQL `INSERT`s.

---

## Agent activity surface — the centerpiece

**This is the differentiator. Get this right; the rest is table stakes.**

### Two shapes were explored. Ship A; keep B as a minimize target.

**A · Right dock (340px)** — the canonical surface. Persistent panel.

**B · Bottom strip/drawer** — implement as the "collapsed" state when the user dismisses the dock. The strip is 36px and lives between the workspace and status bar. It re-expands to a full bottom drawer on click, but the right dock should be the default open state.

**C · Inline annotations** — explored but **not shipped in v0.1**. Markers floating in the workspace look clever but are too easy to miss when grid scrolls. Reserve as a v0.2 addition that complements the dock rather than replacing it.

### Right dock structure

```
┌────────────────────────────────────────────────┐
│ ⬡ Agent · Claude Code            [⟲] [⋯]       │ ← header 32px
├────────────────────────────────────────────────┤ ← copper-wash zone begins
│ [● Claude Code · pulsing]      06:42 elapsed   │
│                                                 │
│ Reconciling lead → patient conversion          │ ← serif heading 15px
│ Looking at leads and patients joined on        │
│ phone_e164. Found 218 leads marked expired…    │
│                                                 │
│ ● 4 reads  ·  ▢ 1 write  ·  ▲ 1 awaiting       │ ← op summary
├────────────────────────────────────────────────┤
│ ACTIVITY ─────────────────────── 6 events      │
│                                                 │
│ ▲ DELETE                            14:23:18    │
│   leads WHERE created_at < now()…              │
│   ⚠ awaiting your approval                     │ ← red wash row
│                                                 │
│ ▢ UPDATE                            14:23:02    │
│   leads SET status = 'qualified'               │
│   1 row · 8 ms                                  │
│                                                 │
│ ● SELECT                            14:22:34    │
│   appointments WHERE patient_id IN…            │
│   412 rows · 124 ms                             │
│                                                 │
│ … (more)                                       │
├────────────────────────────────────────────────┤
│ ⌘⇧A nudge agent                ⌘. pause        │ ← compose hint
└────────────────────────────────────────────────┘
```

### Focus zone (top of dock)

- Copper wash background, copper bottom border.
- Pulsing copper badge "Claude Code".
- Elapsed timer mono in `--text-muted` right-aligned.
- Heading in `--font-serif` 15px. **This is one of two places serif appears in the whole app** — it's the agent's voice, literate, like reading prose from a competent peer.
- Body paragraph in `--text-secondary` 11.5px; embedded `<code>` spans in mono `--text-primary`.
- Op summary chips at bottom: glyph + count, separated by middle dots in `--line-strong`.

### Stream rows

Each row is 8–10px vertical padding, 14px horizontal.

```
[op glyph]   VERB                                   14:22:34
             query / target detail (mono)
             N rows · M ms  ·  [optional warning chip]
```

- The op glyph is 10px, vertically centered in a 12px-wide rail. Implicitly forms a left-edge timeline.
- The verb (`SELECT`, `UPDATE`, `EXPLAIN`, etc.) is mono 11px, colored by op.
- The detail line is the SQL snippet or what the agent inspected, mono 11px, `--text-secondary`, wraps.
- The meta line (rows / ms) is mono 10px, `--text-muted`. Hide if irrelevant.
- **Awaiting-approval rows** get a `rgba(217, 108, 84, 0.06)` row background and a red warning chip on the right of the meta line.
- 1px `--line-faint` separator between rows.

### Live indicator

A small copper dot in the section divider (`ACTIVITY ─── live · N events`) with `box-shadow: 0 0 6px var(--agent)` pulses while events stream.

### Attention escalation

When a permission gate appears:
1. The dock's title bar gets a `border-left: 1px solid var(--op-destruct)` and a red pulsing dot.
2. A `PermissionCard` (see below) renders inline in the stream.
3. The status bar agent dot turns red.
4. If the dock is collapsed to the bottom strip, the strip background goes red and gains a "Review →" button.

### Bottom strip (collapsed state)

36px high, full width, between workspace and status bar.

- Calm state: copper wash background, copper top border.
- Attention state: red wash, red top border, "Agent is waiting on you" in red, "Review →" button on the right.

### Bottom drawer (expanded state)

When the strip is clicked / `⌘\`:
- Drawer slides up to ~280px (resizable).
- Internal layout: focus pane on left (340px, copper wash), stream on right.
- Tab bar at top: Stream / Focus / Session / Policy.
- The drawer can replace OR supplement the right dock depending on user preference. **v0.1: drawer is the alternative to the dock, not in addition. Either-or.**

### `AgentRail` (inline variant — DEFERRED to v0.2)

Designed but don't ship in v0.1. A 28px vertical strip between the schema rail and the workspace, showing the agent's stream as op glyphs only. Hover to expand. Pair with floating `AgentInlineMarker` chips over the workspace.

---

## Permission gates

The most consequential UI in the app. Designed around a **policy-based** model:

> Pre-approve patterns. Anything outside the active policy prompts the human.

Default policy:
- `READ`: any table — **allow, no prompt**
- `WRITE` to `public.*`, ≤1000 rows/stmt — **allow, no prompt**
- `WRITE` to `audit.*` or `reporting.*` — **prompt always**
- Schema change (CREATE/ALTER) — **prompt always, show diff**
- Destructive (DELETE/TRUNCATE/DROP) — **prompt always, show impact estimate**
- `DROP TABLE` / `DROP SCHEMA` — **block; user must disable the rule to allow**

### Single-statement permission card

Rendered inline in the agent dock when an operation requires approval.

Visual structure:
```
┌──────────────────────────────────────────┐
│ ▲ PERMISSION REQUIRED · DESTRUCTIVE 6/6  │
│                                           │
│ ┌──────────────────────────────────────┐ │  ← deviation banner
│ │ Outside policy. Policy allows write  │ │     (red-dashed border)
│ │ to public.*, but disallows DELETE    │ │
│ │ without a row-count limit.           │ │
│ └──────────────────────────────────────┘ │
│                                           │
│ I want to clean up 218 expired leads…    │  ← agent's natural language
│                                           │
│ ┌──────────────────────────────────────┐ │
│ │ DELETE FROM leads                    │ │  ← mono SQL preview
│ │ WHERE created_at < now() - …         │ │     dark input bg
│ │   AND status = 'expired';            │ │
│ └──────────────────────────────────────┘ │
│                                           │
│ ⚠ Estimated impact: ~218 rows            │
│                                           │
│ [Allow this one time ⏎] [Deny Esc] [Mod] │
│                                           │
│ ☐ Allow similar DELETE with created_at < │
│   filter for this session                │
└──────────────────────────────────────────┘
```

- Top border 1px solid op color (red for destruct, gold for write); left border 3px.
- Deviation banner only renders when the action is outside policy. Background `rgba(217, 108, 84, 0.08)`, 1px dashed `rgba(217, 108, 84, 0.35)`.
- The "Allow this one time" button is the op color (red or gold) with `#1a1714` text. 32px tall.
- "Deny" button uses the standard secondary button style. Bound to `Esc`.
- "Modify" lets the user edit the SQL before allowing.
- The session-pattern checkbox lets the user widen policy without leaving the prompt — critical for cases where the agent legitimately needs a new pattern.

### Bulk migration permission

For multi-statement plans (e.g. a 14-statement migration), one dialog classifies every statement against the current policy:

- Header: op-kind glyph + "MIGRATION · N STATEMENTS · M TABLES" + estimated total row impact.
- Title (serif 18px): the agent's plain-English description of the migration.
- Statement list, numbered (mono `01`, `02`, …):
  - Each row: index · op glyph · SQL snippet (one line, mono) · ALLOW or PROMPT badge
  - Rows that deviate get a red row background and an explanation under the SQL (e.g. "writes to audit.* — outside policy").
- Footer: "**2 statements deviate from policy. The agent will pause and ask again before each one.**"
- Primary action: "Approve N of M, prompt for the rest" — runs the in-policy ones, pauses on each deviation.
- Secondary action: "Reject all".
- Checkbox: "Wrap entire migration in a transaction · roll back on any denial" — checked by default.

### Policy editor

A focused modal listing every rule:
- Op kind (glyph + label)
- Target pattern (mono, e.g. `public.* only · max 1000 rows / stmt`)
- Verdict pill: `ALLOW` (green), `PROMPT` (gold), `BLOCK` (red)
- Detail line

Footer: "3 session overrides · expire on disconnect" + Reset + Add rule.

### Session overrides

When the user approves with the "for this session" checkbox, a new override is created with the same shape as a policy rule but with a session-scoped expiry. Status bar policy chip should append `+ N overrides` when any are active.

---

## Command palette (⌘K)

The navigational spine.

Width 640px, max-height 420px, centered ~30% from top of window.

### Search bar (52px)

- 16px search icon, `--text-muted`.
- 15px query text in `--text-primary`. Caret is 1.5px wide, `--agent`, blinking at 1Hz.
- Mode tabs on the right: `[All]` and `[Ask agent]`. The "Ask agent" tab uses copper wash and copper text when active.

### Result groups

Each group has an 11px uppercase header in `--text-muted` 0.08em letter-spacing. Groups for the **All** mode, in this order:

1. **Tables** — direct table matches
2. **Columns** — column matches, showing `table.column · type`
3. **Recent queries** — last 50 queries, color-tagged by author (you/agent)
4. **Commands** — actions like "Run query", "Pause agent", "Connect to…"

### Result row (selected state)

- `--bg-elevated-2` background, 6px radius.
- 2px `--agent` left edge (the standard agent-edge bar — even on user actions, because the palette is the focal point).
- Left icon in the appropriate color (`--agent` for agent-authored items, `--text-muted` for everything else).
- Title in 12.5px UI font (or mono for queries/identifiers).
- Subtitle in 10.5px `--text-muted`.
- Keyboard hint right-aligned, mono 10px, in a 6px-radius pill on the active row.

### "Ask agent" mode

When the user invokes `⌘⇧A` or clicks the "Ask agent" tab:
- Header tab toggles to "Ask agent" with copper accent.
- Results become natural-language suggestions:
  - "Explain this table"
  - "Find rows by description"
  - "Suggest an index"
- And recent agent sessions: "Reconcile leads → patients", "Backfill appointment reasons" (each with elapsed time, action count, pending count).

### Footer (32px)

Mono 10.5px hints in `--text-muted`: `↑↓ navigate · ⏎ open · ⌘⏎ run · ⌥⏎ open agent on …`. Right: "Esc to close".

---

## Connection management

A modal — never a full-screen surface. Width 720px.

### Connection list

Each connection card:

- 32px square icon: green-tinted lock for read-only, gold-tinted database glyph for read-write.
- Connection name (13px, weight 500).
- **`READ-ONLY` chip** (green) or **`READ/WRITE` chip** (gold). The chip is mono, 10px, semibold, 0.05em letter-spacing.
- `· CONNECTED` chip (green) on the active connection.
- Subtitle: `host · tls · postgres 16.4` mono `--text-muted`.
- Right-aligned: Edit button, kebab menu.

The active connection gets a 2px green left edge and `--bg-elevated-2` background.

### Read-only is the safe default

In the edit form, the "Read-only" radio is **selected by default** for any new connection. The selected option is wrapped in a green-bordered card that explicitly states what read-only does:

> *Window chrome will be tinted green. Writes and DDL are rejected at the client layer before they reach Postgres. The agent cannot escalate without re-authenticating.*

The "Read / write" option lives below, smaller, less emphasized. You have to actively choose it.

### Form fields

- Name, Host, Port (120px wide), Database, User, Password (with "stored in macOS keychain" affordance — lock icon + text below the field).
- SSL/TLS: a green toggle, defaulting **on**. Verify mode (`verify-full`) and root CA noted next to it.
- Test connection / Save buttons at the bottom right.

### Read-only enforcement at the chrome level

When connected to a read-only connection, the window chrome (the top 36px) gains a subtle green tint border and the title shows `READ-ONLY` next to the database name. The agent cannot run writes — they fail at the client before reaching Postgres.

---

## Empty / first-run state

Shown when no connection is open.

- Centered, max-width 480px.
- 64px square copper-washed icon with the hex agent glyph (32px).
- Serif heading: "A workbench you watch from."
- Body: "Connect a Postgres database, then point your coding agent at it. You'll see every query it runs, every row it reads, and gate any write before it touches the database."
- Primary button: dark filled, "Connect a database" with the `+` icon and `⌘N` kbd.
- Secondary button: outlined, "Restore a session" with the database icon.
- Below: hints `⌘K open palette · ? shortcuts`.

The schema rail is hidden in this state. So is the agent dock. The status bar shows `no connection · no agent`.

---

## Loading / streaming states

### Connecting

A centered three-dot indicator (middle dot fully lit, outers at 0.4 opacity, animation cycles which one is lit). Mono caption: `negotiating TLS · verify-full`. Below: connection signature in 10px mono.

### Agent streaming (in the dock)

- The live dot in the activity section header pulses with a 1.5s box-shadow animation.
- New rows fade in from `opacity: 0` over 200ms with a 8px upward translate.
- The focus zone's heading and body update in place; no re-mount, just transition.

### Permission-gate awaiting

- Card pulses a soft `box-shadow: 0 0 0 0 var(--op-destruct)` outward over 2s, looping.
- The status bar dot animates 1Hz between full red and `0.5` alpha.

### High-traffic state

The shell stays calm even with 8+ tabs, 100k rows, and agent queued ops. Things to honor:
- Tab bar scrolls horizontally past 8 tabs; no wrapping.
- Results grid uses TanStack Virtual so the DOM stays small.
- Activity stream caps at 50 visible events; older ones collapse into a "show N earlier events" row.
- Status bar shows `agent active · N queued` to telegraph how much is in flight.

---

## Keyboard shortcuts

Every action must be reachable without the mouse. Show the full reference with `?`.

### Navigation
- `⌘K` — Command palette
- `⌘P` — Quick open table
- `⌘⇧P` — Quick open column
- `⌘1–9` — Jump to tab N
- `⌘\` — Toggle agent dock / drawer
- `⌘B` — Toggle schema rail
- `⌘⇧J` — Toggle JSON viewer

### Editing
- `⌘↵` — Run query / selection
- `⌘⇧↵` — Run all queries in tab
- `⌥⇧F` — Format SQL
- `⌘/` — Toggle comment
- `⌘D` — Add cursor at next match
- `F2` — Rename symbol

### Agent
- `⌘⇧A` — Nudge / ask agent (opens palette in agent mode)
- `⌘.` — Pause agent
- `⏎` — Approve pending (when permission card is focused)
- `Esc` — Deny pending
- `⌘⇧.` — Open policy editor
- `⌘⇧H` — Open session timeline (v0.2)

### Results
- `⌘F` — Filter result set
- `⌘E` — Export…
- `⌘C` — Copy cell
- `⌘⇧C` — Copy as JSON
- `⏎` — Edit cell
- `⌘Z` — Undo cell edit

### Kbd visual style

Inline `<kbd>` is mono 10px, minimum 18px wide, 18px tall, `--bg-elevated` background, 1px `--line-default` border, 4px radius, `--text-secondary` color. Dim variant (no background, no border) is used inline in dense help text.

---

## Anticipating v0.2 — replay / session scrubber

The shell must leave room for a timeline scrubber without redesigning.

- The agent dock header has an `Icons.history` button — clicks open the session timeline.
- The bottom drawer has a "Session" tab — that's where the scrubber lives.
- A horizontal track at the top of the drawer (`min-height: 56px`) shows op glyphs along a timeline; click a point to scrub.
- When scrubbing, the workspace shows the database state at that point (read-only). A subtle non-canonical chrome tint warns: "you are viewing a past state."

Don't build any of this in v0.1 — but **don't paint yourself into a corner** with layout assumptions that block it.

---

## Out of scope (don't implement)

- Cloud sync, accounts, billing.
- Web responsive — desktop only.
- `EXPLAIN ANALYZE` visualization (v0.3).
- Hypothesis notebooks, test-data generation (v0.3).
- Multi-cursor mirroring across users (collaboration).
- Inline `AgentInlineMarker` floating chips (v0.2 at earliest — designed but not shipped).

---

## State management notes

This is a Tauri app; most state is local-first.

### Per-window state
- Active connections, with credentials in OS keychain
- Open tabs and their content
- Schema cache per connection
- Agent session log (in-memory; persisted to a session file)

### Persisted (across launches)
- Connection list (no credentials)
- Recently used schemas/tables/queries
- Window size, pane widths
- Policy rules per connection
- Theme preference (dark default)

### Agent IPC

Spec the IPC contract before building anything:

```
agent → app : { id, kind: 'read'|'write'|'ddl'|'destruct', sql, intent: <natural language> }
app   → agent : { id, verdict: 'allow'|'deny'|'modified', sql?: <modified-sql>, reason?: string }
agent → app : { id, result: { rows, ms, error? } }
app   → ui   : { type: 'agent-event', entry: <StreamRow> }
```

The verdict roundtrip is **synchronous from the agent's perspective** — the agent waits for `allow` before running. The UI's job is to surface the prompt fast (<100ms after the agent's message) and bind the verdict back to the source.

### Policy evaluation

Pure function: `(rule[], sql, target) → 'allow' | 'prompt' | 'block'`. Unit-testable, lives on the Rust side. The UI just reads the verdict and renders the prompt.

---

## File map of this handoff

```
design_handoff_database_app/
├─ README.md                      ← this file
├─ result-editing.md              ← inline editing model (staged tray, add/delete row, review modal)
├─ Database App.html              ← the design canvas — open this first
├─ design-canvas.jsx              ← canvas host (DesignCanvas / DCSection / DCArtboard)
├─ styles/
│  └─ tokens.css                  ← every design token, ready to copy
├─ screenshots/                   ← static PNGs of every artboard (see below)
└─ components/
   ├─ primitives.jsx              ← Icon, OpGlyph, WindowChrome, AgentBadge, Kbd, Pin
   ├─ data.jsx                    ← fake schema + rows + agent log for the mocks
   ├─ surfaces.jsx                ← SchemaTree, TabBar, QueryEditor, ResultsGrid, StatusBar
   ├─ editing.jsx                 ← EditableResultsGrid, PendingTray, ReviewModal, ReadOnlyBanner
   ├─ agent.jsx                   ← AgentDockRight, AgentStripBottom, AgentDrawerBottom,
   │                                AgentRail, AgentFocus, StreamRow, PermissionCard
   ├─ overlays.jsx                ← CommandPalette, ConnectionManager, PolicyEditor,
   │                                ShortcutsOverlay
   ├─ callouts.jsx                ← Inline annotation system (CalloutPin, CalloutNotes)
   ├─ app-shell.jsx               ← FullShell composer
   ├─ artboards-system.jsx        ← Visual system reference artboard
   └─ artboards.jsx               ← All other sections / artboards
```

### Screenshot index

Static PNGs in `screenshots/` for quick browsing. The HTML canvas is still the source of truth — open it for layout details, hover states, and inline annotations.

| # | File | Surface |
|---|---|---|
| 01 | `01-sys-ref.png` | Visual system reference — tokens, type, vocabulary |
| 02 | `02-sys-empty.png` | First-run empty state |
| 03 | `03-shell-primary.png` | **Application shell · primary (right-dock agent)** |
| 04 | `04-shell-notes.png` | Inline rationale for the shell |
| 05 | `05-shell-empty.png` | Shell state · empty |
| 06 | `06-shell-loading.png` | Shell state · connecting |
| 07 | `07-shell-heavy.png` | Shell state · high traffic (8 tabs, agent queued) |
| 08 | `08-schema-default.png` | Schema browser · default |
| 09 | `09-schema-annotated.png` | Schema browser · with agent annotation (v0.3 preview) |
| 10 | `10-schema-search.png` | Schema browser · searching (⌘P) |
| 11 | `11-schema-detail.png` | Schema browser · table detail panel |
| 12 | `12-schema-notes.png` | Schema browser · rationale |
| 13 | `13-editor-user.png` | Editor + grid · user query (clean chrome) |
| 14 | `14-editor-agent.png` | Editor + grid · agent query (copper wash) |
| 15 | `15-editor-json.png` | Editor + grid · JSON sidebar (jsonb) |
| 16 | `16-editor-edit.png` | Editor + grid · inline cell edit |
| 17 | `17-dock-calm.png` | Agent surface · right dock · calm |
| 18 | `18-dock-attention.png` | Agent surface · right dock · permission gate |
| 19 | `19-drawer-strip.png` | Agent surface · bottom strip · calm |
| 20 | `20-drawer-attention.png` | Agent surface · bottom strip · attention required |
| 21 | `21-drawer-open.png` | Agent surface · expanded drawer |
| 22 | `22-inline-calm.png` | Agent surface · inline annotations (v0.2+) |
| 23 | `23-inline-attention.png` | Agent surface · inline annotations · with hover preview |
| 24 | `24-palette-global.png` | Command palette · ⌘K · global |
| 25 | `25-palette-agent.png` | Command palette · ⌘⇧A · ask agent mode |
| 26 | `26-conn-list.png` | Connection manager · list |
| 27 | `27-conn-edit.png` | Connection manager · edit (read-only emphasis) |
| 28 | `28-policy.png` | Policy editor |
| 29 | `29-permission-single.png` | **Permission gate · single statement** |
| 30 | `30-permission-bulk.png` | **Permission gate · 14-statement migration** |
| 31 | `31-shortcuts-overlay.png` | Keyboard shortcuts overlay (?) |

### How to use the canvas

1. Open `Database App.html` in a browser.
2. Each section is a horizontal row of artboards. Pan with right-click drag; zoom with scroll.
3. Double-click an artboard label to open it fullscreen (Esc to close).
4. Numbered pin callouts inside artboards correspond to numbered notes in the adjacent "Notes" artboard.

### Open questions to resolve with the design lead

1. **Resizable vs fixed-width dock?** Current design assumes resizable, persisted per window. Confirm.
2. **Agent identity / branding.** The badge says "Claude Code" — if the app supports multiple agents (Cursor, Copilot, custom), the badge needs an identity-aware shape (maybe a small avatar slot inside the hex).
3. **Read-only chrome tint** — designed as a faint green border on the window chrome. Confirm acceptable vs. something more aggressive (full status-bar tint?).
4. **Light theme** — defined as "exists, secondary." When do we actually design it?

---

## Implementation order (suggested)

1. **Shell + tokens.** Get the window, status bar, schema rail layout, and palette colors in place. Use placeholder content.
2. **Schema browser + connection management.** First user value: connect to a database, see tables, click around.
3. **Query editor + results grid.** Monaco, TanStack. Wire up actual query execution.
4. **Agent IPC bridge.** Local socket; spec'd above.
5. **Activity dock — read-only.** Just stream events into the right dock as they come in.
6. **Permission gates.** Single-statement first, then bulk migration.
7. **Policy editor.**
8. **Command palette.**
9. **Shortcuts everywhere.**
10. **Polish: animations, loading states, empty states.**

Steps 1–4 are the foundation. Steps 5–6 are the differentiator and should not be rushed.
