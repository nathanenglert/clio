use anyhow::{Context, Result};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::PgPool;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::connections;
use crate::types::Connection;

#[derive(Default, Clone)]
pub struct PoolRegistry {
    inner: Arc<Mutex<HashMap<String, PgPool>>>,
}

impl PoolRegistry {
    pub async fn is_connected(&self, name: &str) -> bool {
        self.inner.lock().await.contains_key(name)
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
