use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use sqlx::{Column, Row, TypeInfo};
use std::fs::File;
use std::io::{BufWriter, Write};
use std::path::Path;
use std::time::Instant;

use crate::types::ExportResult;

use super::query::decode_cell;
use super::Core;

// Bypasses the run_query ROW_CAP by streaming directly from sqlx to a file
// the user picked via the dialog plugin. No intermediate buffering of the
// full result in memory.
pub async fn export_query(
    core: &Core,
    conn: &str,
    sql: &str,
    path: &str,
    format: &str,
) -> Result<ExportResult> {
    let started = Instant::now();
    let r = async {
        super::query::validate_select_only(sql)?;
        if format != "csv" && format != "json" {
            return Err(anyhow!("unsupported export format: {}", format));
        }
        let pool = core.pools.ensure(&core.meta, conn).await?;

        let file = File::create(Path::new(path))
            .with_context(|| format!("create file {}", path))?;
        let mut w = BufWriter::new(file);

        let mut stream = sqlx::query(sql).fetch(&pool);
        let mut row_count: usize = 0;
        let mut columns: Vec<(String, String)> = Vec::new();

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
                if format == "csv" {
                    write_csv_header(&mut w, &columns)?;
                }
            }
            match format {
                "csv" => write_csv_row(&mut w, &row, &columns)?,
                "json" => {
                    if !first_row {
                        w.write_all(b",")?;
                    }
                    w.write_all(b"\n  ")?;
                    write_json_row(&mut w, &row, &columns)?;
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
) -> std::io::Result<()> {
    for i in 0..columns.len() {
        if i > 0 {
            w.write_all(b",")?;
        }
        if let Some(s) = decode_cell(row, i) {
            write_csv_field(w, &s)?;
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
        let value = decode_cell_for_json(row, i, pg_type);
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
