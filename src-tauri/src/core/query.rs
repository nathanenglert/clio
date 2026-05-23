use anyhow::{anyhow, Context, Result};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use std::time::Instant;

use crate::types::{ColumnMeta, QueryResult};

use super::Core;

const ROW_CAP: usize = 1000;

/// Cap full-text payloads (e.g. SQL) emitted on activity events.
const PAYLOAD_MAX_BYTES: usize = 4096;

fn cap_payload(s: &str) -> String {
    if s.len() <= PAYLOAD_MAX_BYTES {
        return s.to_string();
    }
    let mut end = PAYLOAD_MAX_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = String::with_capacity(end + 4);
    out.push_str(&s[..end]);
    out.push_str(" …");
    out
}

/// SELECT-only validator. Leaves a clearly marked seam for the write-gating
/// permission model that lands in v0.2. Rejection here is intentional and
/// final for POC v0.0.
pub(super) fn validate_select_only(sql: &str) -> Result<()> {
    let normalized = strip_comments_lower(sql);
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return Err(anyhow!("empty query"));
    }
    let starts_select = trimmed.starts_with("select");
    let starts_with_cte = trimmed.starts_with("with");
    if !(starts_select || starts_with_cte) {
        return Err(anyhow!(
            "writes/DDL are blocked at the POC seam — only SELECT or WITH-prefixed SELECT are allowed (see core::validate_select_only)"
        ));
    }
    // For CTEs, ensure no INSERT/UPDATE/DELETE inside.
    if starts_with_cte {
        for forbidden in ["insert ", "update ", "delete ", "merge ", "truncate ", "drop ", "alter ", "create ", "grant ", "revoke ", "comment "] {
            if trimmed.contains(forbidden) {
                return Err(anyhow!(
                    "WITH-statement contains a writing/DDL clause ({}); blocked at POC seam",
                    forbidden.trim()
                ));
            }
        }
    }
    Ok(())
}

fn strip_comments_lower(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let bytes = sql.as_bytes();
    let mut i = 0;
    let mut in_block = 0usize;
    while i < bytes.len() {
        let c = bytes[i];
        let next = bytes.get(i + 1).copied().unwrap_or(0);
        if in_block > 0 {
            if c == b'*' && next == b'/' {
                in_block -= 1;
                i += 2;
                continue;
            } else if c == b'/' && next == b'*' {
                in_block += 1;
                i += 2;
                continue;
            }
            i += 1;
            continue;
        }
        if c == b'-' && next == b'-' {
            while i < bytes.len() && bytes[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if c == b'/' && next == b'*' {
            in_block += 1;
            i += 2;
            continue;
        }
        out.push((c as char).to_ascii_lowercase());
        i += 1;
    }
    out
}

pub async fn run_query(core: &Core, conn: &str, sql: &str) -> Result<QueryResult> {
    let started = Instant::now();
    let r = async {
        validate_select_only(sql)?;
        let pool = core.pools.ensure(&core.meta, conn).await?;
        let rows = sqlx::query(sql)
            .fetch_all(&pool)
            .await
            .with_context(|| "query failed")?;
        let columns: Vec<ColumnMeta> = rows
            .first()
            .map(|r| {
                r.columns()
                    .iter()
                    .map(|c| ColumnMeta {
                        name: c.name().to_string(),
                        data_type: c.type_info().name().to_ascii_lowercase(),
                    })
                    .collect()
            })
            .unwrap_or_default();

        let truncated = rows.len() > ROW_CAP;
        let take = rows.len().min(ROW_CAP);

        let mut out_rows: Vec<Vec<Option<String>>> = Vec::with_capacity(take);
        for row in rows.iter().take(take) {
            let mut out_row = Vec::with_capacity(row.columns().len());
            for (i, _col) in row.columns().iter().enumerate() {
                out_row.push(decode_cell(row, i));
            }
            out_rows.push(out_row);
        }
        Ok::<_, anyhow::Error>(QueryResult {
            columns,
            rows: out_rows,
            row_count: rows.len(),
            truncated,
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }
    .await;

    // One-line summary for the activity strip; full SQL goes on `payload`.
    let mut detail = sql.replace('\n', " ");
    if detail.len() > 80 {
        detail.truncate(77);
        detail.push_str("...");
    }
    let payload = Some(cap_payload(sql));
    core.record_ok_with_payload("run_query", detail, payload, started, &r);
    r
}

/// Best-effort decode of a single Postgres cell to a display String.
/// Falls back to the type name in angle brackets for types we don't know.
pub(super) fn decode_cell(row: &sqlx::postgres::PgRow, idx: usize) -> Option<String> {
    let raw = match row.try_get_raw(idx) {
        Ok(v) => v,
        Err(_) => return None,
    };
    if raw.is_null() {
        return None;
    }
    let type_name = raw.type_info().name().to_string();

    macro_rules! try_decode {
        ($t:ty) => {
            if let Ok(v) = row.try_get::<$t, _>(idx) {
                return Some(v.to_string());
            }
        };
    }

    match type_name.as_str() {
        "BOOL" => try_decode!(bool),
        "INT2" => try_decode!(i16),
        "INT4" => try_decode!(i32),
        "INT8" => try_decode!(i64),
        "FLOAT4" => try_decode!(f32),
        "FLOAT8" => try_decode!(f64),
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CHAR" | "CITEXT" => try_decode!(String),
        "UUID" => try_decode!(uuid::Uuid),
        "TIMESTAMP" => try_decode!(chrono::NaiveDateTime),
        "TIMESTAMPTZ" => try_decode!(chrono::DateTime<chrono::Utc>),
        "DATE" => try_decode!(chrono::NaiveDate),
        "TIME" => try_decode!(chrono::NaiveTime),
        "JSON" | "JSONB" => {
            if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) {
                return Some(v.to_string());
            }
        }
        "BYTEA" => {
            if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
                let mut s = String::from("\\x");
                for b in &v {
                    s.push_str(&format!("{:02x}", b));
                }
                return Some(s);
            }
        }
        _ => {}
    }
    // Last-ditch string fallback
    if let Ok(s) = row.try_get::<String, _>(idx) {
        return Some(s);
    }
    // User-defined enums and other text-shaped types: Postgres transmits the
    // label as UTF-8 bytes in both text and binary modes, so decode directly.
    if let Ok(bytes) = raw.as_bytes() {
        if let Ok(s) = std::str::from_utf8(bytes) {
            return Some(s.to_string());
        }
    }
    Some(format!("<{type_name}>"))
}
