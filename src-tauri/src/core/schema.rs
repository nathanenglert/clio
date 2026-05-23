use anyhow::Result;
use sqlx::Row;
use std::time::Instant;

use crate::types::ColumnDescription;

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
        let out = rows
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
