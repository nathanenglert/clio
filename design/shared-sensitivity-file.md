# Shared sensitivity file

Reviewed sensitivity decisions (redact as PHI/PCI/PII, or safe) live in a JSON file that
connections link to. Check the file into the app's repo next to its migrations and every
environment (local, dev, prod) and every teammate reuses one review instead of repeating
it. Builds on [redaction.md](redaction.md); classifications stay per-connection in the
metadata SQLite, and the file is the shared source the scan applies to them.

## Principle: the file can add redaction freely, never remove it silently

An entry that redacts applies on the next scan. An entry that marks a column safe turns
redaction off, so it never applies on its own: it waits in the review panel until a human
accepts it for that connection. Anyone who can edit the file (a teammate, a merge, an
agent with write access to the repo) can make more columns redact, but can't make an
agent see a column the human hasn't accepted as safe.

## The file

```json
{
  "version": 1,
  "schemas": {
    "public": {
      "leads": {
        "notes": { "status": "redact", "category": "pii" },
        "status": { "status": "safe", "type": "text" }
      },
      "patients": {
        "ssn": { "status": "redact", "category": "pii" }
      }
    }
  }
}
```

- Nested `schemas → tables → columns`, matched to live columns by exact name.
- `redact` carries a category. `safe` carries the column's type
  (`format_type(atttypid, NULL)`), and applies only while the live column has that type,
  the same way a local safe mark resets when a column changes type.
- Only reviewed decisions go in the file. Pending suggestions are the scanner's output
  and are recomputed per environment.
- Clio writes the file sorted, one column per line, so diffs read well in a PR. Writes are
  atomic (temp file, then rename).
- An unknown `version`, a `redact` without a category, or a `safe` without a type is a
  parse error. The whole file is rejected, not the one entry.

## Linking

The link is per connection (`sensitivity_files` in the metadata SQLite: connection id →
absolute path). Several connections can link the same file. The review panel links and
unlinks; the connection must be open.

- **Link file…** picks an existing file. **Create file…** picks a new path.
- Linking merges this connection's reviewed decisions for columns the file doesn't list
  into the file, then rescans so the file's redactions apply.
- Unlinking leaves the connection's classifications as they are.

## Scan

When the connection is linked, every scan (connect, and the agent path's rescans)
reads the file first. For each file entry whose column exists:

| File says | Local state | Result |
|---|---|---|
| redact C | none / pending / safe / confirmed | Confirmed as C, reason "from the shared file" |
| safe T, type matches | safe | nothing |
| safe T, type matches | pending / confirmed | stays redacted, listed as *waiting* |
| safe T, type differs | any | ignored |

Columns the file doesn't list follow the normal scan. File redactions count as redacting
for view inheritance in the same scan.

A linked file that is missing or doesn't parse fails the scan, exactly like a scan that
can't read the catalog: the human keeps using the connection, agents are refused it until
the file is fixed or unlinked, and the panel shows the error.

## Write-back

On a linked connection, review actions write the file first, then the local
classification. If the file write fails, nothing changes.

- Confirm, Redact, manual add, and a category change on a confirmed column write
  `redact`.
- Mark safe and Mark table safe write `safe` with the live type.
- Category changes on pending columns don't write.

## Freshness on the agent path

Each scan records the linked file's modification time and size. Before an agent's SQL
runs, a changed file triggers a rescan (the same path that handles schema drift), so a
redaction someone adds to the file, in any connection, applies before that agent's next
query. Clio's own writes update the recorded stamp when nothing else changed the file.

## Review panel

Below the summary line:

- Unlinked: `Not shared · [Link file…] [Create file…]`.
- Linked: the file's path and `[Unlink]`, or the read error.
- When columns are waiting: a group headed `Marked safe in the shared file` with
  `[Accept all]`, one row per column with its local reason and `[Accept]`. Accepting is
  Mark safe.

The post-connect toast says how many columns are waiting, with `Review`.

## Not covered

- Schema-name mapping between environments (`tenant_a` ↔ `tenant_b`). Names must match.
- Two environments whose types differ for the same column: each Mark safe rewrites the
  type, and the other environment then ignores the entry.
- Agents can't link, unlink, accept, or write the file: none of it is an MCP tool.
