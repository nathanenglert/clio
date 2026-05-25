use anyhow::{Context, Result};
use sqlx::{sqlite::SqlitePoolOptions, Row, SqlitePool};
use std::path::{Path, PathBuf};
use uuid::Uuid;

use crate::types::{
    Category, Classification, ClassificationStatus, Connection, NewConnectionInput, SavedQuery,
    SavedQueryInput, Snippet, SnippetInput,
};

const KEYRING_SERVICE: &str = "com.dbapp.poc";
/// Prefix on the keyring entry name. Keeps the redaction secret separate from
/// the connection password (which uses the bare connection name as the
/// keyring username field).
const REDACTION_SECRET_PREFIX: &str = "redaction:";

// ── Secret store ────────────────────────────────────────────────────
//
// Thin shim over the OS keyring. In debug builds, secrets live in a
// plaintext JSON file under app_data_dir so dev iteration doesn't trip
// the macOS keychain unlock prompt on every restart. Release builds
// always use the real keyring.

#[cfg(debug_assertions)]
mod secret_store {
    use super::app_data_dir;
    use anyhow::{Context, Result};
    use std::collections::HashMap;
    use std::path::PathBuf;

    fn store_path() -> Result<PathBuf> {
        Ok(app_data_dir()?.join("dev-secrets.json"))
    }

    fn load() -> Result<HashMap<String, String>> {
        let path = store_path()?;
        if !path.exists() {
            return Ok(HashMap::new());
        }
        let bytes = std::fs::read(&path).with_context(|| format!("read {:?}", path))?;
        Ok(serde_json::from_slice(&bytes).unwrap_or_default())
    }

    fn save(map: &HashMap<String, String>) -> Result<()> {
        let path = store_path()?;
        let bytes = serde_json::to_vec_pretty(map)?;
        std::fs::write(&path, bytes).with_context(|| format!("write {:?}", path))?;
        Ok(())
    }

    pub fn get(_service: &str, entry: &str) -> Result<Option<String>> {
        Ok(load()?.get(entry).cloned())
    }

    pub fn set(_service: &str, entry: &str, value: &str) -> Result<()> {
        let mut map = load()?;
        map.insert(entry.to_string(), value.to_string());
        save(&map)
    }

    pub fn delete(_service: &str, entry: &str) -> Result<()> {
        let mut map = load()?;
        map.remove(entry);
        save(&map)
    }
}

#[cfg(not(debug_assertions))]
mod secret_store {
    use anyhow::{Context, Result};

    pub fn get(service: &str, entry: &str) -> Result<Option<String>> {
        let e = keyring::Entry::new(service, entry)
            .with_context(|| format!("keyring entry for {entry}"))?;
        match e.get_password() {
            Ok(p) => Ok(Some(p)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(err) => Err(anyhow::anyhow!(err))
                .with_context(|| format!("keyring read for {entry}")),
        }
    }

    pub fn set(service: &str, entry: &str, value: &str) -> Result<()> {
        keyring::Entry::new(service, entry)
            .and_then(|e| e.set_password(value))
            .with_context(|| format!("store keyring secret for {entry}"))
    }

    pub fn delete(service: &str, entry: &str) -> Result<()> {
        if let Ok(e) = keyring::Entry::new(service, entry) {
            // Missing entry is fine; ignore that specific error class.
            let _ = e.delete_credential();
        }
        Ok(())
    }
}

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

    // SQL editor snippets — user-managed templates surfaced in autocomplete.
    // Global scope: SQL is portable across connections. `prefix` is the
    // expansion trigger (unique, case-insensitive); `body` carries CodeMirror
    // ${var} tab stops.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS snippets (
            id          TEXT PRIMARY KEY,
            name        TEXT NOT NULL,
            prefix      TEXT NOT NULL UNIQUE COLLATE NOCASE,
            body        TEXT NOT NULL,
            description TEXT NOT NULL DEFAULT '',
            created_at  INTEGER NOT NULL,
            updated_at  INTEGER NOT NULL
        )"#,
    )
    .execute(&pool)
    .await?;

    seed_default_snippets(&pool).await?;

    // Saved queries — named persistent SQL surfaced in the Library sidebar.
    // Scope is encoded by connection_name: NULL = global; otherwise visible
    // only when that connection is active. We don't FK to the connections row
    // (scope is a name string, not an id) so renaming a connection won't
    // cascade — that's intentional: scopes follow the display name.
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS saved_queries (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            body            TEXT NOT NULL,
            description     TEXT NOT NULL DEFAULT '',
            connection_name TEXT NULL,
            created_at      INTEGER NOT NULL,
            updated_at      INTEGER NOT NULL
        )"#,
    )
    .execute(&pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS saved_queries_name_idx
             ON saved_queries (LOWER(name))",
    )
    .execute(&pool)
    .await?;
    sqlx::query(
        "CREATE INDEX IF NOT EXISTS saved_queries_conn_idx
             ON saved_queries (connection_name)",
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
        secret_store::set(KEYRING_SERVICE, &input.name, &input.password)?;
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
    let _ = secret_store::delete(KEYRING_SERVICE, name);
    let _ = delete_redaction_secret(name);
    Ok(())
}

/// Read the saved password, or return `None` if none was stored.
/// Passwordless connections (Teleport `tsh proxy db --tunnel`, trust auth,
/// cert auth, IAM auth) are first-class — only true keyring failures error.
pub fn get_password(name: &str) -> Result<Option<String>> {
    secret_store::get(KEYRING_SERVICE, name)
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
    use rand::RngCore;
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut bytes);
    let hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
    secret_store::set(
        KEYRING_SERVICE,
        &redaction_secret_entry_name(conn_name),
        &hex,
    )
}

/// Read the secret as 32 raw bytes. `None` when no secret is stored yet.
pub fn get_redaction_secret(conn_name: &str) -> Result<Option<[u8; 32]>> {
    let hex = match secret_store::get(KEYRING_SERVICE, &redaction_secret_entry_name(conn_name))? {
        Some(h) => h,
        None => return Ok(None),
    };
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

fn delete_redaction_secret(conn_name: &str) -> Result<()> {
    secret_store::delete(KEYRING_SERVICE, &redaction_secret_entry_name(conn_name))
}

// ── Snippets ──────────────────────────────────────────────────────

fn row_to_snippet(r: &sqlx::sqlite::SqliteRow) -> Snippet {
    Snippet {
        id: r.get("id"),
        name: r.get("name"),
        prefix: r.get("prefix"),
        body: r.get("body"),
        description: r.get("description"),
        created_at: r.get::<i64, _>("created_at"),
        updated_at: r.get::<i64, _>("updated_at"),
    }
}

pub async fn list_snippets(pool: &SqlitePool) -> Result<Vec<Snippet>> {
    let rows = sqlx::query(
        "SELECT id, name, prefix, body, description, created_at, updated_at
         FROM snippets ORDER BY LOWER(name)",
    )
    .fetch_all(pool)
    .await
    .with_context(|| "list snippets")?;
    Ok(rows.iter().map(row_to_snippet).collect())
}

/// Insert or update a snippet. When `input.id` is None, a fresh UUID is
/// minted; when present, the row is updated in place (preserving created_at).
/// Returns the resulting Snippet.
pub async fn upsert_snippet(pool: &SqlitePool, input: SnippetInput) -> Result<Snippet> {
    let name = input.name.trim().to_string();
    let prefix = input.prefix.trim().to_string();
    let body = input.body;
    let description = input.description;
    if name.is_empty() {
        anyhow::bail!("name is required");
    }
    if prefix.is_empty() {
        anyhow::bail!("prefix is required");
    }
    if !prefix.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        anyhow::bail!("prefix may only contain letters, digits, and underscores");
    }
    if body.trim().is_empty() {
        anyhow::bail!("body is required");
    }
    let now = chrono::Utc::now().timestamp();
    match input.id {
        Some(id) => {
            sqlx::query(
                "UPDATE snippets
                    SET name = ?2, prefix = ?3, body = ?4, description = ?5, updated_at = ?6
                  WHERE id = ?1",
            )
            .bind(&id)
            .bind(&name)
            .bind(&prefix)
            .bind(&body)
            .bind(&description)
            .bind(now)
            .execute(pool)
            .await
            .with_context(|| format!("update snippet {id}"))?;
            let r = sqlx::query(
                "SELECT id, name, prefix, body, description, created_at, updated_at
                   FROM snippets WHERE id = ?1",
            )
            .bind(&id)
            .fetch_one(pool)
            .await
            .with_context(|| format!("re-read snippet {id}"))?;
            Ok(row_to_snippet(&r))
        }
        None => {
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO snippets (id, name, prefix, body, description, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            )
            .bind(&id)
            .bind(&name)
            .bind(&prefix)
            .bind(&body)
            .bind(&description)
            .bind(now)
            .execute(pool)
            .await
            .with_context(|| format!("insert snippet {name}"))?;
            Ok(Snippet {
                id,
                name,
                prefix,
                body,
                description,
                created_at: now,
                updated_at: now,
            })
        }
    }
}

pub async fn delete_snippet(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM snippets WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .with_context(|| format!("delete snippet {id}"))?;
    Ok(())
}

// ── Saved queries ────────────────────────────────────────────────

const SAVED_QUERY_COLUMNS: &str =
    "id, name, body, description, connection_name, created_at, updated_at";

fn row_to_saved_query(r: &sqlx::sqlite::SqliteRow) -> SavedQuery {
    SavedQuery {
        id: r.get("id"),
        name: r.get("name"),
        body: r.get("body"),
        description: r.get("description"),
        connection_name: r.get("connection_name"),
        created_at: r.get::<i64, _>("created_at"),
        updated_at: r.get::<i64, _>("updated_at"),
    }
}

/// Lists saved queries visible in the given scope. When `connection` is None,
/// returns only globals. When Some, returns globals plus entries scoped to
/// that connection. Always sorted by name (case-insensitive).
pub async fn list_saved_queries(
    pool: &SqlitePool,
    connection: Option<&str>,
) -> Result<Vec<SavedQuery>> {
    let rows = match connection {
        Some(name) => sqlx::query(&format!(
            "SELECT {SAVED_QUERY_COLUMNS}
               FROM saved_queries
              WHERE connection_name IS NULL OR connection_name = ?1
              ORDER BY LOWER(name)"
        ))
        .bind(name)
        .fetch_all(pool)
        .await
        .with_context(|| "list saved queries (scoped)")?,
        None => sqlx::query(&format!(
            "SELECT {SAVED_QUERY_COLUMNS}
               FROM saved_queries
              WHERE connection_name IS NULL
              ORDER BY LOWER(name)"
        ))
        .fetch_all(pool)
        .await
        .with_context(|| "list saved queries (global)")?,
    };
    Ok(rows.iter().map(row_to_saved_query).collect())
}

/// Insert or update a saved query. When `input.id` is None a fresh UUID is
/// minted; when present the row is updated in place (created_at preserved).
pub async fn upsert_saved_query(pool: &SqlitePool, input: SavedQueryInput) -> Result<SavedQuery> {
    let name = input.name.trim().to_string();
    let body = input.body;
    let description = input.description;
    let connection_name = input.connection_name.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    if name.is_empty() {
        anyhow::bail!("name is required");
    }
    if body.trim().is_empty() {
        anyhow::bail!("body is required");
    }
    let now = chrono::Utc::now().timestamp();
    match input.id {
        Some(id) => {
            sqlx::query(
                "UPDATE saved_queries
                    SET name = ?2, body = ?3, description = ?4,
                        connection_name = ?5, updated_at = ?6
                  WHERE id = ?1",
            )
            .bind(&id)
            .bind(&name)
            .bind(&body)
            .bind(&description)
            .bind(&connection_name)
            .bind(now)
            .execute(pool)
            .await
            .with_context(|| format!("update saved query {id}"))?;
            let r = sqlx::query(&format!(
                "SELECT {SAVED_QUERY_COLUMNS} FROM saved_queries WHERE id = ?1"
            ))
            .bind(&id)
            .fetch_one(pool)
            .await
            .with_context(|| format!("re-read saved query {id}"))?;
            Ok(row_to_saved_query(&r))
        }
        None => {
            let id = Uuid::new_v4().to_string();
            sqlx::query(
                "INSERT INTO saved_queries
                    (id, name, body, description, connection_name, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
            )
            .bind(&id)
            .bind(&name)
            .bind(&body)
            .bind(&description)
            .bind(&connection_name)
            .bind(now)
            .execute(pool)
            .await
            .with_context(|| format!("insert saved query {name}"))?;
            Ok(SavedQuery {
                id,
                name,
                body,
                description,
                connection_name,
                created_at: now,
                updated_at: now,
            })
        }
    }
}

pub async fn delete_saved_query(pool: &SqlitePool, id: &str) -> Result<()> {
    sqlx::query("DELETE FROM saved_queries WHERE id = ?1")
        .bind(id)
        .execute(pool)
        .await
        .with_context(|| format!("delete saved query {id}"))?;
    Ok(())
}

/// Insert the built-in starter set on first launch (empty table). Idempotent —
/// re-runs do nothing once snippets exist. Users can edit or delete these
/// freely; we never re-seed.
async fn seed_default_snippets(pool: &SqlitePool) -> Result<()> {
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM snippets")
        .fetch_one(pool)
        .await?;
    if count > 0 {
        return Ok(());
    }
    let now = chrono::Utc::now().timestamp();
    let defaults: &[(&str, &str, &str, &str)] = &[
        (
            "select … from",
            "sf",
            "select ${columns} from ${table}${}",
            "Pick columns from a table.",
        ),
        (
            "select * from … where",
            "sfw",
            "select * from ${table} where ${condition}${}",
            "Filtered scan with a where clause.",
        ),
        (
            "select … join",
            "sj",
            "select ${cols}\nfrom ${table_a} a\njoin ${table_b} b on a.${a_id} = b.${b_id}\nwhere ${condition}${}",
            "Two-table inner join with aliases.",
        ),
        (
            "insert into …",
            "ins",
            "insert into ${table} (${cols})\nvalues (${vals})${}",
            "Plain insert.",
        ),
        (
            "update … set",
            "upd",
            "update ${table}\nset ${col} = ${val}\nwhere ${condition}${}",
            "Targeted update with a where clause.",
        ),
        (
            "with … as (CTE)",
            "cte",
            "with ${cte} as (\n  ${query}\n)\nselect * from ${cte}${}",
            "Common table expression scaffold.",
        ),
        (
            "case when … else",
            "case",
            "case when ${condition} then ${then} else ${else} end${}",
            "Inline conditional expression.",
        ),
    ];
    for (name, prefix, body, description) in defaults {
        let id = Uuid::new_v4().to_string();
        sqlx::query(
            "INSERT INTO snippets (id, name, prefix, body, description, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
        )
        .bind(&id)
        .bind(name)
        .bind(prefix)
        .bind(body)
        .bind(description)
        .bind(now)
        .execute(pool)
        .await?;
    }
    Ok(())
}
