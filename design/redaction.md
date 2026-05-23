# Sensitivity-aware redaction

Auto-replace values in PHI / PCI / PII columns with **deterministic fake data** at the
Rust data-access layer, before results reach the UI or the MCP response. Companion to
`README.md`; introduces a new policy surface and a new column-metadata system.

---

## Principle: redaction is policy, not display

Three rules bind every decision in this doc.

1. **One redactor, two consumers.** Redaction runs once, in Rust, after the query
   returns from Postgres and before the result leaves the core. Both the UI and the MCP
   server consume the *same* redacted result. There is no second code path that an
   agent could reach.
2. **Joinability is preserved.** Redaction replaces values *after* the database has
   executed the query, so JOIN / WHERE / GROUP BY / aggregates all see real values. The
   replacement is a deterministic function of the real value, so the same real value
   always produces the same fake — across rows, queries, tabs, and sessions.
3. **The mask switch is UI-only.** The user can reveal real values in the workbench UI.
   The MCP server *cannot*. There is no override, no env var, no flag. The agent's view
   of the world is the redacted view, always.

---

## Categories

Three categories ship in v0. They are **labels** — they all use the same Faker-driven
strategy at runtime. Distinct categories exist for review, audit, and future per-category
strategies (e.g., PCI preserving last-4).

| Category | Label color   | Examples                                                    |
| :------- | :------------ | :---------------------------------------------------------- |
| `PHI`    | `--privacy`   | diagnosis, mrn, dob (when health context), clinical notes   |
| `PCI`    | `--privacy`   | card_number, cvv, card_holder_name, billing_address         |
| `PII`    | `--privacy`   | email, phone, ssn, name, dob (when non-health), address     |

All three render with the same chrome (color + glyph) in v0. Auditors who need to slice
by category use the review panel's group-by control. **Strategy per category is *out of
scope* for v0** — every classified column gets type-aware Faker replacement.

### New design tokens

Add to `styles/tokens.css` (mirror in `src/styles/tokens.css`):

```
--privacy:        #7a93a6;
--privacy-soft:   rgba(122, 147, 166, 0.14);
--privacy-line:   rgba(122, 147, 166, 0.32);
--privacy-glyph:  '◌';   /* dotted circle — distinct from op shapes */
```

The color is a muted cool slate-blue chosen to read as "infrastructural" — distinct from
the four op colors and from the agent copper. The glyph is the dotted circle `◌`,
visually meaning "obscured / placeholder" without colliding with read/write/ddl/destruct
shapes (●/▢/◆/▲).

**Pushback welcome on color/glyph choice** — I picked the first non-clashing slot in the
palette; if you'd rather lean into a different cue (e.g., a small mask icon), say so.

---

## Where redaction happens (architecture)

```
                   ┌──────────────────────────┐
                   │       Postgres            │
                   └────────────┬─────────────┘
                                │ real values
                                ▼
                   ┌──────────────────────────┐
                   │   run_query (Rust core)   │
                   │                           │
                   │   ┌───────────────────┐   │
                   │   │   redactor pass   │◀──┼── per-connection policy
                   │   │ (column → fake)   │   │
                   │   └─────────┬─────────┘   │
                   └─────────────┼─────────────┘
                                 │ redacted rows + meta
                       ┌─────────┴──────────┐
                       │                    │
                       ▼                    ▼
              ┌────────────────┐   ┌────────────────┐
              │   Tauri IPC    │   │   MCP tool     │
              │ (UI consumer)  │   │ (agent consumer)│
              │  reveal: bool  │   │ reveal: false  │
              │                │   │   (hardcoded)  │
              └────────────────┘   └────────────────┘
```

The redactor produces both (a) the redacted row set and (b) a `redaction_meta` block
naming which result columns were redacted and why. The UI uses the meta to draw the
glyph; the MCP serializer uses it to annotate the response so the agent knows the data
it received is masked (one short footer line: `note: 3 columns redacted by policy`).

When `reveal: true` (UI only, default off — see [§The mask toggle](#the-mask-toggle)),
the redactor is **skipped entirely** for the UI's copy of the response. MCP responses
are unaffected.

---

## MCP scope: always on, never overridable

Restating because it matters: the MCP server **cannot** request unredacted data. The
toggle does not exist for the MCP code path. This is enforced at the call site of
`run_query` in the MCP tool handler — the `reveal` arg is a compile-time literal
`false`, not configurable.

> *Rationale: the threat model that justifies this whole feature is "an agent connected
> to a sensitive database". Letting any UI control affect what the agent sees would
> defeat it.*

---

## Detection on connect

When a new connection is established (or an existing one reconnects and notices a schema
delta), the core runs a **heuristic classifier** over the schema and produces *suggested*
classifications.

### Heuristic inputs

- **Column name patterns** (most signal): `ssn`, `email`, `phone`, `mobile`, `dob`,
  `birth_date`, `mrn`, `diagnosis`, `card_*`, `cvv`, `address*`, `first_name`,
  `last_name`, `patient_*`, `npi`, etc. Maintained as an editable list in code; not
  user-configurable in v0.
- **Postgres type hints**: `text`/`varchar` columns named generically (`notes`,
  `comments`, `description`) on tables flagged as health/billing get a "review" hint
  but no auto-classification.
- **Comment / COMMENT ON COLUMN**: if a column comment contains `phi`, `pii`, `pci`,
  `sensitive`, or `redact`, treat as a strong signal.

### Suggestion lifecycle

1. Classifier runs, produces a set of `(table, column, category, confidence, reason)`
   tuples.
2. Suggestions are **applied immediately** as classifications — *the safe default is
   that suspected sensitive columns are redacted*. They render in the rail with a
   pending-state badge (`◌` glyph, dashed border) and a `?` superscript.
3. A toast lands in the bottom strip:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ◌  12 columns auto-classified as sensitive on lassomd-staging — [ Review ]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

4. The user opens the review panel ([next section](#review-panel)). Accepting promotes
   pending → confirmed (solid border). Rejecting removes the classification entirely.
5. Until reviewed, suggestions stay live (redacted). This errs toward more redaction,
   matching the "read-only is the safe default" rule from `README.md`.

The classifier never auto-confirms. The only state transitions are: `none → pending`
(classifier), `pending → confirmed | none` (user), `confirmed → none` (user).

---

## Review panel

The configuration surface. Reachable from:

- The post-connect toast (`Review`).
- Status bar policy chip → menu → `Sensitivity…`.
- Command palette: `Sensitivity classifications`.
- Connection management modal → per-connection `…` kebab → `Sensitivity…`.

A focused modal, 800px wide, scrollable list of classified columns grouped by table.

```
┌─ Sensitivity · lassomd-staging ────────────────────────────────────────────────┐
│                                                                                │
│   12 classified · 8 pending · 4 confirmed                                      │
│   [ Group by: Table ▾ ]   [ Filter: All ▾ ]            [ + Add manually ]      │
│                                                                                │
│ ┌─ public.patients ─────────────────────────────────────────────────────────┐ │
│ │                                                                            │ │
│ │  ◌ first_name      text         PII   ?  · matched "name"   [✓] [✗]      │ │
│ │  ◌ last_name       text         PII   ?  · matched "name"   [✓] [✗]      │ │
│ │  ◌ dob             date         PHI   ?  · matched "dob"    [✓] [✗]      │ │
│ │  ◌ phone_e164      text         PII   ✓  · confirmed        [PII ▾] [✗]  │ │
│ │  ◌ email           text         PII   ?  · matched "email"  [✓] [✗]      │ │
│ │  ◌ ssn             text         PII   ?  · matched "ssn"    [✓] [✗]      │ │
│ │    notes           text          —       · review suggested  [Classify ▾]│ │
│ │                                                                            │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│ ┌─ billing.cards ────────────────────────────────────────────────────────────┐ │
│ │  ◌ card_number     text         PCI   ?  · matched "card_*" [✓] [✗]      │ │
│ │  ◌ cvv             text         PCI   ?  · matched "cvv"    [✓] [✗]      │ │
│ │  ...                                                                       │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                │
│                                              [ Reject all pending ] [ Done ]   │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Row anatomy

- Privacy glyph `◌` in `--privacy` color (dashed border when pending, solid when confirmed).
- Column name (mono 12px) · type (mono 11px `--text-muted`) · category pill.
- Category pill: 10px mono, `--privacy-soft` background, `--privacy` text. Pending rows
  show `?` after the pill; confirmed rows show `✓`.
- Reason line in 10.5px `--text-muted` to the right of the pill.
- Per-row actions: `[✓]` confirm (pending only), `[✗]` remove, `[Category ▾]` change
  category (confirmed only).
- Unclassified columns that the classifier flagged as worth reviewing (low-confidence
  hits like generic `notes` fields) show with no glyph and a single `[Classify ▾]`
  button. They are *not* redacted unless classified.

### Group / filter

- **Group by**: Table (default), Category, Status (pending / confirmed).
- **Filter**: All, Pending only, Confirmed only, Unclassified.

### Manual add

`[+ Add manually]` opens a small inline form: pick `table` → pick `column` → pick
`category`. Useful for columns the heuristic missed (e.g., a freeform `notes` field
known to contain PHI).

### Bulk actions

A small toolbar appears when ≥2 rows are selected via row checkbox:
`[Confirm N]` · `[Remove N]` · `[Change category to ▾]`.

---

## Schema rail markers

The schema rail (see `README.md` §"Schema browser") learns one new affordance.

```
  ▾ PUBLIC                    7
    ⊟ patients              12,840  ◌6   ●
    ⊟ appointments         231,008  ◌1   ●
    ⊟ providers                 38
    ⊟ leads                  4,728  ◌3   ●
```

- `◌N` glyph + count appears between row count and the agent dot when a table has any
  classified columns. Color: `--privacy`. Tooltip on hover: `6 sensitive columns ·
  4 PII, 2 PHI · click to review`.
- Pending columns count toward the total; if any pending exist, the glyph border is
  dashed (`stroke-dasharray: 1.5 1.5`).
- Click opens the review panel scrolled to this table.

In the **table detail** column list (`README.md` §"Schema browser" → table detail), each
classified column gets a `◌` glyph left of the column name, in `--privacy`. Tooltip:
`Redacted as PII · matched "email" · click to review`.

---

## Result grid rendering

Classified columns render their fake values inline. The fake **replaces** the real value
in the cell; we do not show both.

```
┌───────┬─────────────┬─────────────┬────────────────────────────┬─────────────────┐
│  #    │ ◌ first_name│ ◌ last_name │ ◌ phone_e164               │ created_at      │
├───────┼─────────────┼─────────────┼────────────────────────────┼─────────────────┤
│   1   │ Lina        │ Patel       │ +1 415 555 0188            │ 2025-06-14 …    │
│   2   │ Hugo        │ Brennan     │ +1 415 555 0142            │ 2025-06-14 …    │
│   3   │ Sade        │ Okafor      │ +1 415 555 0163            │ 2025-06-15 …    │
└───────┴─────────────┴─────────────┴────────────────────────────┴─────────────────┘
```

- The column header gains the `◌` glyph in `--privacy`, left of the column name.
- Cell values render in the same mono/size as normal. **No per-cell glyph** — that
  would be too noisy at 100k rows. The header glyph carries the signal for the column.
- A faint `--privacy-soft` 1px right-edge stripe inside redacted column cells gives a
  peripheral hint without adding chrome to each cell. Off by default if the user finds
  it noisy — single setting in the View menu (`View > Highlight redacted columns`).
- Hover the column header: tooltip `Redacted (PII) · same real value → same fake`.

### Cell edit interaction

The result-editing flow (see `result-editing.md`) needs one addition: **classified
columns are not directly editable in the grid**. The cell shows a small lock glyph on
hover with the tooltip *"Redacted column — edit in the unmasked view (View > Reveal
sensitive data)"*. We do not write fake values back to the database, ever.

When the user has revealed (toggle on), editing works normally on real values.

---

## Determinism: same real → same fake

The mapping `real_value → fake_value` is deterministic per column. Mechanism:

```
seed = HMAC_SHA256(connection_secret, table || '.' || column || '|' || real_value)
fake_value = Faker(seed).<generator_for_type>()
```

- `connection_secret` is a 32-byte random value generated when the connection is created
  and stored in the macOS keychain next to the credentials. Different connections → same
  real values produce *different* fakes. Same connection across sessions → stable
  mapping.
- The generator is chosen by the column's `information_schema.columns.data_type`:

| Postgres type                            | Faker generator                                  |
| :--------------------------------------- | :----------------------------------------------- |
| `text` / `varchar` (name-ish columns)    | name (first/last/full chosen by column name)     |
| `text` / `varchar` (email columns)       | email                                            |
| `text` / `varchar` (phone columns)       | E.164-formatted phone                            |
| `text` / `varchar` (address-ish)         | street / city / zip per pattern                  |
| `text` / `varchar` (catch-all)           | lorem-ish opaque string of same length bucket    |
| `date` / `timestamp` / `timestamptz`     | random within ±2 years of real value             |
| `integer` / `numeric`                    | random in same magnitude bucket                  |
| `uuid`                                   | new uuid (still a uuid)                          |
| `jsonb` / `json`                         | `{ "redacted": true }`                           |
| anything else                            | mono string `"<redacted>"`                        |

- For `NULL`: do not fake. `NULL` stays `NULL`. (Otherwise we'd hide that a column was
  empty, which is itself information leakage in the wrong direction.)

The Faker generator is bundled in the Rust core. We do **not** call an external service;
all redaction is in-process and offline.

---

## The mask toggle

A single boolean: **Reveal sensitive data**. Default `off`.

### Where it lives

- **View menu** (Tauri menu): `View > Reveal sensitive data` checkbox item, bound to
  `⌘⌥R` (Cmd+Alt+R). Toggling fires no confirmation dialog — it's reversible and
  only affects the UI. *(Originally specced as ⌘⇧R; switched to ⌘⌥R because
  ⌘⇧R is the WebKit "hard reload" binding and reloaded the page instead of
  firing the menu accelerator in dev mode.)*
- **Status bar policy chip**: when reveal is on, the chip text changes from
  `policy · default` to `policy · default · revealing` with a `--op-destruct` left edge.
  Click → opens the View menu.

### Reveal-on state — the loud indicator

While reveal is on, the user must be unmistakably aware:

```
                                                  ▼ revealing
┌──────────────────────────────────────────────────────────────────┐
│ ● lassomd-staging · pool 4/8 · agent idle  │  policy · revealing │
└──────────────────────────────────────────────────────────────────┘
```

- Status bar policy chip gains a `--op-destruct` left edge and the text suffix
  `· revealing`.
- The result grid drops the `◌` header glyphs (because nothing is masked) but the
  classified columns keep their `--privacy-soft` right-edge stripe. A small persistent
  banner sits above the toolbar of any result tab showing classified columns:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⚠ Showing real values in 3 classified columns. [ Hide ]                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

- `Hide` is a one-click revert to masked. Background `rgba(217, 108, 84, 0.06)`.
- The Tauri menu item shows a checkmark.

### What the toggle does *not* do

- It does not change policy. Classifications remain in place.
- It does not affect MCP responses (restating: MCP always gets redacted data).
- It does not persist across app restarts. Default `off` every launch — the user has to
  reach for the menu intentionally.
- It does not turn on per-table or per-column. All-or-nothing within the current UI
  session. (Per-column reveal is a v0.2 candidate if anyone asks for it.)

---

## Storage: per-connection policy

Classifications attach to the connection record. Existing connection storage gains a new
field:

```rust
pub struct ConnectionConfig {
    // ... existing fields (name, host, port, db, user, role, ssl) ...
    pub sensitivity: SensitivityPolicy,
}

pub struct SensitivityPolicy {
    /// HMAC key for deterministic fake generation. 32 bytes, stored in keychain
    /// alongside the password under key `<conn_name>.redaction_secret`.
    #[serde(skip)]
    pub secret_ref: SecretRef,

    /// Classified columns. Schema-qualified.
    pub classifications: Vec<Classification>,
}

pub struct Classification {
    pub schema: String,
    pub table: String,
    pub column: String,
    pub category: Category,         // PHI | PCI | PII
    pub status: ClassificationStatus, // Pending | Confirmed
    pub reason: String,             // human-readable, from classifier or "manual"
    pub created_at: DateTime<Utc>,
}

pub enum Category { Phi, Pci, Pii }
pub enum ClassificationStatus { Pending, Confirmed }
```

Stored as JSON in the existing connection config file. The secret stays in the keychain.

---

## Backend contract

### New / changed Rust commands

```rust
/// Run heuristic classifier against a connection's schema.
/// Idempotent: called on every connect, and on schema change events.
/// Inserts Pending classifications for new matches; does not touch existing entries.
pub async fn classify_schema(core: &Core, conn: &str) -> Result<ClassifyOutcome>;

pub struct ClassifyOutcome {
    pub new_pending: u32,
    pub already_classified: u32,
    pub total_classified: u32,
}

/// Confirm / remove / change category on a single classification.
pub async fn update_classification(
    core: &Core,
    conn: &str,
    schema: &str,
    table: &str,
    column: &str,
    action: ClassificationAction,
) -> Result<()>;

pub enum ClassificationAction {
    Confirm,
    Remove,
    SetCategory(Category),
    AddManual(Category),
}

/// Existing run_query gains a `reveal` flag.
/// MCP handler hardcodes reveal: false. UI passes the toggle state.
pub async fn run_query(
    core: &Core,
    conn: &str,
    sql: &str,
    reveal: bool,
) -> Result<QueryResult>;

pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,   // each gains `redacted: bool` + optional `category`
    pub rows: Vec<Row>,             // values are pre-redacted when reveal=false
    pub redaction_meta: Option<RedactionMeta>, // present when any column was redacted
    // ... existing fields ...
}

pub struct RedactionMeta {
    pub redacted_columns: Vec<RedactedColumn>,
    pub note: String, // short human-readable, e.g. "3 columns redacted by policy"
}
```

### Redactor placement

The redactor is a **post-processing pass** on the result of the existing Postgres query.
It runs inside `run_query` after row materialization, before the result is serialized
for the IPC or MCP boundary. It does not touch the prepared statement, the query plan,
or the WHERE clause — joinability, filtering, and aggregates use real values.

### MCP enforcement

The MCP `run_query` tool handler is a thin wrapper that calls the core's `run_query`
with `reveal: false`. Compile-time literal, not a parameter the tool exposes.

---

## Edge cases (v0)

- **Derived columns** (e.g., `SELECT first_name || ' ' || last_name AS full_name`): the
  result column does not map to a classified base column, so it is **not redacted**.
  This is the documented limitation; option (a) from the design discussion. The review
  panel and grid have no special treatment for derived columns in v0. Users running
  expressions on PHI/PCI/PII should know what they're doing.
- **`SELECT *`**: each underlying column resolves normally; classified columns get the
  fake treatment.
- **`COUNT(*)` / aggregates on classified columns**: counts and aggregates run against
  *real* values in Postgres. The numeric result is not classified. `COUNT(DISTINCT email)`
  returns the true distinct count.
- **`ORDER BY` on a classified column**: Postgres sorts by real values, so the row
  order in the UI reflects real-value sort even though the visible cells are fake.
  Acceptable — but worth a doc footnote because it can look weird ("why is `Alice` after
  `Zach`?"). No UI mitigation in v0.
- **`NULL`** stays `NULL`; never replaced with a fake.
- **`jsonb` / `json`**: replaced with `{"redacted": true}` wholesale. Per-field
  redaction inside JSON is out of scope.
- **CSV / clipboard export** while masked: exports the masked values. The export menu
  gains a footnote: `Exporting masked values. Toggle View > Reveal to export real data.`
- **Connection disconnect mid-query**: classification policy is loaded once per query
  at the redactor step; mid-query disconnect doesn't change behavior.
- **Schema change** (column dropped / renamed): the classification entry becomes stale.
  The next `classify_schema` call sweeps stale entries (entry has no matching column) and
  removes them silently. Renamed columns produce a new pending suggestion.

---

## Out of scope for v0

- **Value-pattern matching** as a safety net for derived columns (regex for emails / SSNs
  / cards / etc. applied to *any* result value). Powerful for closing the derived-column
  gap, but pattern matching is fragile and slow on large result sets. v0.2 candidate.
- **SQL lineage parsing** to track which result columns derive from which base columns.
  Heavy and fragile. Out indefinitely unless a strong use case appears.
- **Per-category strategies** (e.g., PCI preserving last-4, or PHI keeping date-of-month
  but not year). v0 uses one Faker strategy per type for all categories.
- **Per-column custom strategies** (user-defined Faker generator per column). v0.2 if
  asked for.
- **Unmask audit log** (record every time the user revealed). The threat model is
  "agent leaking", not "user revealing on their own machine" — so this is lower
  priority. v0.2 if asked.
- **Per-column reveal** (reveal one column while keeping the rest masked).
- **Project-shared classification policy** (sync classifications across teammates).
  The current per-connection store is local-only.
- **Redaction of values surfaced in the schema browser sample previews** — once sample
  previews ship, they need to respect this. Note for the schema-browser implementer.

---

## Implementation order (suggested)

1. **Schema + storage**: extend `ConnectionConfig`, add keychain secret, persist
   `SensitivityPolicy`. No UI yet.
2. **Classifier**: heuristic pass, idempotent, callable on connect. Wire to the connect
   command.
3. **Redactor**: post-processing pass inside `run_query`. Deterministic Faker per type.
   Add `reveal` parameter. MCP handler hardcodes `false`.
4. **Result grid**: header glyph + tooltip + (optional) right-edge stripe.
5. **Review panel**: full UX, including toast on connect.
6. **Schema rail**: `◌N` count badge + table-detail column glyphs.
7. **View menu toggle**: `⌘⇧R`, status bar treatment, reveal-on banner.
8. **Polish**: lock affordance on cell edit, export footnote, schema-change sweep.

Each step is independently testable. Step 3 is the load-bearing one — once the
redactor is in place, MCP is protected even before any UI ships.
