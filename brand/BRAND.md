# Handoff: Clio Brand (v0.1)

The Database App now has a name: **Clio**. This is a brand layer applied on top of the existing v0.1 surfaces — not a redesign. Nothing about layout, color, density, or interaction changes. What changes is the name, the mark, a handful of copy substitutions, and a couple of small chrome additions.

> **Read this alongside the main app handoff (`../design_handoff_database_app/README.md`).** That document is authoritative for tokens, screens, interactions. This one only describes the brand layer.

---

## About the design files

The files in this bundle are **HTML design references** — an interactive prototype of the brand system, rendered on a pannable canvas. They are **not production code to copy**.

Open `Clio Brand.html` in a browser to see every artboard live. Pan/zoom; double-click any artboard to focus it. The canvas is organized as: Why Clio → Wordmark → Mark → Glyph system → In the product → Voice → Do/Don't.

The task is to implement these changes in the Tauri + React codebase using its existing patterns. Match the SVG construction exactly (numbers below); match the copy substitutions exactly (table below).

## Fidelity

**High-fidelity.** Every measurement is intentional. The mark in particular is parametric — there is one correct construction (see [The mark](#the-mark)) and you should reproduce it as a single React component used at every size.

---

## The thesis (one paragraph for context)

Clio is the Muse of history — the witness, the record-keeper. The product's job is the same: the external agent writes the queries, the human gates the writes, **Clio holds the record so neither of you have to guess.** Three verbs power everything else:

- **Witness** — see every query the agent runs (read, write, schema, destruct)
- **Keep** — every action becomes an entry in the record; nothing is lost
- **Look back** — scrub the record; replay any moment

Wherever the old design said "activity log", "session", or "audit", the new design uses **the record**.

---

## Design tokens (no change)

The brand uses the existing `styles/tokens.css` unchanged. The brand's single color is `--agent` (`#d4915a`) — the same copper that already identifies the external agent. **No new colors. No new fonts.** The brand reuses:

- `--font-ui` Geist (chrome, body)
- `--font-mono` Geist Mono (wordmark, technical text)
- `--font-serif` Source Serif 4 (agent's voice, Clio's framing words)
- `--agent` `#d4915a` (the copper dot, everywhere the brand appears)

If you find yourself reaching for a token that doesn't exist, stop — the brand should never introduce one.

---

## The wordmark

```
clio·
```

- **Family** `Geist Mono`
- **Weight** `500`
- **Case** lowercase always
- **Tracking** `-0.02em`
- **Dot** a true round dot, `0.18em` diameter, color `var(--agent)`, gap `0.08em` from the final letter, vertically baseline-aligned

### When to draw the dot

- **With dot** — the wordmark stands alone. App icon, marketing, cover, About dialog.
- **Without dot** — the wordmark is followed by another mono token separated by `·`. Title bar, status bar, breadcrumbs, CLI prompt. Example: `clio · lassomd-staging · public`. The separator dot already does the job; doubling it looks like a typo.

### Reference React component

```jsx
const ClioWord = ({ size = 56, weight = 500, dot = true }) => (
  <span style={{
    fontFamily: 'var(--font-mono)',
    fontSize: size, fontWeight: weight, lineHeight: 1,
    letterSpacing: '-0.02em', color: 'var(--text-primary)',
    display: 'inline-flex', alignItems: 'baseline',
  }}>
    clio{dot && (
      <span style={{
        display: 'inline-block',
        width: '0.18em', height: '0.18em',
        borderRadius: '50%', background: 'var(--agent)',
        marginLeft: '0.08em',
      }} />
    )}
  </span>
);
```

---

## The mark

A half-circle opening right — the **lunate** `ϲ` (how C was drawn in ancient inscriptions) — paired with a single copper dot to the right of the opening. Reads as: the C of Clio, an open parenthesis, a clay-tablet curve, a crescent watching, a record left unclosed.

### Parametric construction

**The viewBox is fixed at `80 × 80`. Construction values are constants in viewBox units, NOT derived from render size.** This is what holds the proportions steady at every size — same trick a typeface uses.

| Property        | Value (viewBox units) | Ratio of mark width |
|---|---|---|
| Arc center      | `(40, 40)`            | — |
| Arc radius      | `28`                  | 35% |
| Stroke width    | `20`                  | **25%** |
| Stroke linecap  | `round`               | — |
| Arc geometry    | half-circle, opens right; endpoints at `±60°` from center | — |
| Dot center      | `(67, 40)` (`cx + r - 1`, `cy`) | — |
| Dot radius      | `9`                   | **22.5%** |
| Dot color       | `var(--agent)`        | — |

Derived ratios that should hold at every size:
- **stroke ÷ mark width = 25%**
- **dot ø ÷ mark width = 22.5%**
- **dot ø ÷ stroke ≈ 0.9** (the dot reads as one stroke-weight)

### Reference React component

The canonical implementation. **Pass only `size`** — never override stroke or dotSize unless you specifically want an outline-only marketing variant.

```jsx
const Lunate = ({
  size = 80,
  color = 'var(--text-primary)',
  dot = true,
  dotColor = 'var(--agent)',
}) => {
  const r = 28, cx = 40, cy = 40;
  const x1 = cx + r * Math.cos(-Math.PI / 3);
  const y1 = cy + r * Math.sin(-Math.PI / 3);
  const x2 = cx + r * Math.cos( Math.PI / 3);
  const y2 = cy + r * Math.sin( Math.PI / 3);
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" style={{ display: 'block' }}>
      <path
        d={`M ${x1} ${y1} A ${r} ${r} 0 1 0 ${x2} ${y2}`}
        fill="none" stroke={color} strokeWidth={20} strokeLinecap="round"
      />
      {dot && <circle cx={cx + r - 1} cy={cy} r={9} fill={dotColor} />}
    </svg>
  );
};
```

### Mark sizes

| Use                       | Render size |
|---|---|
| Favicon                   | 16 px (dot fuses with curve — acceptable; reads as a bead) |
| Inline chrome (title bar, status bar) | 13–14 px |
| Dock header               | 14 px |
| Section eyebrow inline    | 16 px |
| Empty-state hero          | 88 px |
| Cover / About             | 120 px |

**Don't hand-tune values at any size above 12px** — the parametric construction is the answer.

### Lockups

Three only. No others.

1. **Horizontal** — `Lunate(36) · 12px gap · ClioWord(32)`. App icon, header.
2. **With tagline** — `Lunate(44) · 16px gap · stack of [ClioWord(32) / mono tagline 10px]`. Marketing, About dialog.
3. **Stamp** — `Lunate(14) · 8px gap · mono name`. Window chrome, status bar.

Use only these. Don't invent vertical lockups, badge variants, or full-bleed treatments.

---

## Glyph system

One motif (half-circle + line + dot), six expressions. These extend — they do **not** replace — the existing `OpGlyph` system (●  ■  ◆  ▲) that marks read / write / DDL / destruct operations. Op glyphs keep their job inline with SQL; brand glyphs appear in **chrome and empty states**.

All glyphs share the `var(--agent)` copper dot. Default canvas is 24×24, stroke `~size/14`, dot radius `~size/18 × 1.2`. See `components/clio-brand.jsx` → `Glyph` for the source.

| `kind`       | Construction                                   | Means                                    |
|---|---|---|
| `open`       | The lunate mark itself                         | The record is open                       |
| `entry`      | Single horizontal line + dot at left           | One event in the record                  |
| `chronicle`  | Three stacked lines (middle accented) + dot    | The session — many entries kept in order |
| `witness`    | Eye-like crescent + dot inside opening         | Something the agent did, observed        |
| `lookback`   | Backward arc + arrow + dot                     | Scrub to an earlier moment (v0.2)        |
| `kept`       | Rounded square with text lines + dot          | Persisted; saved into the record         |

---

## In-product changes (this is what you actually ship)

These are the only places the existing v0.1 surfaces change. Everything else stays as designed in `design_handoff_database_app/`.

### 1. Window title bar (top chrome, 36 px)

Centered title slot now contains:

```
[Lunate 13px, var(--text-secondary)]  clio  ·  {connection}  ·  {schema}
```

- The lunate is rendered at 13 px in the title-bar foreground color (`--text-secondary`).
- Wordmark uses mono, `12 px`, **no trailing dot** (separator dot is doing that job).
- Followed by connection name and schema, separated by `·` with 8 px margins.

### 2. Status bar (bottom chrome, 24 px)

Left-most chip is new:

```
[Lunate 9px, var(--text-muted)]  record · {HH:MM} · {N} entries
```

- Lunate at 9 px in `--text-muted`.
- Text in `--font-mono`, `10 px`, `--text-muted`.
- `HH:MM` = elapsed session time. `N` = entries in today's record.
- After this chip, a `1px × 12px` divider (`--line-soft`), then the existing connection pill, then existing right-side content unchanged.

### 3. Empty / first-run state

Centered column, `gap` 28 px:

1. `Lunate(88)`
2. Serif H1 — **"A workbench you watch from."** — Source Serif 4, 32 px, weight 500, line-height 1.2, max-width 460 px
3. Body — 13.5 px, `--text-secondary`, line-height 1.65, max-width 440 px: *"Connect a Postgres database, then point your coding agent at it. Clio keeps the record of every query it runs and lets you gate any write before it touches the database."*
4. Two buttons in a row: primary **"Connect a database"** (`⌘N`) and ghost **`Glyph(lookback, 14)` Open a past record**.
5. Mono hint, `--text-faint`: `⌘K open palette · ? shortcuts`

### 4. Connecting / loading state

Centered, `gap` 28 px:

1. `Lunate(56)` with a second `Lunate(56, dot=false, color=--text-secondary)` overlaid at 18% opacity — the faint "past records" ghost.
2. Serif italic 18 px: *"Opening the record…"*
3. Three-dot progress indicator drawn as a row of entries: `[line] [dot] [line] [dot] [line] [dot]`, middle dot copper.
4. Mono diagnostic line in `--text-faint`: `negotiating tls · verify-full · 192.168.0.42:5432`.

### 5. Agent dock header

The dock chrome (above the focus zone, see existing handoff) gains a left-aligned `Lunate(14)` followed by the title **"Today's record"** (12 px, weight 500). Right-aligned mono meta: `{HH:MM} · {N} entries`. The focus zone and stream rows below are unchanged from the existing handoff.

---

## Voice & copy substitutions

The app stays **engineer-clean** by default — `412 rows · 124 ms` is still how the body talks. Exactly **one literary touch per surface, never two.** Serif (Source Serif 4) is reserved for:

- The agent's voice (already established in the existing handoff)
- Modal titles
- Clio's framing words: *the record · kept · witnessed · look back*

### Substitution table

Apply these globally. The left column is the current copy in the v0.1 designs / strings file; the right column is the new copy.

| Old (generic)          | New (Clio)                            |
|---|---|
| Activity log           | Today's record                        |
| Session                | Chronicle                             |
| No events yet          | The record is empty.                  |
| Connect a database     | Open a database to begin a record.    |
| Replay session         | Look back →                           |
| Audit                  | Kept                                  |
| Agent activity here    | Witnessed here                        |
| Connecting…            | Opening the record…                   |
| Saved                  | Entered into the record               |
| Past session           | Past record · 14:22, two days ago     |

These are **product strings**, not marketing copy — they appear in the actual UI. Pull them into your i18n catalog (or wherever strings live) verbatim.

---

## Do · Don't

### Do

- Lean on the lunate and the dot. They're the whole identity.
- Use serif sparingly — agent's voice, modal titles, Clio's framing words.
- Keep the agent's copper sacred. Brand chrome borrows it only as a dot.
- Talk about "the record" where you used to say "activity log".
- Stay engineer-clean by default. Earn each literary touch.

### Don't

- No laurel wreaths, columns, togas, or Greek-key patterns.
- No Trajan, no museum-poster typography. Clio isn't classical — she's **archival**.
- Don't personify Clio. She is the app, not a chatbot persona. The agent is "Claude Code"; Clio is the room they're working in.
- Don't put Clio's mark on user-authored UI (query results, schema browser content, etc.). Chrome only.
- Don't use the lunate as decoration. It's the mark, not a flourish.
- Don't introduce new colors, fonts, or sizes. Brand is a thin layer over the existing tokens.

---

## Files in this bundle

- `BRAND.md` — this document
- `Clio Brand.html` — the brand canvas. Open in a browser to view every artboard live.
- `components/clio-brand.jsx` — React source for every brand artboard. Search this for any spec the doc undersells; the JSX is authoritative on layout numbers.
- `components/primitives.jsx` — shared primitives the brand canvas reuses (`AgentBadge`, `OpGlyph`, `StatusPill`, `TrafficLights`, `Kbd`, `AgentEdge`, `Icons`). Provided so the HTML runs; **don't** re-derive components from this — use the patterns described in the main app handoff.
- `design-canvas.jsx` — the pan/zoom canvas host. Pure presentation infrastructure for the prototype; nothing to ship.
- `styles/tokens.css` — the existing app tokens. Identical to `../styles/tokens.css`; included so the HTML is self-contained. **Do not duplicate these in your codebase** — there is one tokens file across both handoffs.

---

## Implementation order (suggested)

1. Add `Lunate` and `ClioWord` as React components in your shared UI module. Use them everywhere the brand appears — do not inline SVG copies.
2. Apply the copy substitution table to your strings catalog in one PR.
3. Add the title-bar and status-bar chrome changes.
4. Replace the empty, loading, and dock-header layouts per the specs above.
5. Add the brand `Glyph` set as a single component with a `kind` prop. Wire `lookback` into the empty state; the rest land as v0.2 surfaces ship.

That's it. Five steps to ship Clio v0.1.
