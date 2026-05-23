use anyhow::{Context, Result};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::types::{
    Category, Classification, ClassificationStatus, Connection, NewConnectionInput,
};

const KEYRING_SERVICE: &str = "com.dbapp.poc";
/// Prefix on the keyring entry name. Keeps the redaction secret separate from
/// the connection password (which uses the bare connection name as the
/// keyring username field).
const REDACTION_SECRET_PREFIX: &str = "redaction:";

/// Resolves the app data directory; creates it if missing.
pub fn app_data_dir() -> Result<PathBuf> {
    let base = dirs::data_local_dir().context("no local data dir")?;
    let dir = base.join("com.dbapp.poc");
    std::fs::create_dir_all(&dir).with_context(|| format!("create {:?}", dir))?;
    Ok(dir)
}

pub fn metadata_db_path() -> Result<PathBuf> {
    Ok(app_data_dir()?.join("connections.db"))
}

pub fn activity_socket_path() -> Result<PathBuf> {
    Ok(app_data_dir()?.join("activity.sock"))
}

/// Open the metadata SQLite (creates file + table if missing).
pub async fn open_metadata() -> Result<SqlitePool> {
    let path = metadata_db_path()?;
    if !Path::new(&path).exists() {
        std::fs::File::create(&path).with_context(|| format!("create {:?}", path))?;
    }
    let url = format!("sqlite://{}", path.display());
    let pool = SqlitePoolOptions::new()
        .max_connections(4)
        .connect(&url)
        .await
        .with_context(|| format!("open sqlite {url}"))?;

    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS connections (
            id          TEXT PRIMARY KEY,
            name        TEXT UNIQUE NOT NULL,
            host        TEXT NOT NULL,
            port        INTEGER NOT NULL,
            database    TEXT NOT NULL,
            username    TEXT NOT NULL,
            ssl_mode    TEXT NOT NULL,
            created_at  INTEGER NOT NULL
        )"#,
    )
    .execute(&pool)
    .await?;

    // Sensitivity classifications — per-column PHI / PCI / PII labels.
    // Keyed by (connection_id, schema, table, column). Status starts at
    // 'pending' (heuristic suggestion) and is promoted to 'confirmed' on
    // user review.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS sensitivity_classifications (
            connection_id TEXT NOT NULL,
            schema_name   TEXT NOT NULL,
            table_name    TEXT NOT NULL,
            column_name   TEXT NOT NULL,
            category      TEXT NOT NULL,
            status        TEXT NOT NULL,
            reason        TEXT NOT NULL,
            created_at    INTEGER NOT NULL,
            PRIMARY KEY (connection_id, schema_name, table_name, column_name),
            FOREIGN KEY (connection_id) REFERENCES connections(id) ON DELETE CASCADE
        )"#,
    )
    .execute(&pool)
    .await?;

    Ok(pool)
}

const CONNECTION_COLUMNS: &str = "id, name, host, port, database, username, ssl_mode";

fn row_to_connection(r: &sqlx::sqlite::SqliteRow) -> Connection {
    Connection {
        id: r.get("id"),
        name: r.get("name"),
        host: r.get("host"),
        port: r.get::<i32, _>("port"),
        database: r.get("database"),
        username: r.get("username"),
        ssl_mode: r.get("ssl_mode"),
        connected: false,
    }
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Connection>> {
    let rows = sqlx::query(&format!(
        "SELECT {CONNECTION_COLUMNS} FROM connections ORDER BY name"
    ))
    .fetch_all(pool)
    .await?;
    Ok(rows.iter().map(row_to_connection).collect())
}

pub async fn get(pool: &SqlitePool, name: &str) -> Result<Connection> {
    let r = sqlx::query(&format!(
        "SELECT {CONNECTION_COLUMNS} FROM connections WHERE name = ?1"
    ))
    .bind(name)
    .fetch_optional(pool)
    .await?
    .with_context(|| format!("no connection named {name}"))?;
    Ok(row_to_connection(&r))
}

pub async fn insert(pool: &SqlitePool, input: &NewConnectionInput) -> Result<Connection> {
    if input.name.trim().is_empty() {
        anyhow::bail!("name is required");
    }
    let id = Uuid::new_v4().to_string();
    let created_at = chrono::Utc::now().timestamp();

    sqlx::query(
        "INSERT INTO connections (id, name, host, port, database, username, ssl_mode, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
    )
    .bind(&id)
    .bind(&input.name)
    .bind(&input.host)
    .bind(input.port)
    .bind(&input.database)
    .bind(&input.username)
    .bind(&input.ssl_mode)
    .bind(created_at)
    .execute(pool)
    .await
    .with_context(|| format!("insert connection {}", input.name))?;

    if !input.password.is_empty() {
        keyring::Entry::new(KEYRING_SERVICE, &input.name)
            .and_then(|e| e.set_password(&input.password))
            .with_context(|| format!("store keyring secret for {}", input.name))?;
    }

    Ok(Connection {
        id,
        name: input.name.clone(),
        host: input.host.clone(),
        port: input.port,
        database: input.database.clone(),
        username: input.username.clone(),
        ssl_mode: input.ssl_mode.clone(),
        connected: false,
    })
}

pub async fn delete(pool: &SqlitePool, name: &str) -> Result<()> {
    sqlx::query("DELETE FROM connections WHERE name = ?1")
        .bind(name)
        .execute(pool)
        .await?;
    if let Ok(entry) = keyring::Entry::new(KEYRING_SERVICE, name) {
        // Missing entry is fine; ignore that specific error class.
        let _ = entry.delete_credential();
    }
    let _ = delete_redaction_secret(name);
    Ok(())
}

/// Read the saved password, or return `None` if none was stored.
/// Passwordless connections (Teleport `tsh proxy db --tunnel`, trust auth,
/// cert auth, IAM auth) are first-class — only true keyring failures error.
pub fn get_password(name: &str) -> Result<Option<String>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, name)
        .with_context(|| format!("keyring entry for {name}"))?;
    match entry.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(anyhow::anyhow!(e)).with_context(|| format!("keyring read for {name}")),
    }
}

// ── Sensitivity classifications ─────────────────────────────────────

pub async fn list_classifications(
    pool: &SqlitePool,
    connection_id: &str,
) -> Result<Vec<Classification>> {
    let rows = sqlx::query(
        r#"SELECT schema_name, table_name, column_name, category, status, reason, created_at
           FROM sensitivity_classifications
           WHERE connection_id = ?1
           ORDER BY schema_name, table_name, column_name"#,
    )
    .bind(connection_id)
    .fetch_all(pool)
    .await
    .with_context(|| "list classifications")?;

    let mut out = Vec::with_capacity(rows.len());
    for r in &rows {
        let cat_db: String = r.get("category");
        let status_db: String = r.get("status");
        out.push(Classification {
            schema: r.get("schema_name"),
            table: r.get("table_name"),
            column: r.get("column_name"),
            category: Category::from_db(&cat_db)
                .with_context(|| format!("unknown category {cat_db}"))?,
            status: ClassificationStatus::from_db(&status_db)
                .with_context(|| format!("unknown status {status_db}"))?,
            reason: r.get("reason"),
            created_at: r.get::<i64, _>("created_at"),
        });
    }
    Ok(out)
}

pub async fn insert_classification(
    pool: &SqlitePool,
    connection_id: &str,
    schema: &str,
    table: &str,
    column: &str,
    category: Category,
    status: ClassificationStatus,
    reason: &str,
) -> Result<()> {
    let created_at = chrono::Utc::now().timestamp();
    sqlx::query(
        r#"INSERT OR IGNORE INTO sensitivity_classifications
              (connection_id, schema_name, table_name, column_name, category, status, reason, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)"#,
    )
    .bind(connection_id)
    .bind(schema)
    .bind(table)
    .bind(column)
    .bind(category.as_db())
    .bind(status.as_db())
    .bind(reason)
    .bind(created_at)
    .execute(pool)
    .await
    .with_context(|| format!("insert classification {schema}.{table}.{column}"))?;
    Ok(())
}

pub async fn set_classification_status(
    pool: &SqlitePool,
    connection_id: &str,
    schema: &str,
    table: &str,
    column: &str,
    status: ClassificationStatus,
) -> Result<()> {
    sqlx::query(
        r#"UPDATE sensitivity_classifications
              SET status = ?5
            WHERE connection_id = ?1
              AND schema_name = ?2
              AND table_name = ?3
              AND column_name = ?4"#,
    )
    .bind(connection_id)
    .bind(schema)
    .bind(table)
    .bind(column)
    .bind(status.as_db())
    .execute(pool)
    .await
    .with_context(|| format!("update classification status {schema}.{table}.{column}"))?;
    Ok(())
}

pub async fn set_classification_category(
    pool: &SqlitePool,
    connection_id: &str,
    schema: &str,
    table: &str,
    column: &str,
    category: Category,
) -> Result<()> {
    sqlx::query(
        r#"UPDATE sensitivity_classifications
              SET category = ?5
            WHERE connection_id = ?1
              AND schema_name = ?2
              AND table_name = ?3
              AND column_name = ?4"#,
    )
    .bind(connection_id)
    .bind(schema)
    .bind(table)
    .bind(column)
    .bind(category.as_db())
    .execute(pool)
    .await
    .with_context(|| format!("update classification category {schema}.{table}.{column}"))?;
    Ok(())
}

pub async fn delete_classification(
    pool: &SqlitePool,
    connection_id: &str,
    schema: &str,
    table: &str,
    column: &str,
) -> Result<()> {
    sqlx::query(
        r#"DELETE FROM sensitivity_classifications
            WHERE connection_id = ?1
              AND schema_name = ?2
              AND table_name = ?3
              AND column_name = ?4"#,
    )
    .bind(connection_id)
    .bind(schema)
    .bind(table)
    .bind(column)
    .execute(pool)
    .await
    .with_context(|| format!("delete classification {schema}.{table}.{column}"))?;
    Ok(())
}

// ── Redaction secret (keychain) ─────────────────────────────────────
//
// 32 random bytes per connection. Generated lazily on first classify; stable
// forever after. Stored in the keyring alongside (but distinct from) the
// connection's password. Removed when the connection is deleted.

fn redaction_secret_entry_name(conn_name: &str) -> String {
    format!("{REDACTION_SECRET_PREFIX}{conn_name}")
}

/// Generate a fresh secret if none exists for `conn_name`. No-op when present.
pub fn ensure_redaction_secret(conn_name: &str) -> Result<()> {
    if get_redaction_secret(conn_name)?.is_some() {
        return Ok(());
    }
    // 32 bytes of OS-RNG, hex-encoded for the keyring's string interface.
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    let entry = keyring::Entry::new(KEYRING_SERVICE, &redaction_secret_entry_name(conn_name))
        .with_context(|| format!("keyring entry for redaction:{conn_name}"))?;
    entry
        .set_password(&hex)
        .with_context(|| format!("store redaction secret for {conn_name}"))?;
    Ok(())
}

/// Read the secret as 32 raw bytes. `None` when no secret is stored yet.
pub fn get_redaction_secret(conn_name: &str) -> Result<Option<[u8; 32]>> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, &redaction_secret_entry_name(conn_name))
        .with_context(|| format!("keyring entry for redaction:{conn_name}"))?;
    match entry.get_password() {
        Ok(hex) => {
            if hex.len() != 64 {
                anyhow::bail!("redaction secret for {conn_name} is not 32 bytes hex");
            }
            let mut out = [0u8; 32];
            for i in 0..32 {
                out[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                    .with_context(|| format!("decode redaction secret hex for {conn_name}"))?;
            }
            Ok(Some(out))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => {
            Err(anyhow::anyhow!(e)).with_context(|| format!("keyring read redaction:{conn_name}"))
        }
    }
}

fn delete_redaction_secret(conn_name: &str) -> Result<()> {
    if let Ok(entry) =
        keyring::Entry::new(KEYRING_SERVICE, &redaction_secret_entry_name(conn_name))
    {
        let _ = entry.delete_credential();
    }
    Ok(())
}
