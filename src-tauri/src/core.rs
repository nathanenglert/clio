use anyhow::Result;
use sqlx::{PgPool, SqlitePool};
use std::time::Instant;

use crate::activity::{record, record_with_payload, EmitFn};
use crate::pool::{PoolAccess, PoolRegistry};

mod execute;
mod export;
mod lifecycle;
mod mutations;
pub(crate) mod permission;
pub(crate) mod policy;
mod query;
pub(crate) mod redactor;
mod saved_queries;
mod schema;
mod sensitivity;
mod snippets;

pub use execute::{execute_migration, execute_statement};
pub use export::{export_query, write_file};
pub use lifecycle::{
    add_connection, connect, delete_connection, disconnect, list_connections, propose_query,
};
pub use mutations::apply_mutations;
pub use query::{run_query, run_sql};
pub use saved_queries::{delete_saved_query, list_saved_queries, upsert_saved_query};
pub use schema::{describe_table, list_schemas, list_tables, search_columns};
pub use sensitivity::{classify_schema, list_classifications, update_classification};
pub use snippets::{delete_snippet, list_snippets, upsert_snippet};

use permission::{PendingMigrations, PendingPermissions};
use redactor::RedactorCache;

/// Container the UI- and MCP-mode entry points both hand to core fns.
#[derive(Clone)]
pub struct Core {
    pub meta: SqlitePool,
    pub pools: PoolRegistry,
    pub emit: EmitFn,
    pub source: String, // "ui" | "mcp"
    /// Whether this core may open Postgres pools on demand (`Human`) or may
    /// only use pools a human already opened (`Agent`). Read at exactly one
    /// site — `Core::pool` — so every query/schema/execute path inherits the
    /// right behavior without threading a flag through each call.
    pub pool_access: PoolAccess,
    /// Identifies the agent on the proxied-MCP path so activity events and
    /// permission requests can be attributed to a specific agent. `None` on
    /// the human (UI) core. Set per connection via [`Core::for_agent`].
    pub agent_id: Option<String>,
    /// Lazy-built cache of `(table_oid, attnum) → Category` per connection.
    /// Invalidated by `update_classification` and connection drop.
    pub(crate) redactor_cache: RedactorCache,
    /// Pending permission requests awaiting a UI verdict. Populated by
    /// `execute_statement` when a Prompt verdict fires; drained by the
    /// `resolve_permission` Tauri command.
    pub(crate) pending_permissions: PendingPermissions,
    /// Pending bulk migrations awaiting a UI verdict. Populated by
    /// `execute_migration`; drained by the `resolve_migration` Tauri command.
    pub(crate) pending_migrations: PendingMigrations,
}

impl Core {
    /// Build the UI (human) core and its agent sibling for the running
    /// workbench. They share one pool registry, metadata handle, redactor
    /// cache, and pending-verdict registries — so a verdict the human gives in
    /// the UI resolves the agent-core call that's parked on it, and a
    /// classification change invalidates redaction for both. The human core
    /// may open pools; the agent core may not.
    pub fn ui_with_agent(meta: SqlitePool, pools: PoolRegistry, emit: EmitFn) -> (Core, Core) {
        let pending_permissions = PendingPermissions::default();
        let pending_migrations = PendingMigrations::default();
        let redactor_cache = RedactorCache::default();
        let human = Core {
            meta: meta.clone(),
            pools: pools.clone(),
            emit: emit.clone(),
            source: "ui".into(),
            pool_access: PoolAccess::Human,
            agent_id: None,
            redactor_cache: redactor_cache.clone(),
            pending_permissions: pending_permissions.clone(),
            pending_migrations: pending_migrations.clone(),
        };
        let agent = Core {
            meta,
            pools,
            emit,
            source: "mcp".into(),
            pool_access: PoolAccess::Agent,
            agent_id: None,
            redactor_cache,
            pending_permissions,
            pending_migrations,
        };
        (human, agent)
    }

    /// The single seam every query/schema/execute path uses to acquire a
    /// Postgres pool. A `Human` core may open the pool on demand; an `Agent`
    /// core may only use a pool a human already opened, so an agent can never
    /// reach a database the human hasn't connected in the workbench. Routing
    /// *all* pool acquisition through here (rather than calling
    /// `PoolRegistry::ensure` directly) keeps that guarantee from silently
    /// regressing when a new call site is added.
    pub(crate) async fn pool(&self, conn: &str) -> Result<PgPool> {
        match self.pool_access {
            PoolAccess::Human => self.pools.ensure(&self.meta, conn).await,
            PoolAccess::Agent => self.pools.get_open(conn).await.ok_or_else(|| {
                anyhow::anyhow!(
                    "not connected: a human must connect '{conn}' in the workbench \
                     before an agent can use it"
                )
            }),
        }
    }

    /// Clone this core, pinning it to a specific agent for attribution. Used
    /// by the bridge listener so each connected agent's activity and
    /// permission requests carry its `agent_id`.
    pub(crate) fn for_agent(&self, agent_id: String, _label: String) -> Core {
        let mut c = self.clone();
        c.agent_id = Some(agent_id);
        c
    }

    /// Convenience: emit a synchronous ok/err event.
    pub(crate) fn record_ok<T>(
        &self,
        tool: &str,
        detail: impl Into<String>,
        started: Instant,
        result: &Result<T>,
    ) {
        record(&self.emit, &self.source, self.agent_id.as_deref(), tool, detail, started, result);
    }

    /// Same as [`Self::record_ok`] but attaches a full-fidelity payload
    /// (e.g. the un-truncated SQL for `run_query`).
    pub(crate) fn record_ok_with_payload<T>(
        &self,
        tool: &str,
        detail: impl Into<String>,
        payload: Option<String>,
        started: Instant,
        result: &Result<T>,
    ) {
        record_with_payload(
            &self.emit,
            &self.source,
            self.agent_id.as_deref(),
            tool,
            detail,
            payload,
            started,
            result,
        );
    }
}
