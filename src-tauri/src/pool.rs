use anyhow::{Context, Result};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::PgPool;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::connections;
use crate::types::Connection;

/// Who is asking for a pool. The two variants gate the *only* difference that
/// matters for connection authority: a human-driven core may open a pool on
/// demand; an agent-driven core may only ever use a pool a human already
/// opened. This is the single capability that makes "a human initiates the
/// connection" structural rather than advisory — see `Core::pool`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolAccess {
    /// UI / human path. `Core::pool` resolves via `ensure` (auto-open).
    Human,
    /// Agent / MCP path. `Core::pool` resolves via `get_open` (never opens).
    Agent,
}

#[derive(Default, Clone)]
pub struct PoolRegistry {
    inner: Arc<Mutex<HashMap<String, PgPool>>>,
}

impl PoolRegistry {
    pub async fn is_connected(&self, name: &str) -> bool {
        self.inner.lock().await.contains_key(name)
    }

    /// Return an already-open pool, or `None`. **Never opens a new pool.**
    /// This is the agent path's only way to reach Postgres, so it cannot
    /// connect to a database a human hasn't already opened in the workbench.
    pub async fn get_open(&self, name: &str) -> Option<PgPool> {
        self.inner.lock().await.get(name).cloned()
    }

    pub async fn drop_pool(&self, name: &str) {
        if let Some(p) = self.inner.lock().await.remove(name) {
            p.close().await;
        }
    }

    /// Open and ping a pool. Replaces any existing entry.
    pub async fn connect(&self, c: &Connection) -> Result<PgPool> {
        let mut opts = PgConnectOptions::from_str("postgres://")
            .unwrap_or_default()
            .host(&c.host)
            .port(c.port as u16)
            .username(&c.username)
            .database(&c.database)
            .ssl_mode(parse_ssl_mode(&c.ssl_mode));
        // Passwordless connections (Teleport tunnel, trust/peer/cert auth) are valid.
        if let Some(password) = connections::get_password(&c.name)? {
            if !password.is_empty() {
                opts = opts.password(&password);
            }
        }

        let pool = PgPoolOptions::new()
            .max_connections(4)
            .acquire_timeout(std::time::Duration::from_secs(10))
            .connect_with(opts)
            .await
            .with_context(|| format!("connect to {}:{}/{}", c.host, c.port, c.database))?;

        // Ping
        sqlx::query("SELECT 1").fetch_one(&pool).await.with_context(|| "ping failed")?;

        self.inner.lock().await.insert(c.name.clone(), pool.clone());
        Ok(pool)
    }

    /// Get an existing pool or create one on demand.
    pub async fn ensure(
        &self,
        meta: &sqlx::SqlitePool,
        name: &str,
    ) -> Result<PgPool> {
        {
            let guard = self.inner.lock().await;
            if let Some(p) = guard.get(name) {
                return Ok(p.clone());
            }
        }
        let conn = connections::get(meta, name).await?;
        self.connect(&conn).await
    }

    /// Test-only: register an already-open pool under `name`, bypassing the
    /// secret store and metadata lookup that `connect`/`ensure` require. Lets
    /// integration tests point a `Core` at a live test database without
    /// standing up the keychain or a real connection record.
    #[cfg(test)]
    pub(crate) async fn insert_for_test(&self, name: &str, pool: PgPool) {
        self.inner.lock().await.insert(name.to_string(), pool);
    }
}

fn parse_ssl_mode(s: &str) -> PgSslMode {
    match s.to_ascii_lowercase().as_str() {
        "disable" => PgSslMode::Disable,
        "require" => PgSslMode::Require,
        "verify-ca" => PgSslMode::VerifyCa,
        "verify-full" => PgSslMode::VerifyFull,
        _ => PgSslMode::Prefer,
    }
}
