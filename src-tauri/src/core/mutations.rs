use anyhow::{anyhow, Context, Result};
use sqlx::Row;
use std::time::Instant;

use crate::types::{ColumnDescription, MutationBatch, MutationOp, MutationOutcome};

use super::Core;

// The staged-tray editing flow (design/result-editing.md) submits a typed
// batch of UPDATE/INSERT/DELETE ops. We build parameterized SQL with quoted
// identifiers and `$N::<column_type>` casts so dates, uuids, jsonb, etc. all
// come through as plain text from the JSON layer. All ops run inside a single
// Postgres transaction; the first failure rolls everything back.
//
// This is *not* gated by validate_select_only — it is a separate, distinct
// write seam. The MCP server does not expose this command. Humans only.
pub async fn apply_mutations(
    core: &Core,
    conn: &str,
    batch: MutationBatch,
) -> Result<MutationOutcome> {
    let started = Instant::now();
    let total = batch.ops.len();
    let r = async {
        if batch.ops.is_empty() {
            return Err(anyhow!("empty mutation batch"));
        }
        let pool = core.pools.ensure(&core.meta, conn).await?;

        // Cache column metadata per (schema, table) so we don't re-describe in a loop.
        let mut col_cache: std::collections::HashMap<(String, String), Vec<ColumnDescription>> =
            std::collections::HashMap::new();

        let mut tx = pool.begin().await.context("begin transaction")?;
        let mut ran = 0usize;

        for (idx, op) in batch.ops.iter().enumerate() {
            let (schema, table) = op_table(op);
            let key = (schema.to_string(), table.to_string());
            if !col_cache.contains_key(&key) {
                let cols = fetch_columns(&mut *tx, schema, table).await?;
                if cols.is_empty() {
                    return Err(anyhow!(
                        "table {}.{} has no columns or does not exist (op {})",
                        schema, table, idx
                    ));
                }
                col_cache.insert(key.clone(), cols);
            }
            let cols = &col_cache[&key];

            let (sql, binds) = match op {
                MutationOp::Update { schema, table, pk, set } => {
                    build_update(schema, table, pk, set, cols)?
                }
                MutationOp::Insert { schema, table, values } => {
                    build_insert(schema, table, values, cols)?
                }
                MutationOp::Delete { schema, table, pk } => {
                    build_delete(schema, table, pk, cols)?
                }
            };

            let mut q = sqlx::query(&sql);
            for v in &binds {
                q = q.bind(v.as_deref());
            }
            let res = q.execute(&mut *tx).await;
            match res {
                Ok(r) => {
                    if r.rows_affected() == 0 {
                        return Err(anyhow!(
                            "op {idx} affected 0 rows (row may have changed or no longer exists)"
                        ));
                    }
                    ran += 1;
                }
                Err(e) => {
                    return Err(anyhow!(e).context(format!("op {idx} failed")));
                }
            }
        }

        tx.commit().await.context("commit transaction")?;
        Ok::<_, anyhow::Error>(MutationOutcome {
            committed: true,
            statements_run: ran,
            elapsed_ms: started.elapsed().as_millis() as u64,
            error: None,
            error_at: None,
        })
    }
    .await;

    let detail = match &r {
        Ok(o) => format!("{} statements · {} ms", o.statements_run, o.elapsed_ms),
        Err(e) => format!("failed: {}", e),
    };
    core.record_ok("apply_mutations", detail, started, &r);

    // Translate any error into a partial outcome so the UI can surface error_at.
    // We still return Result so the activity event records ok/err correctly above.
    match r {
        Ok(o) => Ok(o),
        Err(e) => {
            let msg = format!("{:#}", e);
            // Best-effort parse of "op N" prefix into error_at.
            let error_at = msg
                .split("op ")
                .nth(1)
                .and_then(|s| s.split(|c: char| !c.is_ascii_digit()).next())
                .and_then(|s| s.parse::<usize>().ok());
            Ok(MutationOutcome {
                committed: false,
                statements_run: 0,
                elapsed_ms: started.elapsed().as_millis() as u64,
                error: Some(msg),
                error_at: error_at.filter(|n| *n < total),
            })
        }
    }
}

fn op_table(op: &MutationOp) -> (&str, &str) {
    match op {
        MutationOp::Update { schema, table, .. }
        | MutationOp::Insert { schema, table, .. }
        | MutationOp::Delete { schema, table, .. } => (schema, table),
    }
}

/// Double-quote a Postgres identifier (schema/table/column).
/// Escapes embedded double-quotes per the standard.
fn quote_ident(s: &str) -> String {
    let escaped = s.replace('"', "\"\"");
    format!("\"{escaped}\"")
}

/// Postgres `data_type` from information_schema.columns isn't always castable
/// directly (e.g. "character varying", "timestamp with time zone", or
/// "USER-DEFINED" for enums). Map to a canonical, castable form.
fn cast_type(col: &ColumnDescription) -> Result<String> {
    if col.data_type == "USER-DEFINED" {
        // Enums / domains / composites — must cast to the real schema-qualified
        // type, not the literal "USER-DEFINED" keyword.
        let s = col.udt_schema.as_deref().ok_or_else(|| {
            anyhow!("column {} is USER-DEFINED but udt_schema is missing", col.name)
        })?;
        let n = col.udt_name.as_deref().ok_or_else(|| {
            anyhow!("column {} is USER-DEFINED but udt_name is missing", col.name)
        })?;
        return Ok(format!("{}.{}", quote_ident(s), quote_ident(n)));
    }
    let canonical = match col.data_type.as_str() {
        "character varying" => "varchar",
        "character" => "char",
        "timestamp without time zone" => "timestamp",
        "timestamp with time zone" => "timestamptz",
        "time without time zone" => "time",
        "time with time zone" => "timetz",
        "double precision" => "float8",
        other => other,
    };
    Ok(canonical.to_string())
}

fn col_desc<'a>(cols: &'a [ColumnDescription], name: &str) -> Result<&'a ColumnDescription> {
    cols.iter()
        .find(|c| c.name == name)
        .ok_or_else(|| anyhow!("column not found: {name}"))
}

async fn fetch_columns(
    tx: &mut sqlx::PgConnection,
    schema: &str,
    table: &str,
) -> Result<Vec<ColumnDescription>> {
    let rows = sqlx::query(
        r#"
        SELECT
            c.column_name,
            c.data_type,
            c.udt_schema,
            c.udt_name,
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
    .fetch_all(&mut *tx)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| ColumnDescription {
            name: r.get("column_name"),
            data_type: r.get("data_type"),
            is_nullable: r.get("is_nullable"),
            default: r.try_get("column_default").ok(),
            is_primary_key: r.get("is_pk"),
            udt_schema: r.try_get("udt_schema").ok(),
            udt_name: r.try_get("udt_name").ok(),
            enum_values: None,
        })
        .collect())
}

fn build_update(
    schema: &str,
    table: &str,
    pk: &[(String, Option<String>)],
    set: &[(String, Option<String>)],
    cols: &[ColumnDescription],
) -> Result<(String, Vec<Option<String>>)> {
    if set.is_empty() {
        return Err(anyhow!("UPDATE requires at least one SET column"));
    }
    if pk.is_empty() {
        return Err(anyhow!("UPDATE requires PK predicates"));
    }
    let mut sql = String::with_capacity(128);
    let mut binds: Vec<Option<String>> = Vec::with_capacity(set.len() + pk.len());
    let mut n = 1usize;
    sql.push_str("UPDATE ");
    sql.push_str(&quote_ident(schema));
    sql.push('.');
    sql.push_str(&quote_ident(table));
    sql.push_str(" SET ");
    for (i, (col, val)) in set.iter().enumerate() {
        let ty = cast_type(col_desc(cols, col)?)?;
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&quote_ident(col));
        sql.push_str(&format!(" = ${n}::{ty}"));
        binds.push(val.clone());
        n += 1;
    }
    sql.push_str(" WHERE ");
    for (i, (col, val)) in pk.iter().enumerate() {
        let ty = cast_type(col_desc(cols, col)?)?;
        if i > 0 {
            sql.push_str(" AND ");
        }
        sql.push_str(&quote_ident(col));
        sql.push_str(&format!(" = ${n}::{ty}"));
        binds.push(val.clone());
        n += 1;
    }
    Ok((sql, binds))
}

fn build_insert(
    schema: &str,
    table: &str,
    values: &[(String, Option<String>)],
    cols: &[ColumnDescription],
) -> Result<(String, Vec<Option<String>>)> {
    if values.is_empty() {
        // All-DEFAULT insert is technically valid in Postgres via "DEFAULT VALUES",
        // but indicates user intent we don't want to silently honor — they almost
        // certainly meant to fill at least one column.
        return Err(anyhow!("INSERT requires at least one column value"));
    }
    let mut sql = String::with_capacity(128);
    let mut binds: Vec<Option<String>> = Vec::with_capacity(values.len());
    sql.push_str("INSERT INTO ");
    sql.push_str(&quote_ident(schema));
    sql.push('.');
    sql.push_str(&quote_ident(table));
    sql.push_str(" (");
    for (i, (col, _)) in values.iter().enumerate() {
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&quote_ident(col));
    }
    sql.push_str(") VALUES (");
    for (i, (col, val)) in values.iter().enumerate() {
        let ty = cast_type(col_desc(cols, col)?)?;
        if i > 0 {
            sql.push_str(", ");
        }
        sql.push_str(&format!("${}::{}", i + 1, ty));
        binds.push(val.clone());
    }
    sql.push(')');
    Ok((sql, binds))
}

fn build_delete(
    schema: &str,
    table: &str,
    pk: &[(String, Option<String>)],
    cols: &[ColumnDescription],
) -> Result<(String, Vec<Option<String>>)> {
    if pk.is_empty() {
        return Err(anyhow!("DELETE requires PK predicates"));
    }
    let mut sql = String::with_capacity(128);
    let mut binds: Vec<Option<String>> = Vec::with_capacity(pk.len());
    sql.push_str("DELETE FROM ");
    sql.push_str(&quote_ident(schema));
    sql.push('.');
    sql.push_str(&quote_ident(table));
    sql.push_str(" WHERE ");
    for (i, (col, val)) in pk.iter().enumerate() {
        let ty = cast_type(col_desc(cols, col)?)?;
        if i > 0 {
            sql.push_str(" AND ");
        }
        sql.push_str(&quote_ident(col));
        sql.push_str(&format!(" = ${}::{}", i + 1, ty));
        binds.push(val.clone());
    }
    Ok((sql, binds))
}
