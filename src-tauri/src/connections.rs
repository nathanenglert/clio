use anyhow::{Context, Result};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::types::{Connection, NewConnectionInput};

const KEYRING_SERVICE: &str = "com.dbapp.poc";

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

    Ok(pool)
}

pub async fn list(pool: &SqlitePool) -> Result<Vec<Connection>> {
    let rows = sqlx::query(
        "SELECT id, name, host, port, database, username, ssl_mode FROM connections ORDER BY name",
    )
    .fetch_all(pool)
    .await?;
    let mut out = Vec::with_capacity(rows.len());
    for r in rows {
        out.push(Connection {
            id: r.get("id"),
            name: r.get("name"),
            host: r.get("host"),
            port: r.get::<i32, _>("port"),
            database: r.get("database"),
            username: r.get("username"),
            ssl_mode: r.get("ssl_mode"),
            connected: false,
        });
    }
    Ok(out)
}

pub async fn get(pool: &SqlitePool, name: &str) -> Result<Connection> {
    let r = sqlx::query(
        "SELECT id, name, host, port, database, username, ssl_mode FROM connections WHERE name = ?1",
    )
    .bind(name)
    .fetch_optional(pool)
    .await?
    .with_context(|| format!("no connection named {name}"))?;
    Ok(Connection {
        id: r.get("id"),
        name: r.get("name"),
        host: r.get("host"),
        port: r.get::<i32, _>("port"),
        database: r.get("database"),
        username: r.get("username"),
        ssl_mode: r.get("ssl_mode"),
        connected: false,
    })
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
