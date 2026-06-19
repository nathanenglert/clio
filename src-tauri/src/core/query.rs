use anyhow::{anyhow, Context, Result};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use std::time::Instant;

use crate::connections;
use crate::types::{ColumnMeta, QueryResult, RedactionMeta};

use super::redactor::{fake_for, RedactorView};
use super::Core;

const ROW_CAP: usize = 1000;

/// Cap full-text payloads (e.g. SQL) emitted on activity events.
const PAYLOAD_MAX_BYTES: usize = 4096;

/// Per-result-column redaction target. Built from sqlx's per-column
/// `relation_id` + `relation_attribute_no` joined against the redactor view.
struct RedactionTarget {
    table_oid: i32,
    attnum: i16,
    column_name: String,
    pg_type: String,
}

pub(super) fn cap_payload(s: &str) -> String {
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

/// Run a SELECT query and post-process the rows through the redactor.
///
/// Used by the MCP `run_query` tool — agents must use `execute_statement`
/// for writes/DDL so the human sees the permission card. The UI editor
/// uses `run_sql` (no SELECT guard); the human typing in the editor is
/// their own gate.
///
/// `reveal` skips the redactor pass entirely. The MCP tool handler hardcodes
/// `reveal: false`; only the Tauri UI command may pass `true`, and only when
/// the user explicitly enabled `View > Reveal sensitive data`.
pub async fn run_query(
    core: &Core,
    conn: &str,
    sql: &str,
    reveal: bool,
) -> Result<QueryResult> {
    let started = Instant::now();
    let r = async {
        validate_select_only(sql)?;
        run_decoded(core, conn, sql, reveal).await
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

/// Run any SQL statement from the UI editor. No SELECT-only guard and no
/// policy gate — the human typed it, the human owns it. Records activity
/// under the `run_query` tool name so existing UI filters keep matching.
pub async fn run_sql(
    core: &Core,
    conn: &str,
    sql: &str,
    reveal: bool,
) -> Result<QueryResult> {
    let started = Instant::now();
    let r = run_decoded(core, conn, sql, reveal).await;

    let mut detail = sql.replace('\n', " ");
    if detail.len() > 80 {
        detail.truncate(77);
        detail.push_str("...");
    }
    let payload = Some(cap_payload(sql));
    core.record_ok_with_payload("run_query", detail, payload, started, &r);
    r
}

/// Like `run_query` but with **no validation** and **no activity recording**.
/// Used by the gated `execute_statement` path (caller has already evaluated
/// the policy) and by the SELECT-only `run_query` wrapper above.
///
/// Fetches rows via sqlx, applies redaction column-by-column, builds a
/// `QueryResult`. Works uniformly for SELECT (rows back), and for
/// INSERT/UPDATE/DELETE without RETURNING (empty rows + empty columns —
/// Postgres returns no result columns when there's nothing to return).
pub(super) async fn run_decoded(
    core: &Core,
    conn: &str,
    sql: &str,
    reveal: bool,
) -> Result<QueryResult> {
    let started = Instant::now();
    let pool = core.pool(conn).await?;

    // Look up the redactor view *before* running the query so we can use
    // the per-column source info (relation_id / attribute_no) reported by
    // sqlx. Skipped entirely when `reveal` is on or when the connection
    // has no classifications — see RedactorCache::view_for.
    let redactor_view: Option<std::sync::Arc<RedactorView>> = if reveal {
        None
    } else {
        let connection = connections::get(&core.meta, conn).await?;
        core.redactor_cache
            .view_for(&core.meta, &pool, conn, &connection.id)
            .await?
    };

    let rows = sqlx::query(sql)
        .fetch_all(&pool)
        .await
        .with_context(|| "query failed")?;

    // Build per-column meta (name, type) and figure out which result
    // columns map to classified base columns.
    let (columns, redacted_column_lookup): (Vec<ColumnMeta>, Vec<Option<RedactionTarget>>) =
        if let Some(first) = rows.first() {
            let pg_cols = first.columns();
            let mut metas = Vec::with_capacity(pg_cols.len());
            let mut lookup = Vec::with_capacity(pg_cols.len());
            for c in pg_cols.iter() {
                let pg_type = c.type_info().name().to_string();
                let mut redacted = false;
                let mut category = None;
                let mut target = None;
                if let Some(view) = &redactor_view {
                    if let (Some(oid), Some(attnum)) =
                        (c.relation_id(), c.relation_attribute_no())
                    {
                        let key = (oid.0 as i32, attnum);
                        if let Some(cc) = view.by_oid.get(&key) {
                            redacted = true;
                            category = Some(cc.category);
                            target = Some(RedactionTarget {
                                table_oid: key.0,
                                attnum: key.1,
                                column_name: cc.column_name.clone(),
                                pg_type: pg_type.clone(),
                            });
                        }
                    }
                }
                metas.push(ColumnMeta {
                    name: c.name().to_string(),
                    data_type: pg_type.to_ascii_lowercase(),
                    redacted,
                    category,
                });
                lookup.push(target);
            }
            (metas, lookup)
        } else {
            (Vec::new(), Vec::new())
        };

    let truncated = rows.len() > ROW_CAP;
    let take = rows.len().min(ROW_CAP);

    let mut out_rows: Vec<Vec<Option<String>>> = Vec::with_capacity(take);
    let secret_ref = redactor_view.as_ref().map(|v| v.secret.clone());
    for row in rows.iter().take(take) {
        let mut out_row = Vec::with_capacity(row.columns().len());
        for (i, _col) in row.columns().iter().enumerate() {
            let raw = decode_cell(row, i);
            let cooked = match (&raw, &redacted_column_lookup[i], &secret_ref) {
                (Some(real), Some(target), Some(secret)) => Some(fake_for(
                    secret.as_ref(),
                    target.table_oid,
                    target.attnum,
                    &target.column_name,
                    &target.pg_type,
                    real,
                )),
                _ => raw,
            };
            out_row.push(cooked);
        }
        out_rows.push(out_row);
    }

    let redacted_names: Vec<String> = columns
        .iter()
        .filter(|c| c.redacted)
        .map(|c| c.name.clone())
        .collect();
    let redaction_meta = if redacted_names.is_empty() {
        None
    } else {
        Some(RedactionMeta {
            note: format!(
                "{} column{} redacted by policy",
                redacted_names.len(),
                if redacted_names.len() == 1 { "" } else { "s" }
            ),
            redacted_columns: redacted_names,
        })
    };

    Ok(QueryResult {
        columns,
        rows: out_rows,
        row_count: rows.len(),
        truncated,
        elapsed_ms: started.elapsed().as_millis() as u64,
        redaction_meta,
    })
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
        "NUMERIC" => try_decode!(sqlx::types::BigDecimal),
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
    // Skip this for known binary-encoded types — their raw wire bytes can
    // coincidentally form valid UTF-8 and produce silent garbage (see the
    // NUMERIC bug fixed alongside this guard).
    let known_binary = matches!(
        type_name.as_str(),
        "BOOL"
            | "INT2"
            | "INT4"
            | "INT8"
            | "FLOAT4"
            | "FLOAT8"
            | "NUMERIC"
            | "UUID"
            | "TIMESTAMP"
            | "TIMESTAMPTZ"
            | "DATE"
            | "TIME"
            | "JSON"
            | "JSONB"
            | "BYTEA"
    );
    if !known_binary {
        if let Ok(bytes) = raw.as_bytes() {
            if let Ok(s) = std::str::from_utf8(bytes) {
                return Some(s.to_string());
            }
        }
    }
    Some(format!("<{type_name}>"))
}
