//! The shared sensitivity file: reviewed classifications in a JSON file that
//! connections link to, so environments and teammates share one review.
//!
//! See design/shared-sensitivity-file.md. This module owns the format (parse,
//! render, atomic save) and the rule for which safe entries are waiting on a
//! human. Applying the file during a scan lives in core::sensitivity.

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::time::SystemTime;

use crate::types::Category;

const VERSION: u32 = 1;

pub(super) type Key = (String, String, String);

/// One column's reviewed decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", rename_all = "lowercase", deny_unknown_fields)]
pub(super) enum Entry {
    Redact { category: Category },
    /// Safe while the live column has this type (`format_type(atttypid, NULL)`).
    Safe {
        #[serde(rename = "type")]
        type_name: String,
    },
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(super) struct SensitivityFile {
    pub columns: BTreeMap<Key, Entry>,
}

#[derive(Deserialize)]
struct Raw {
    version: u32,
    #[serde(default)]
    schemas: BTreeMap<String, BTreeMap<String, BTreeMap<String, Entry>>>,
}

pub(super) fn parse(text: &str) -> Result<SensitivityFile> {
    let raw: Raw = serde_json::from_str(text)?;
    if raw.version != VERSION {
        bail!("unsupported version {} (this build reads version {VERSION})", raw.version);
    }
    let mut columns = BTreeMap::new();
    for (schema, tables) in raw.schemas {
        for (table, cols) in tables {
            for (column, entry) in cols {
                columns.insert((schema.clone(), table.clone(), column), entry);
            }
        }
    }
    Ok(SensitivityFile { columns })
}

/// Sorted, one column per line, so a diff shows exactly the decisions that
/// changed.
pub(super) fn render(file: &SensitivityFile) -> String {
    let q = |s: &str| serde_json::to_string(s).expect("strings serialize");
    let mut nested: BTreeMap<&str, BTreeMap<&str, Vec<(&str, &Entry)>>> = BTreeMap::new();
    for ((schema, table, column), entry) in &file.columns {
        nested.entry(schema).or_default().entry(table).or_default().push((column, entry));
    }
    let mut out = format!("{{\n  \"version\": {VERSION},\n  \"schemas\": {{");
    for (si, (schema, tables)) in nested.iter().enumerate() {
        out += if si == 0 { "\n" } else { ",\n" };
        out += &format!("    {}: {{", q(schema));
        for (ti, (table, cols)) in tables.iter().enumerate() {
            out += if ti == 0 { "\n" } else { ",\n" };
            out += &format!("      {}: {{", q(table));
            for (ci, (column, entry)) in cols.iter().enumerate() {
                out += if ci == 0 { "\n" } else { ",\n" };
                let body = match entry {
                    Entry::Redact { category } => {
                        format!("\"status\": \"redact\", \"category\": \"{}\"", category.as_db())
                    }
                    Entry::Safe { type_name } => {
                        format!("\"status\": \"safe\", \"type\": {}", q(type_name))
                    }
                };
                out += &format!("        {}: {{ {body} }}", q(column));
            }
            out += "\n      }";
        }
        out += "\n    }";
    }
    out += if nested.is_empty() { "}\n}\n" } else { "\n  }\n}\n" };
    out
}

pub(super) fn load(path: &Path) -> Result<SensitivityFile> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("shared sensitivity file {}", path.display()))?;
    parse(&text).with_context(|| format!("shared sensitivity file {}", path.display()))
}

/// Write through a temp file in the same directory, then rename, so a reader
/// never sees half a file.
pub(super) fn save(path: &Path, file: &SensitivityFile) -> Result<()> {
    let name = path.file_name().context("shared sensitivity file path has no file name")?;
    let tmp = path.with_file_name(format!(".{}.tmp", name.to_string_lossy()));
    std::fs::write(&tmp, render(file))
        .with_context(|| format!("write shared sensitivity file {}", path.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("write shared sensitivity file {}", path.display()))
}

/// What a scan saw of the file: modification time and size, or `None` when it
/// couldn't be read.
pub(super) type Stamp = Option<(SystemTime, u64)>;

pub(super) fn stamp(path: &Path) -> Stamp {
    let m = std::fs::metadata(path).ok()?;
    Some((m.modified().ok()?, m.len()))
}

/// Columns the file marks safe, at their live type, that still redact here.
/// They stay redacted until a human accepts them.
pub(super) fn waiting_safe(
    file: &SensitivityFile,
    live_types: &HashMap<Key, String>,
    redacting: &HashSet<Key>,
) -> Vec<Key> {
    file.columns
        .iter()
        .filter_map(|(k, e)| match e {
            Entry::Safe { type_name }
                if redacting.contains(k) && live_types.get(k) == Some(type_name) =>
            {
                Some(k.clone())
            }
            _ => None,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(s: &str, t: &str, c: &str) -> Key {
        (s.into(), t.into(), c.into())
    }

    fn sample() -> SensitivityFile {
        let mut f = SensitivityFile::default();
        f.columns.insert(k("public", "patients", "ssn"), Entry::Redact { category: Category::Pii });
        f.columns.insert(k("public", "leads", "status"), Entry::Safe { type_name: "text".into() });
        f.columns.insert(k("public", "leads", "notes"), Entry::Redact { category: Category::Phi });
        f.columns.insert(
            k("billing", "odd \"name\"", "col.with.dots"),
            Entry::Safe { type_name: "character varying".into() },
        );
        f
    }

    #[test]
    fn render_is_sorted_one_column_per_line_and_round_trips() {
        let text = render(&sample());
        assert_eq!(
            text,
            r#"{
  "version": 1,
  "schemas": {
    "billing": {
      "odd \"name\"": {
        "col.with.dots": { "status": "safe", "type": "character varying" }
      }
    },
    "public": {
      "leads": {
        "notes": { "status": "redact", "category": "phi" },
        "status": { "status": "safe", "type": "text" }
      },
      "patients": {
        "ssn": { "status": "redact", "category": "pii" }
      }
    }
  }
}
"#
        );
        assert_eq!(parse(&text).unwrap(), sample());
    }

    #[test]
    fn empty_file_round_trips() {
        let text = render(&SensitivityFile::default());
        assert_eq!(text, "{\n  \"version\": 1,\n  \"schemas\": {}\n}\n");
        assert_eq!(parse(&text).unwrap(), SensitivityFile::default());
    }

    #[test]
    fn malformed_files_are_rejected_whole() {
        let wrap = |entry: &str| {
            format!(r#"{{"version":1,"schemas":{{"public":{{"t":{{"ok":{{"status":"redact","category":"pii"}},"c":{entry}}}}}}}}}"#)
        };
        assert!(parse(&wrap(r#"{"status":"redact","category":"pii"}"#)).is_ok());
        for bad in [
            r#"{"status":"redact"}"#,
            r#"{"status":"safe"}"#,
            r#"{"status":"redact","category":"secret"}"#,
            r#"{"status":"maybe","category":"pii"}"#,
            r#"{"status":"safe","type":"text","category":"pii"}"#,
        ] {
            assert!(parse(&wrap(bad)).is_err(), "{bad} should be rejected");
        }
        assert!(parse(r#"{"version":2,"schemas":{}}"#).is_err());
        assert!(parse(r#"{"schemas":{}}"#).is_err());
        assert!(parse("<<<<<<< HEAD\n{}").is_err());
    }

    #[test]
    fn only_redacted_columns_at_the_recorded_type_are_waiting() {
        let f = sample();
        let types: HashMap<Key, String> = [
            (k("public", "leads", "status"), "text".to_string()),
            (k("billing", "odd \"name\"", "col.with.dots"), "jsonb".to_string()),
            (k("public", "patients", "ssn"), "text".to_string()),
        ]
        .into();
        let redacting: HashSet<Key> = [
            k("public", "leads", "status"),
            k("billing", "odd \"name\"", "col.with.dots"),
            k("public", "patients", "ssn"),
        ]
        .into();
        // The type mismatch is ignored; a redact entry is never waiting.
        assert_eq!(waiting_safe(&f, &types, &redacting), vec![k("public", "leads", "status")]);
        // Already safe here: nothing to accept.
        assert!(waiting_safe(&f, &types, &HashSet::new()).is_empty());
    }

    #[test]
    fn save_replaces_the_file_atomically() {
        let dir = std::env::temp_dir().join(format!("clio-sf-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("clio-pii.json");
        std::fs::write(&path, "old").unwrap();
        save(&path, &sample()).unwrap();
        assert_eq!(load(&path).unwrap(), sample());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1, "no temp file left behind");
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
