use anyhow::Result;
use sqlx::SqlitePool;
use std::time::Instant;

use crate::activity::{record, record_with_payload, EmitFn};
use crate::pool::PoolRegistry;

mod export;
mod lifecycle;
mod mutations;
mod query;
pub(crate) mod redactor;
mod schema;
mod sensitivity;

pub use export::{export_query, write_file};
pub use lifecycle::{add_connection, connect, delete_connection, disconnect, list_connections};
pub use mutations::apply_mutations;
pub use query::run_query;
pub use schema::{describe_table, list_schemas, list_tables, search_columns};
pub use sensitivity::{classify_schema, list_classifications, update_classification};

use redactor::RedactorCache;

/// Container the UI- and MCP-mode entry points both hand to core fns.
#[derive(Clone)]
pub struct Core {
    pub meta: SqlitePool,
    pub pools: PoolRegistry,
    pub emit: EmitFn,
    pub source: String, // "ui" | "mcp"
    /// Lazy-built cache of `(table_oid, attnum) → Category` per connection.
    /// Invalidated by `update_classification` and connection drop.
    pub(crate) redactor_cache: RedactorCache,
}

impl Core {
    /// Convenience: emit a synchronous ok/err event.
    pub(crate) fn record_ok<T>(
        &self,
        tool: &str,
        detail: impl Into<String>,
        started: Instant,
        result: &Result<T>,
    ) {
        record(&self.emit, &self.source, tool, detail, started, result);
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
        record_with_payload(&self.emit, &self.source, tool, detail, payload, started, result);
    }
}
