use anyhow::Result;
use sqlx::Row;
use std::time::Instant;

use crate::types::{
    ColumnDescription, ColumnSearchHit, ConstraintInfo, ConstraintKind, ForeignKeyTarget,
    IndexInfo, TableDescription, TableKind, TableSummary, TriggerInfo, ViewDefinition,
};

use super::Core;

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

pub async fn list_tables(core: &Core, conn: &str, schema: &str) -> Result<Vec<TableSummary>> {
    let started = Instant::now();
    let r = async {
        let pool = core.pools.ensure(&core.meta, conn).await?;
        // pg_class lets us pull relkind + reltuples in one shot; information_schema
        // would require a join + lose the relkind distinction (matviews aren't in
        // information_schema.tables at all).
        let rows = sqlx::query(
            r#"
            SELECT c.relname AS name,
                   c.relkind::text AS relkind,
                   c.reltuples::bigint AS reltuples
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1
              AND c.relkind IN ('r','v','m','p','f')
            ORDER BY c.relname
            "#,
        )
        .bind(schema)
        .fetch_all(&pool)
        .await?;
        let out = rows
            .into_iter()
            .map(|r| {
                let relkind: String = r.get("relkind");
                let est: i64 = r.try_get("reltuples").unwrap_or(-1);
                TableSummary {
                    name: r.get("name"),
                    kind: TableKind::from_relkind(relkind.chars().next().unwrap_or('r')),
                    // reltuples is -1 before the relation has been analyzed; treat
                    // that as "unknown" so the UI can hide the count instead of
                    // showing a misleading "-1".
                    row_estimate: if est < 0 { None } else { Some(est) },
                }
            })
            .collect();
        Ok::<_, anyhow::Error>(out)
    }
    .await;
    core.record_ok("list_tables", format!("{conn}/{schema}"), started, &r);
    r
}

/// Cross-schema column name search for the rail's filter UI. ILIKE on column
/// names, results capped — caller passes the user's query directly.
pub async fn search_columns(
    core: &Core,
    conn: &str,
    query: &str,
    limit: i64,
) -> Result<Vec<ColumnSearchHit>> {
    let started = Instant::now();
    let r = async {
        let pool = core.pools.ensure(&core.meta, conn).await?;
        let pattern = format!("%{}%", query.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"));
        let rows = sqlx::query(
            r#"
            SELECT n.nspname AS schema, c.relname AS "table", a.attname AS column
            FROM pg_attribute a
            JOIN pg_class c ON c.oid = a.attrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE a.attnum > 0
              AND NOT a.attisdropped
              AND c.relkind IN ('r','v','m','p','f')
              AND n.nspname NOT IN ('information_schema','pg_catalog','pg_toast')
              AND n.nspname NOT LIKE 'pg_temp_%'
              AND n.nspname NOT LIKE 'pg_toast_temp_%'
              AND a.attname ILIKE $1 ESCAPE '\'
            ORDER BY a.attname, n.nspname, c.relname
            LIMIT $2
            "#,
        )
        .bind(pattern)
        .bind(limit)
        .fetch_all(&pool)
        .await?;
        let out = rows
            .into_iter()
            .map(|r| ColumnSearchHit {
                schema: r.get("schema"),
                table: r.get("table"),
                column: r.get("column"),
            })
            .collect();
        Ok::<_, anyhow::Error>(out)
    }
    .await;
    core.record_ok("search_columns", format!("{conn}/{query}"), started, &r);
    r
}

pub async fn describe_table(
    core: &Core,
    conn: &str,
    schema: &str,
    table: &str,
) -> Result<TableDescription> {
    let started = Instant::now();
    let r = async {
        let pool = core.pools.ensure(&core.meta, conn).await?;

        // ── relkind first ─────────────────────────────────────────
        // We need it to decide whether to fetch a view definition and to
        // include it in the response shape. One round-trip; cheap.
        let relkind_char: Option<String> = sqlx::query_scalar(
            r#"
            SELECT c.relkind::text
            FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = $1 AND c.relname = $2
            "#,
        )
        .bind(schema)
        .bind(table)
        .fetch_optional(&pool)
        .await?;
        let kind = TableKind::from_relkind(
            relkind_char
                .as_deref()
                .and_then(|s| s.chars().next())
                .unwrap_or('r'),
        );

        // ── columns ───────────────────────────────────────────────
        let column_rows = sqlx::query(
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
                ) AS is_pk,
                CASE WHEN c.data_type = 'USER-DEFINED' THEN (
                    SELECT array_agg(e.enumlabel::text ORDER BY e.enumsortorder)
                    FROM pg_type t
                    JOIN pg_namespace n ON n.oid = t.typnamespace
                    JOIN pg_enum e ON e.enumtypid = t.oid
                    WHERE n.nspname = c.udt_schema AND t.typname = c.udt_name
                ) END AS enum_values
            FROM information_schema.columns c
            WHERE c.table_schema = $1 AND c.table_name = $2
            ORDER BY c.ordinal_position
            "#,
        )
        .bind(schema)
        .bind(table)
        .fetch_all(&pool)
        .await?;
        let columns: Vec<ColumnDescription> = column_rows
            .into_iter()
            .map(|r| ColumnDescription {
                name: r.get("column_name"),
                data_type: r.get("data_type"),
                is_nullable: r.get("is_nullable"),
                default: r.try_get("column_default").ok(),
                is_primary_key: r.get("is_pk"),
                udt_schema: r.try_get("udt_schema").ok(),
                udt_name: r.try_get("udt_name").ok(),
                enum_values: r.try_get::<Option<Vec<String>>, _>("enum_values").ok().flatten(),
            })
            .collect();

        // Views & matviews don't have indexes/constraints/triggers in the
        // sense the UI cares about, and matview index queries against a
        // matview *do* return results (CREATE INDEX ON matview is legal),
        // so we still query — pg returns the empty set for plain views.
        let indexes = fetch_indexes(&pool, schema, table).await?;
        let constraints = fetch_constraints(&pool, schema, table).await?;
        let triggers = fetch_triggers(&pool, schema, table).await?;

        // ── view definition ───────────────────────────────────────
        let view_definition = match kind {
            TableKind::View | TableKind::MatView => {
                let sql: Option<String> = sqlx::query_scalar(
                    r#"
                    SELECT pg_get_viewdef(c.oid, true)
                    FROM pg_class c
                    JOIN pg_namespace n ON n.oid = c.relnamespace
                    WHERE n.nspname = $1 AND c.relname = $2
                    "#,
                )
                .bind(schema)
                .bind(table)
                .fetch_optional(&pool)
                .await?
                .flatten();
                sql.map(|s| ViewDefinition {
                    sql: s.trim_end().to_string(),
                    is_materialized: matches!(kind, TableKind::MatView),
                })
            }
            _ => None,
        };

        Ok::<_, anyhow::Error>(TableDescription {
            kind,
            columns,
            indexes,
            constraints,
            triggers,
            view_definition,
        })
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

async fn fetch_indexes(
    pool: &sqlx::PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<IndexInfo>> {
    // pg_get_indexdef gives us the authoritative CREATE INDEX text (handles
    // partial WHERE, expressions, opclasses). We pull column names via the
    // attribute join so the UI can render them tidily without re-parsing the
    // definition string.
    let rows = sqlx::query(
        r#"
        SELECT
            i.relname AS index_name,
            pg_get_indexdef(ix.indexrelid) AS def,
            ix.indisunique AS is_unique,
            ix.indisprimary AS is_primary,
            COALESCE(
                (
                    SELECT array_agg(att.attname::text ORDER BY ord.k)
                    FROM unnest(ix.indkey::int[]) WITH ORDINALITY ord(attnum, k)
                    LEFT JOIN pg_attribute att
                      ON att.attrelid = ix.indrelid AND att.attnum = ord.attnum
                ),
                ARRAY[]::text[]
            ) AS columns
        FROM pg_index ix
        JOIN pg_class i ON i.oid = ix.indexrelid
        JOIN pg_class t ON t.oid = ix.indrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = $1 AND t.relname = $2
        ORDER BY ix.indisprimary DESC, ix.indisunique DESC, i.relname
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            // attname is NULL for expression indexes; surface "(expression)"
            // so the columns list is never empty when one exists.
            let raw_cols: Vec<Option<String>> = r
                .try_get::<Vec<Option<String>>, _>("columns")
                .unwrap_or_default();
            let columns = raw_cols
                .into_iter()
                .map(|c| c.unwrap_or_else(|| "(expression)".to_string()))
                .collect();
            IndexInfo {
                name: r.get("index_name"),
                definition: r.get("def"),
                is_unique: r.get("is_unique"),
                is_primary: r.get("is_primary"),
                columns,
            }
        })
        .collect())
}

async fn fetch_constraints(
    pool: &sqlx::PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<ConstraintInfo>> {
    // pg_get_constraintdef hands us a uniform definition string per constraint
    // type. For foreign keys we additionally resolve the referenced relation
    // + columns so the UI can render "→ public.providers(id)" without parsing
    // the SQL text.
    let rows = sqlx::query(
        r#"
        SELECT
            con.conname AS name,
            con.contype::text AS contype,
            pg_get_constraintdef(con.oid, true) AS def,
            COALESCE(
                (
                    SELECT array_agg(att.attname::text ORDER BY ord.k)
                    FROM unnest(con.conkey::int[]) WITH ORDINALITY ord(attnum, k)
                    LEFT JOIN pg_attribute att
                      ON att.attrelid = con.conrelid AND att.attnum = ord.attnum
                ),
                ARRAY[]::text[]
            ) AS columns,
            fn.nspname AS f_schema,
            ft.relname AS f_table,
            COALESCE(
                (
                    SELECT array_agg(fatt.attname::text ORDER BY ord.k)
                    FROM unnest(con.confkey::int[]) WITH ORDINALITY ord(attnum, k)
                    LEFT JOIN pg_attribute fatt
                      ON fatt.attrelid = con.confrelid AND fatt.attnum = ord.attnum
                ),
                NULL
            ) AS f_columns
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_class ft ON ft.oid = con.confrelid
        LEFT JOIN pg_namespace fn ON fn.oid = ft.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
          AND con.contype IN ('p','f','u','c','x')
        ORDER BY
            CASE con.contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'f' THEN 2
                             WHEN 'c' THEN 3 WHEN 'x' THEN 4 ELSE 5 END,
            con.conname
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .filter_map(|r| {
            let contype: String = r.get("contype");
            let kind = ConstraintKind::from_contype(contype.chars().next().unwrap_or('?'))?;
            let raw_cols: Vec<Option<String>> = r
                .try_get::<Vec<Option<String>>, _>("columns")
                .unwrap_or_default();
            let columns = raw_cols.into_iter().flatten().collect();
            let references = match kind {
                ConstraintKind::ForeignKey => {
                    let f_schema: Option<String> = r.try_get("f_schema").ok();
                    let f_table: Option<String> = r.try_get("f_table").ok();
                    let f_columns: Option<Vec<Option<String>>> =
                        r.try_get::<Option<Vec<Option<String>>>, _>("f_columns").ok().flatten();
                    match (f_schema, f_table, f_columns) {
                        (Some(s), Some(t), Some(cs)) => Some(ForeignKeyTarget {
                            schema: s,
                            table: t,
                            columns: cs.into_iter().flatten().collect(),
                        }),
                        _ => None,
                    }
                }
                _ => None,
            };
            Some(ConstraintInfo {
                name: r.get("name"),
                kind,
                definition: r.get("def"),
                columns,
                references,
            })
        })
        .collect())
}

async fn fetch_triggers(
    pool: &sqlx::PgPool,
    schema: &str,
    table: &str,
) -> Result<Vec<TriggerInfo>> {
    // `tgisinternal` excludes triggers Postgres synthesizes for FK
    // constraints — those are a noisy multiple of the user's actual triggers
    // and the user already sees the FK in the Constraints tab.
    //
    // tgtype is a bitmask: bit 1 = ROW (vs STATEMENT); bit 2 = BEFORE; bit 6 =
    // INSTEAD OF; bits 3/4/5 = INSERT/DELETE/UPDATE; bit 7 = TRUNCATE.
    // See: src/include/catalog/pg_trigger.h (TRIGGER_TYPE_*).
    let rows = sqlx::query(
        r#"
        SELECT
            t.tgname AS name,
            t.tgtype::int AS tgtype,
            pg_get_triggerdef(t.oid, true) AS def
        FROM pg_trigger t
        JOIN pg_class c ON c.oid = t.tgrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relname = $2
          AND NOT t.tgisinternal
        ORDER BY t.tgname
        "#,
    )
    .bind(schema)
    .bind(table)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|r| {
            let bits: i32 = r.get("tgtype");
            let row_level = (bits & 1) != 0;
            let before = (bits & 2) != 0;
            let instead = (bits & 64) != 0;
            let timing = if instead {
                "INSTEAD OF"
            } else if before {
                "BEFORE"
            } else {
                "AFTER"
            };
            let mut events = Vec::new();
            if (bits & 4) != 0 { events.push("INSERT"); }
            if (bits & 8) != 0 { events.push("DELETE"); }
            if (bits & 16) != 0 { events.push("UPDATE"); }
            if (bits & 32) != 0 { events.push("TRUNCATE"); }
            TriggerInfo {
                name: r.get("name"),
                timing: timing.to_string(),
                events: events.join(", "),
                level: if row_level { "ROW" } else { "STATEMENT" }.to_string(),
                definition: r.get("def"),
            }
        })
        .collect())
}
