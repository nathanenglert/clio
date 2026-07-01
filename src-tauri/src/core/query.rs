use anyhow::{anyhow, Result};
use sqlx::{Column, Row, TypeInfo, ValueRef};
use std::time::Instant;

use crate::connections;
use crate::types::{ColumnMeta, QueryResult, RedactionMeta};

use super::lineage;
use super::redactor::{fake_for, RedactorView};
use super::Core;

const ROW_CAP: usize = 1000;

/// Cap full-text payloads (e.g. SQL) emitted on activity events.
const PAYLOAD_MAX_BYTES: usize = 4096;

/// Replacement value for a derived/expression result column whose lineage
/// touches a classified column. Matches the redactor's opaque-type marker.
pub(super) const DERIVED_REDACTED: &str = "<redacted>";

/// Per-result-column redaction target. Built from sqlx's per-column
/// `relation_id` + `relation_attribute_no` joined against the redactor view.
struct RedactionTarget {
    table_oid: i32,
    attnum: i16,
    column_name: String,
    pg_type: String,
}

/// How a single result column's cells are transformed before leaving the core.
enum ColPlan {
    /// OID-tagged classified column → deterministic type-preserving faker.
    Fake(RedactionTarget),
    /// Derived/expression column whose lineage touches a classified column →
    /// replaced wholesale (Postgres reports no source column to key a faker on).
    Derived,
    /// Real value passes through unchanged.
    Pass,
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

    let classified = redactor_view.is_some();
    // Should result columns Postgres left *untagged* (derived expressions over
    // classified columns) be redacted? Only meaningful on a classified
    // connection; see core::lineage.
    let redact_derived = match &redactor_view {
        Some(view) => lineage::should_redact_derived(sql, view),
        None => false,
    };

    let rows = match sqlx::query(sql).fetch_all(&pool).await {
        Ok(r) => r,
        Err(e) => return Err(sanitize_db_error(core, classified, e)),
    };

    // Build per-column meta and a redaction plan. Three cases per column:
    //  • OID-tagged + classified     → deterministic faker (bare column ref)
    //  • untagged + `redact_derived` → wholesale marker (expression lineage)
    //  • otherwise                   → pass the real value through
    let (columns, plans): (Vec<ColumnMeta>, Vec<ColPlan>) = if let Some(first) = rows.first() {
        let pg_cols = first.columns();
        let mut metas = Vec::with_capacity(pg_cols.len());
        let mut plans = Vec::with_capacity(pg_cols.len());
        for c in pg_cols.iter() {
            let pg_type = c.type_info().name().to_string();
            let mut redacted = false;
            let mut category = None;
            let plan = match &redactor_view {
                None => ColPlan::Pass,
                Some(view) => {
                    let tagged = match (c.relation_id(), c.relation_attribute_no()) {
                        (Some(oid), Some(attnum)) => Some((oid.0 as i32, attnum)),
                        _ => None,
                    };
                    match tagged {
                        Some(key) => match view.by_oid.get(&key) {
                            Some(cc) => {
                                redacted = true;
                                category = Some(cc.category);
                                ColPlan::Fake(RedactionTarget {
                                    table_oid: key.0,
                                    attnum: key.1,
                                    column_name: cc.column_name.clone(),
                                    pg_type: pg_type.clone(),
                                })
                            }
                            // Tagged real column that isn't classified — leave it.
                            None => ColPlan::Pass,
                        },
                        // Untagged (derived/expression) column.
                        None if redact_derived => {
                            redacted = true;
                            ColPlan::Derived
                        }
                        None => ColPlan::Pass,
                    }
                }
            };
            metas.push(ColumnMeta {
                name: c.name().to_string(),
                data_type: pg_type.to_ascii_lowercase(),
                redacted,
                category,
            });
            plans.push(plan);
        }
        (metas, plans)
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
            let cooked = match &plans[i] {
                ColPlan::Fake(target) => match (&raw, &secret_ref) {
                    (Some(real), Some(secret)) => Some(fake_for(
                        secret.as_ref(),
                        target.table_oid,
                        target.attnum,
                        &target.column_name,
                        &target.pg_type,
                        real,
                    )),
                    _ => raw,
                },
                // Derived-from-classified: replace wholesale. NULLs stay NULL —
                // they carry no value to leak.
                ColPlan::Derived => raw.as_ref().map(|_| DERIVED_REDACTED.to_string()),
                ColPlan::Pass => raw,
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


/// Convert a query execution error for return to the caller. On the **agent
/// path** and a **classified connection**, a Postgres `DatabaseError` is
/// replaced with a generic message: its text can echo real classified values
/// (`invalid input syntax for type integer: "111-22-3333"`, or a unique-
/// violation `Key (email)=(real@x.com) already exists`), bypassing the row
/// redactor through the error channel. The human (UI) path and unclassified
/// connections keep the full error — the human is trusted and needs it to
/// debug, and there is nothing sensitive to leak.
pub(super) fn sanitize_db_error(core: &Core, classified: bool, e: sqlx::Error) -> anyhow::Error {
    let is_agent = matches!(core.pool_access, crate::pool::PoolAccess::Agent);
    if is_agent && classified && matches!(e, sqlx::Error::Database(_)) {
        anyhow!(
            "the database rejected this query; its error detail was withheld because this \
             connection has redaction enabled and the message may contain sensitive column values"
        )
    } else {
        anyhow::Error::new(e).context("query failed")
    }
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
