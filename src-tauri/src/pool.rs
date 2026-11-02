use anyhow::{Context, Result};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions, PgSslMode};
use sqlx::PgPool;
use std::collections::HashMap;
use std::str::FromStr;
use std::sync::Arc;
use tokio::sync::Mutex;

use crate::connections;
use crate::types::Connection;

/// Who is asking for a pool. Neither variant can open one — only the explicit
/// `connect` command does. A human-driven core may use any open pool; an
/// agent-driven core may only use a pool a human opened *and* whose
/// sensitivity scan completed. This is the capability that makes "a human
/// initiates the connection" structural rather than advisory — see `Core::pool`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PoolAccess {
    /// UI / human path. `Core::pool` resolves via `get_open`.
    Human,
    /// Agent / MCP path. `Core::pool` resolves via `get_for_agent`.
    Agent,
}

/// An open pool plus whether the sensitivity classifier has completed against
/// it. Agents may only use a pool once `classified` is set; see
/// [`PoolRegistry::get_for_agent`].
struct OpenPool {
    pool: PgPool,
    classified: bool,
}

#[derive(Default, Clone)]
pub struct PoolRegistry {
    inner: Arc<Mutex<HashMap<String, OpenPool>>>,
}

impl PoolRegistry {
    /// Whether a pool is open for `name` (the human's view of "connected").
    pub async fn is_connected(&self, name: &str) -> bool {
        self.inner.lock().await.contains_key(name)
    }

    /// Whether an agent may use `name`: the pool is open *and* its sensitivity
    /// scan completed. This is the agent's view of "connected".
    pub async fn is_agent_ready(&self, name: &str) -> bool {
        self.inner.lock().await.get(name).is_some_and(|p| p.classified)
    }

    /// Return an already-open pool, or `None`. **Never opens a new pool** —
    /// only the explicit `connect` command does, so every open pool has been
    /// through the classifier.
    pub async fn get_open(&self, name: &str) -> Option<PgPool> {
        self.inner.lock().await.get(name).map(|p| p.pool.clone())
    }

    /// The agent path's only way to reach Postgres: an open pool whose
    /// sensitivity scan completed, or `None`. A pool that is still being
    /// classified, or whose scan failed, has no classifications to redact with
    /// yet, so handing it to an agent would return real values — fail closed.
    pub async fn get_for_agent(&self, name: &str) -> Option<PgPool> {
        self.inner
            .lock()
            .await
            .get(name)
            .filter(|p| p.classified)
            .map(|p| p.pool.clone())
    }

    /// Record that the classifier completed against the open pool for `name`.
    pub async fn mark_classified(&self, name: &str) {
        if let Some(p) = self.inner.lock().await.get_mut(name) {
            p.classified = true;
        }
    }

    pub async fn drop_pool(&self, name: &str) {
        if let Some(p) = self.inner.lock().await.remove(name) {
            p.pool.close().await;
        }
    }

    /// Open and ping a pool. Replaces any existing entry. The new pool starts
    /// unclassified, so agents can't use it until the classifier completes.
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

        self.inner.lock().await.insert(
            c.name.clone(),
            OpenPool {
                pool: pool.clone(),
                classified: false,
            },
        );
        Ok(pool)
    }

    /// Test-only: register an already-open pool under `name`, bypassing the
    /// secret store and metadata lookup that `connect` requires. Lets
    /// integration tests point a `Core` at a live test database without
    /// standing up the keychain or a real connection record. `classified`
    /// simulates whether the post-connect sensitivity scan completed.
    #[cfg(test)]
    pub(crate) async fn insert_for_test(&self, name: &str, pool: PgPool, classified: bool) {
        self.inner
            .lock()
            .await
            .insert(name.to_string(), OpenPool { pool, classified });
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
