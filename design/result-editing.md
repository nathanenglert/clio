# Result editing

Direct manipulation of query results — inline cell edit, add row, delete row — with a
**staged transactional model**. Companion to `README.md`; deepens the brief "Cell edit"
subsection there.

---

## Principle: no surprise writes, no orphaned ergonomics

Every mutation passes through three gates before it touches the database:

1. **Local stage.** Edits, adds, and deletes accumulate in a pending batch attached to the
   result tab. Nothing is sent to Postgres yet.
2. **Visible diff.** The pending-changes tray is always visible whenever the batch is
   non-empty. The user can never accidentally forget that uncommitted work exists.
3. **Reviewable SQL + transaction.** Commit opens a modal showing the exact
   multi-statement SQL the app will run, wrapped in `BEGIN; … COMMIT;`. Destructive
   statements re-use the existing approval flow.

The whole point of inline editing is speed. The whole point of staging is safety. Both
must coexist: typing should feel as fast as a spreadsheet; *committing* should feel like
shipping a small, deliberate transaction.

---

## When the grid is editable

A result is **editable** iff *all* of the following hold:

- The query was a `SELECT` (or `WITH … SELECT`) against a **single base table** — no
  joins, no aggregates, no `GROUP BY`, no set ops.
- The result includes a usable **row identifier**. In order of preference:
  1. The table's primary key column(s).
  2. A unique constraint (any single unique or composite unique key).
  3. The Postgres `ctid` system column — always implicitly available; the app re-issues
     the query with `, ctid` appended when no PK/unique is found, hidden from the user.
- The active connection's policy permits writes. Read-only connections never show edit
  affordances regardless of query shape.

Otherwise the grid is read-only and renders a banner above the toolbar:

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ⓘ  Read-only result · spans multiple tables                       [ Why? ]  │
└──────────────────────────────────────────────────────────────────────────────┘
```

Reason strings (one of):

- `spans multiple tables` — joins, set operations
- `aggregated or grouped` — GROUP BY, aggregates, DISTINCT ON
- `no primary key or unique row identifier` — base table has none
- `view without underlying rules` — querying a view that's not updatable
- `read-only connection` — connection policy blocks writes

The `Why?` link opens a small popover with one-paragraph plain-English explanation and
links to the relevant docs.

---

## Cell edit (extends `README.md` §"Cell edit")

The existing spec stays — same inset editor, same agent border, same mono input, same
implied-SQL tooltip. Two changes:

- `⏎` **stages** the change instead of writing it. The tooltip verb still reads
  `UPDATE patients SET phone_e164 = '+1 510 555 0103'`, but with a leading prefix
  `will UPDATE`. `Esc` cancels the in-progress edit. `⌘Z` undoes the last staged change
  (whether or not the cell is currently being edited).
- The cell, once staged, shows a **2px left-edge `--op-write` stripe** inside the cell
  to mark it dirty. Hover reveals a 10px tooltip `was: '+1 415 555 0142'`.

```
┌───────┬─────────────┬─────────────┬────────────────────────────┬─────────────┐
│  #    │ first_name  │ last_name   │ phone_e164                 │ email       │
├───────┼─────────────┼─────────────┼────────────────────────────┼─────────────┤
│   1   │ Maya        │ Okonkwo     │▌+1 510 555 0103            │ maya@…      │  ← dirty (copper stripe)
│   2   │ Ravi        │ Sundaram    │ +1 415 555 0188            │ ravi@…      │
└───────┴─────────────┴─────────────┴────────────────────────────┴─────────────┘
```

Cells revert visually if undone. Original values are preserved on the staged batch.

---

## Add row

**Triggers** (any of):

- `[+ Add row]` button in the result toolbar, right of `[Export]`.
- `⌘N` while the grid has focus.
- Click the **ghost row** rendered as the last grid row when the grid is editable
  (italic `--text-faint` placeholder, single `+` glyph in the row gutter).

**Behavior:**

- A new row appears at the bottom of the data, **above** the ghost row.
- Row gutter shows `+` glyph in `--op-write` color.
- Each cell renders as its type-aware editor (see below). The first NOT-NULL cell
  receives focus.
- NOT-NULL columns are decorated with a small 4px amber dot to the left of the column
  header until they have a value.
- Columns with a `DEFAULT` show the default expression in `--text-muted` as a
  placeholder (e.g., `now()`, `gen_random_uuid()`). Empty + has-default ⇒ commits as
  literal DEFAULT. Empty + no-default + NOT-NULL ⇒ blocks commit with inline error.
- `Tab` / `Shift+Tab` move between cells; `⏎` commits the row to the staged batch and
  immediately opens a fresh add-row beneath it (rapid bulk-insert ergonomics). `Esc`
  discards the in-progress row.

```
┌───────┬─────────────┬─────────────┬────────────────────────────┐
│ 12,840│ Maya        │ Okonkwo     │ +1 510 555 0103            │
│   +   │ ___________ │ ___________ │ ___________                │  ← new row (copper stripe)
│   +   │             │             │                            │  ← ghost row (placeholder)
└───────┴─────────────┴─────────────┴────────────────────────────┘
```

---

## Delete row

**Triggers** (any of):

- Select one or more rows (`Click`, `Shift+Click`, `⌘+Click`), then press `⌫` or `Del`.
- Right-click → `Delete row(s)`.
- Hover gutter → click the `▲` glyph that fades in.

**Behavior:**

- Deleted rows stay in place, struck-through, with `--op-destruct` tint.
- Row gutter shows the destructive triangle `▲` (matches the design system's destructive
  shape — *never* a red square).
- Hover anywhere on a deleted row to reveal an inline `[Undo]` button.
- `⌘Z` undoes the most recent delete.

```
┌───────┬─────────────┬─────────────┬────────────────────────────┐
│   3   │ Lena        │ Brückner    │ +1 415 555 0166            │
│   ▲   │ Yusuf       │ el-Hassan   │ +1 415 555 0177            │  ← deleted (struck, red tint)
│   5   │ Brigit      │ Halloran    │ +1 510 555 0144            │
└───────┴─────────────┴─────────────┴────────────────────────────┘
```

---

## Pending-changes tray

A 36px strip that slides up from above the status bar **only when the batch is
non-empty**. Full window width — not docked to the active result pane, because pending
work persists when the user switches tabs and we want that to be unmissable.

```
┌────────────────────────────────────────────────────────────────────────────────────────┐
│ ▢ 2 edits   ▢ 1 add   ▲ 1 delete   ·   patients @ lassomd-staging   ·   uncommitted   │
│                                                  [ Review SQL ]   [ Commit ]   [ ⨯ ]  │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

- Background `--bg-panel`, top border `--line-default`.
- Op counts use the design system glyphs in their op colors:
  `▢` (write) for edits + adds, `▲` (destruct) for deletes. If zero, the segment is
  omitted, not greyed out.
- Middle segment names the affected table + connection. If a batch spans multiple
  tables — possible via multiple add-rows across tabs — show `3 tables` instead.
- `[Review SQL]` opens the review modal (see below). `[Commit]` is the primary action,
  uses `--op-write` outline. `[⨯]` is Discard, fires a confirmation.
- The tray is sticky-visible across tab switches and connection switches. Switching
  connection with pending changes prompts: *"You have uncommitted changes on
  lassomd-staging. Stay there?"*

### Multi-tab batching

The batch is keyed by `(connection, table)`. Multiple tabs editing the same table share
a batch. Multiple tabs editing different tables show a summary tray (`3 tables · …`);
clicking expands a popover listing per-table counts and per-table Commit buttons.

This matches how a user thinks: *"these changes belong together"* is per-table, not per
visible grid.

---

## Review SQL modal

Triggered by `[Review SQL]` from the tray. Centered modal, 720px wide.

```
┌─ Review · 4 statements · lassomd-staging ──────────────────────────────────────┐
│                                                                                │
│   BEGIN;                                                                       │
│                                                                                │
│   UPDATE public.patients                                                       │
│     SET phone_e164 = '+1 510 555 0103'                                         │
│     WHERE id = 'M0048221';                                                     │
│                                                                                │
│   UPDATE public.patients                                                       │
│     SET email = 'maya.o+new@example.com'                                       │
│     WHERE id = 'M0048221';                                                     │
│                                                                                │
│   INSERT INTO public.patients (id, first_name, last_name, dob)                 │
│     VALUES ('M0048841', 'Alex', 'Cho', '1990-04-12');                          │
│                                                                                │
│   DELETE FROM public.patients                                                  │
│     WHERE id = 'M0048216';                                                     │
│                                                                                │
│   COMMIT;                                                                      │
│                                                                                │
│   ⚠ 1 destructive statement — DELETE will be re-confirmed before running.      │
│                                                                                │
│                                              [ Copy SQL ]   [ Cancel ]   [ Commit ]
└────────────────────────────────────────────────────────────────────────────────┘
```

- SQL rendered with the same syntax-coloring used in the query editor.
- Verbs colored by op kind (`UPDATE`/`INSERT` in `--op-write`, `DELETE` in `--op-destruct`).
- If any DELETE/TRUNCATE present, the modal includes the warning line and `Commit`
  triggers the existing destructive approval flow (`README.md` §"Agent activity").
- `[Copy SQL]` copies the full statement block — useful for review, sharing, or running
  manually elsewhere.

---

## Commit flow

1. App opens a single transaction on a dedicated connection-pool handle.
2. Runs the statements in **stage order** (the user's authoring order — preserves intent
   if one edit depends on a previous add).
3. If any statement fails: `ROLLBACK`, surface the failure in a banner over the tray
   (`Commit failed: column "phone_e164" check constraint violated`), and **leave the
   batch intact** so the user can fix and retry.
4. On success: tray collapses, dirty markers clear, the underlying query re-runs to
   refresh the grid (so newly inserted rows appear with real server-assigned defaults
   like `uuid_generate_v4()` and `now()`).

**Concurrency:** the `WHERE` clause on every UPDATE/DELETE includes the row identifier
*plus* the original `ctid` captured at SELECT time. If `ctid` no longer matches, the
statement updates zero rows — the commit fails with `row changed since you loaded it`
and offers `[Refresh and re-stage]` or `[Force overwrite]`. (Force overwrite re-issues
the statement without the ctid predicate.)

---

## Type-aware editors

Full set in v0. The editor used per cell is determined by the column's
`information_schema.columns.data_type`:

| Type                                | Editor                                                       |
| :---------------------------------- | :----------------------------------------------------------- |
| `boolean`                           | Segmented control: `True · False · NULL`                     |
| `date`, `timestamp`, `timestamptz`  | Date picker popover; mono input fallback for keyboard entry  |
| `jsonb`, `json`                     | Opens the existing JSON sidebar (`⌘⇧J`) in edit mode         |
| `text` (length > 80 chars in cell)  | Expandable multiline popover with mono code editor styling   |
| Enum types                          | Dropdown of allowed values, with NULL as an explicit option  |
| `integer`, `numeric`, `decimal`     | Mono input with input mask (numbers only, optional sign)     |
| `uuid`                              | Mono input; `[Generate]` link in the editor footer           |
| Everything else                     | Plain mono input (matches existing cell edit)                |

**NULL handling, universal:** every editor surfaces a `[Set NULL]` button in its footer.
Empty string and NULL are *not* the same — the bool segmented control makes this
explicit by giving NULL its own segment; other editors make it a one-click action.

---

## Keyboard

| Key       | Action                                                    |
| :-------- | :-------------------------------------------------------- |
| `⏎`       | Edit active cell / commit in-progress edit / commit add-row |
| `Esc`     | Cancel in-progress edit (no stage)                        |
| `Tab` / `⇧Tab` | Move to next/prev cell in add-row                    |
| `⌘N`      | Start a new add-row                                       |
| `⌫` / `Del` | Delete selected rows (stage)                            |
| `⌘Z`      | Undo last staged change                                   |
| `⌘⇧Z`     | Redo last undone change                                   |
| `⌘⏎`      | Commit (opens review modal first if any DELETE)           |
| `⌘⇧K`     | Discard all staged changes (with confirm)                 |

---

## Edge cases

- **Switching tabs with pending changes:** tray stays visible, no prompt — pending work
  is per-table-and-connection and persists.
- **Switching connection with pending changes:** prompt to stay. Connection switch is a
  destructive nav for staged work.
- **Closing the app with pending changes:** prompt to commit, discard, or cancel.
  Default is Cancel.
- **Result re-runs while editing:** the user pressed Refresh. If batch is empty, just
  re-run. If batch is non-empty, prompt: *"Refreshing will reset 3 staged changes.
  Continue?"*
- **Schema change between SELECT and Commit:** if a column was dropped, the statement
  fails at commit and the user gets a clear error. We do not try to auto-migrate the
  staged change.
- **Very large batches (>500 statements):** show a warning in the review modal and
  recommend committing in chunks. We still execute as one transaction.

---

## Backend contract

This requires a new Rust command alongside the existing `run_query`:

```rust
pub async fn apply_mutations(
    core: &Core,
    conn: &str,
    batch: MutationBatch,
) -> Result<MutationOutcome>
```

- `apply_mutations` is *not* gated by `validate_select_only`. It runs in a transaction.
- It enforces: connection policy (read-only check), per-statement structural validation
  (single-table, has identifier predicate), and the destructive-approval handshake for
  DELETE/TRUNCATE.
- The MCP server keeps its existing read-only posture. Agents cannot reach
  `apply_mutations`. This is a Tauri-only command, exposed via the same IPC the rest of
  the app uses.

---

## Out of scope for v0

- **Bulk paste from spreadsheet** — paste TSV/CSV directly into the grid. v0.2.
- **Foreign-key-aware add row** — autocomplete a FK column from a popover of referenced
  rows. v0.2.
- **Constraint preview before commit** — running the SQL as a savepoint to check for
  constraint violations before showing the review modal. v0.2.
- **Multi-row edit (paint same value across selection)** — v0.2.
- **Agent-staged edits** — see follow-up question; currently human-only.
