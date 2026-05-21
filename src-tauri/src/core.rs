use anyhow::{anyhow, Context, Result};
use sqlx::{Column, Row, SqlitePool, TypeInfo, ValueRef};
use std::time::Instant;

use crate::activity::{record, EmitFn};
use crate::connections;
use crate::pool::PoolRegistry;
use crate::types::{
    ColumnDescription, Connection, NewConnectionInput, QueryResult,
};

const ROW_CAP: usize = 1000;

/// Container the UI- and MCP-mode entry points both hand to core fns.
#[derive(Clone)]
pub struct Core {
    pub meta: SqlitePool,
    pub pools: PoolRegistry,
    pub emit: EmitFn,
    pub source: String, // "ui" | "mcp"
}

impl Core {
    /// Convenience: emit a synchronous ok/err event.
    fn record_ok<T>(&self, tool: &str, detail: impl Into<String>, started: Instant, result: &Result<T>) {
        record(&self.emit, &self.source, tool, detail, started, result);
    }
}

// ── Connection metadata ───────────────────────────────────────────

pub async fn list_connections(core: &Core) -> Result<Vec<Connection>> {
    let started = Instant::now();
    let r = async {
        let mut conns = connections::list(&core.meta).await?;
        for c in &mut conns {
            c.connected = core.pools.is_connected(&c.name).await;
        }
        Ok::<_, anyhow::Error>(conns)
    }
    .await;
    core.record_ok("list_connections", "", started, &r);
    r
}

pub async fn add_connection(core: &Core, input: NewConnectionInput) -> Result<Connection> {
    let started = Instant::now();
    let detail = input.name.clone();
    let r = connections::insert(&core.meta, &input).await;
    core.record_ok("add_connection", detail, started, &r);
    r
}

pub async fn delete_connection(core: &Core, name: &str) -> Result<()> {
    let started = Instant::now();
    let r = async {
        core.pools.drop_pool(name).await;
        connections::delete(&core.meta, name).await
    }
    .await;
    core.record_ok("delete_connection", name, started, &r);
    r
}

pub async fn connect(core: &Core, name: &str) -> Result<()> {
    let started = Instant::now();
    let r = async {
        let c = connections::get(&core.meta, name).await?;
        core.pools.connect(&c).await.map(|_| ())
    }
    .await;
    core.record_ok("connect", name, started, &r);
    r
}

pub async fn disconnect(core: &Core, name: &str) -> Result<()> {
    let started = Instant::now();
    core.pools.drop_pool(name).await;
    let r: Result<()> = Ok(());
    core.record_ok("disconnect", name, started, &r);
    r
}

// ── Schema introspection ──────────────────────────────────────────

pub async fn list_schemas(core: &Core, conn: &str) -> Result<Vec<String>> {
    let started = Instant::now();
    let r = async {
        let pool = core.pools.ensure(&core.meta, conn).await?;
        let rows = sqlx::query(
            "SELECT schema_name FROM information_schema.schemata
             WHERE schema_name NOT IN ('information_schema','pg_catalog','pg_toast')
               AND schema_name NOT LIKE 'pg_temp_%'
               AND schema_name NOT LIKE 'pg_toast_temp_%'
             ORDER BY schema_name",
        )
        .fetch_all(&pool)
        .await?;
        Ok::<_, anyhow::Error>(rows.into_iter().map(|r| r.get::<String, _>(0)).collect())
    }
    .await;
    core.record_ok("list_schemas", conn, started, &r);
    r
}

pub async fn list_tables(core: &Core, conn: &str, schema: &str) -> Result<Vec<String>> {
    let started = Instant::now();
    let r = async {
        let pool = core.pools.ensure(&core.meta, conn).await?;
        let rows = sqlx::query(
            "SELECT table_name FROM information_schema.tables
             WHERE table_schema = $1
               AND table_type IN ('BASE TABLE','VIEW')
             ORDER BY table_name",
        )
        .bind(schema)
        .fetch_all(&pool)
        .await?;
        Ok::<_, anyhow::Error>(rows.into_iter().map(|r| r.get::<String, _>(0)).collect())
    }
    .await;
    core.record_ok("list_tables", format!("{conn}/{schema}"), started, &r);
    r
}

pub async fn describe_table(
    core: &Core,
    conn: &str,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnDescription>> {
    let started = Instant::now();
    let r = async {
        let pool = core.pools.ensure(&core.meta, conn).await?;
        let rows = sqlx::query(
            r#"
            SELECT
                c.column_name,
                c.data_type,
                c.is_nullable = 'YES' AS is_nullable,
                c.column_default,
                EXISTS (
                    SELECT 1
                    FROM information_schema.key_column_usage k
                    JOIN information_schema.table_constraints tc
                      ON tc.constraint_name = k.constraint_name
                     AND tc.table_schema = k.table_schema
                    WHERE tc.constraint_type = 'PRIMARY KEY'
                      AND k.table_schema = c.table_schema
                      AND k.table_name = c.table_name
                      AND k.column_name = c.column_name
                ) AS is_pk
            FROM information_schema.columns c
            WHERE c.table_schema = $1 AND c.table_name = $2
            ORDER BY c.ordinal_position
            "#,
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await?;
        let out = rows
            .into_iter()
            .map(|r| ColumnDescription {
                name: r.get("column_name"),
                data_type: r.get("data_type"),
                is_nullable: r.get("is_nullable"),
                default: r.try_get("column_default").ok(),
                is_primary_key: r.get("is_pk"),
            })
            .collect();
        Ok::<_, anyhow::Error>(out)
    }
    .await;
    core.record_ok(
        "describe_table",
        format!("{conn}/{schema}.{table}"),
        started,
        &r,
    );
    r
}

// ── Query ────────────────────────────────────────────────────────

/// SELECT-only validator. Leaves a clearly marked seam for the write-gating
/// permission model that lands in v0.2. Rejection here is intentional and
/// final for POC v0.0.
pub fn validate_select_only(sql: &str) -> Result<()> {
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
        let columns: Vec<String> = rows
            .first()
            .map(|r| r.columns().iter().map(|c| c.name().to_string()).collect())
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

    // Trim long SQL for the activity log
    let mut detail = sql.replace('\n', " ");
    if detail.len() > 80 {
        detail.truncate(77);
        detail.push_str("...");
    }
    core.record_ok("run_query", detail, started, &r);
    r
}

/// Best-effort decode of a single Postgres cell to a display String.
/// Falls back to the type name in angle brackets for types we don't know.
fn decode_cell(row: &sqlx::postgres::PgRow, idx: usize) -> Option<String> {
    use sqlx::postgres::PgRow;
    let _ = row as &PgRow;

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
    Some(format!("<{type_name}>"))
}
