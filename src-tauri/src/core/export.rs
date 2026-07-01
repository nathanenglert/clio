use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use sqlx::{Column, Row, TypeInfo};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

use crate::connections;
use crate::types::ExportResult;

use super::query::{decode_cell, DERIVED_REDACTED};
use super::redactor::{fake_for, RedactorView};
use super::{lineage, Core};

/// Internal: per-export redactor lookup keyed by **result-column index**.
/// Built once before streaming. `None` entries mean "leave alone".
struct ColRedactor {
    table_oid: i32,
    attnum: i16,
    column_name: String,
    pg_type: String,
}

// Bypasses the run_query ROW_CAP by streaming directly from sqlx to a file
// the user picked via the dialog plugin. No intermediate buffering of the
// full result in memory.
pub async fn export_query(
    core: &Core,
    conn: &str,
    sql: &str,
    path: &str,
    format: &str,
    reveal: bool,
) -> Result<ExportResult> {
    let started = Instant::now();
    let r = async {
        super::query::validate_select_only(sql)?;
        if format != "csv" && format != "json" {
            return Err(anyhow!("unsupported export format: {}", format));
        }
        let pool = core.pool(conn).await?;

        let redactor_view: Option<Arc<RedactorView>> = if reveal {
            None
        } else {
            let connection = connections::get(&core.meta, conn).await?;
            core.redactor_cache
                .view_for(&core.meta, &pool, conn, &connection.id)
                .await?
        };
        // Same lineage decision as run_decoded: should untagged (derived)
        // columns be redacted? Postgres doesn't tag expression columns, so the
        // per-column `redactors` map below can't catch them.
        let redact_derived = match &redactor_view {
            Some(view) => lineage::should_redact_derived(sql, view),
            None => false,
        };

        let file = File::create(Path::new(path))
            .with_context(|| format!("create file {}", path))?;
        let mut w = BufWriter::new(file);

        let mut stream = sqlx::query(sql).fetch(&pool);
        let mut row_count: usize = 0;
        let mut columns: Vec<(String, String)> = Vec::new();
        let mut redactors: Vec<Option<ColRedactor>> = Vec::new();
        // Parallel to `columns`: true where the column is a derived/expression
        // result column that must be redacted wholesale (see run_decoded).
        let mut derived: Vec<bool> = Vec::new();

        if format == "csv" {
            // UTF-8 BOM so Excel reads non-ASCII correctly.
            w.write_all(&[0xEF, 0xBB, 0xBF])?;
        } else {
            w.write_all(b"[")?;
        }

        let mut first_row = true;
        while let Some(row_res) = stream.next().await {
            let row = row_res.context("query failed")?;
            if columns.is_empty() {
                columns = row
                    .columns()
                    .iter()
                    .map(|c| (c.name().to_string(), c.type_info().name().to_string()))
                    .collect();
                redactors = row
                    .columns()
                    .iter()
                    .map(|c| {
                        let view = redactor_view.as_ref()?;
                        let oid = c.relation_id()?;
                        let attnum = c.relation_attribute_no()?;
                        let cc = view.by_oid.get(&(oid.0 as i32, attnum))?;
                        Some(ColRedactor {
                            table_oid: oid.0 as i32,
                            attnum,
                            column_name: cc.column_name.clone(),
                            pg_type: c.type_info().name().to_string(),
                        })
                    })
                    .collect();
                derived = row
                    .columns()
                    .iter()
                    .map(|c| {
                        redactor_view.is_some()
                            && redact_derived
                            && !(c.relation_id().is_some()
                                && c.relation_attribute_no().is_some())
                    })
                    .collect();
                if format == "csv" {
                    write_csv_header(&mut w, &columns)?;
                }
            }
            let secret = redactor_view.as_ref().map(|v| v.secret.clone());
            match format {
                "csv" => write_csv_row(&mut w, &row, &columns, &redactors, &derived, secret.as_ref())?,
                "json" => {
                    if !first_row {
                        w.write_all(b",")?;
                    }
                    w.write_all(b"\n  ")?;
                    write_json_row(&mut w, &row, &columns, &redactors, &derived, secret.as_ref())?;
                }
                _ => unreachable!(),
            }
            first_row = false;
            row_count += 1;
        }

        if format == "json" {
            if row_count > 0 {
                w.write_all(b"\n")?;
            }
            w.write_all(b"]\n")?;
        }

        w.flush()?;
        let bytes_written = w.get_ref().metadata().map(|m| m.len()).unwrap_or(0);

        Ok::<_, anyhow::Error>(ExportResult {
            row_count,
            elapsed_ms: started.elapsed().as_millis() as u64,
            bytes_written,
        })
    }
    .await;

    let detail = match &r {
        Ok(x) => format!("{} rows → {}", x.row_count, basename(path)),
        Err(_) => format!("→ {}", basename(path)),
    };
    core.record_ok("export_query", detail, started, &r);
    r
}

/// Atomic-ish write of bytes to a user-chosen path. Used for the "save loaded
/// rows" path where the JS side already has the serialized content.
pub fn write_file(path: &str, content: &[u8]) -> Result<u64> {
    let mut f = File::create(Path::new(path))
        .with_context(|| format!("create file {}", path))?;
    f.write_all(content).with_context(|| "write failed")?;
    f.flush().ok();
    Ok(content.len() as u64)
}

fn basename(path: &str) -> String {
    Path::new(path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(path)
        .to_string()
}

fn write_csv_header<W: Write>(w: &mut W, columns: &[(String, String)]) -> std::io::Result<()> {
    for (i, (name, _)) in columns.iter().enumerate() {
        if i > 0 {
            w.write_all(b",")?;
        }
        write_csv_field(w, name)?;
    }
    w.write_all(b"\r\n")
}

fn write_csv_row<W: Write>(
    w: &mut W,
    row: &sqlx::postgres::PgRow,
    columns: &[(String, String)],
    redactors: &[Option<ColRedactor>],
    derived: &[bool],
    secret: Option<&Arc<[u8; 32]>>,
) -> std::io::Result<()> {
    for i in 0..columns.len() {
        if i > 0 {
            w.write_all(b",")?;
        }
        if let Some(s) = decode_cell(row, i) {
            let cooked = if derived.get(i).copied().unwrap_or(false) {
                DERIVED_REDACTED.to_string()
            } else {
                match (redactors.get(i).and_then(|r| r.as_ref()), secret) {
                    (Some(r), Some(secret)) => fake_for(
                        secret.as_ref(),
                        r.table_oid,
                        r.attnum,
                        &r.column_name,
                        &r.pg_type,
                        &s,
                    ),
                    _ => s,
                }
            };
            write_csv_field(w, &cooked)?;
        }
    }
    w.write_all(b"\r\n")
}

fn write_csv_field<W: Write>(w: &mut W, s: &str) -> std::io::Result<()> {
    let needs_quoting = s
        .bytes()
        .any(|b| matches!(b, b',' | b'"' | b'\r' | b'\n'));
    if !needs_quoting {
        return w.write_all(s.as_bytes());
    }
    w.write_all(b"\"")?;
    for c in s.chars() {
        if c == '"' {
            w.write_all(b"\"\"")?;
        } else {
            let mut buf = [0u8; 4];
            w.write_all(c.encode_utf8(&mut buf).as_bytes())?;
        }
    }
    w.write_all(b"\"")
}

fn write_json_row<W: Write>(
    w: &mut W,
    row: &sqlx::postgres::PgRow,
    columns: &[(String, String)],
    redactors: &[Option<ColRedactor>],
    derived: &[bool],
    secret: Option<&Arc<[u8; 32]>>,
) -> std::io::Result<()> {
    w.write_all(b"{")?;
    for (i, (name, pg_type)) in columns.iter().enumerate() {
        if i > 0 {
            w.write_all(b", ")?;
        }
        let key = serde_json::to_string(name)
            .unwrap_or_else(|_| format!("\"{}\"", name.replace('"', "\\\"")));
        w.write_all(key.as_bytes())?;
        w.write_all(b": ")?;
        // Derived/expression columns are redacted wholesale (unless NULL).
        if derived.get(i).copied().unwrap_or(false) {
            let value = match decode_cell(row, i) {
                None => serde_json::Value::Null,
                Some(_) => serde_json::Value::String(DERIVED_REDACTED.to_string()),
            };
            let value_s = serde_json::to_string(&value).unwrap_or_else(|_| "null".into());
            w.write_all(value_s.as_bytes())?;
            continue;
        }
        let value = match (redactors.get(i).and_then(|r| r.as_ref()), secret) {
            (Some(r), Some(secret)) => {
                // Redacted cells serialize as a JSON string of the fake — same
                // shape the UI sees. We bypass type-preserving JSON encoding
                // because the fake replaces the real value entirely.
                let raw = decode_cell(row, i);
                match raw {
                    None => serde_json::Value::Null,
                    Some(s) => serde_json::Value::String(fake_for(
                        secret.as_ref(),
                        r.table_oid,
                        r.attnum,
                        &r.column_name,
                        &r.pg_type,
                        &s,
                    )),
                }
            }
            _ => decode_cell_for_json(row, i, pg_type),
        };
        let value_s = serde_json::to_string(&value).unwrap_or_else(|_| "null".into());
        w.write_all(value_s.as_bytes())?;
    }
    w.write_all(b"}")
}

fn decode_cell_for_json(
    row: &sqlx::postgres::PgRow,
    idx: usize,
    pg_type: &str,
) -> serde_json::Value {
    use serde_json::{Number, Value};
    // jsonb/json: emit as nested JSON, not a string of JSON.
    if pg_type == "JSON" || pg_type == "JSONB" {
        if let Ok(v) = row.try_get::<Value, _>(idx) {
            return v;
        }
        return Value::Null;
    }
    match decode_cell(row, idx) {
        None => Value::Null,
        Some(s) => match pg_type {
            "INT2" | "INT4" | "INT8" => s
                .parse::<i64>()
                .map(Value::from)
                .unwrap_or(Value::String(s)),
            "FLOAT4" | "FLOAT8" | "NUMERIC" => s
                .parse::<f64>()
                .ok()
                .and_then(Number::from_f64)
                .map(Value::Number)
                .unwrap_or(Value::String(s)),
            "BOOL" => match s.as_str() {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                _ => Value::String(s),
            },
            _ => Value::String(s),
        },
    }
}
