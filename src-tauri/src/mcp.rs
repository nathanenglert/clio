//! rmcp 1.7 server. Tool handlers call into `core::*` exactly the way the
//! Tauri commands do — same functions, same emitter, same activity events.

use std::time::Instant;

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars,
    tool, tool_handler, tool_router,
    ErrorData as McpError, ServerHandler,
};

use crate::core::{self, Core};

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ConnArg {
    /// Connection name as it appears in the workbench.
    pub connection: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct SchemaArg {
    pub connection: String,
    pub schema: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct TableArg {
    pub connection: String,
    pub schema: String,
    pub table: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct QueryArg {
    pub connection: String,
    /// SELECT / WITH-SELECT only. Writes/DDL rejected at the POC seam.
    pub sql: String,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ProposeQueryArg {
    /// SQL to surface to the human for review. Any statement — the workbench
    /// will NOT auto-run it.
    pub sql: String,
    /// Optional short label for the tab (e.g. "active appointments"). Defaults
    /// to "Proposed query".
    #[serde(default)]
    pub title: Option<String>,
}

/// Cap full-text payloads (e.g. SQL) emitted on activity events so a long
/// statement can't blow the socket reader's line buffer. Mirrors
/// core::query::cap_payload — duplicated here because that helper is
/// module-private and the constant is small.
const PROPOSE_PAYLOAD_MAX_BYTES: usize = 4096;
fn cap_payload(s: &str) -> String {
    if s.len() <= PROPOSE_PAYLOAD_MAX_BYTES {
        return s.to_string();
    }
    let mut end = PROPOSE_PAYLOAD_MAX_BYTES;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    let mut out = String::with_capacity(end + 4);
    out.push_str(&s[..end]);
    out.push_str(" …");
    out
}

#[derive(Clone)]
pub struct McpServer {
    core: Core,
    #[allow(dead_code)] // populated for the #[tool_router] macro
    tool_router: ToolRouter<McpServer>,
}

impl McpServer {
    pub fn new(core: Core) -> Self {
        Self {
            core,
            tool_router: Self::tool_router(),
        }
    }
}

fn ok_json(v: impl serde::Serialize) -> Result<CallToolResult, McpError> {
    let json = serde_json::to_string_pretty(&v)
        .map_err(|e| McpError::internal_error(e.to_string(), None))?;
    Ok(CallToolResult::success(vec![Content::text(json)]))
}

fn err(e: anyhow::Error) -> McpError {
    McpError::internal_error(format!("{e:#}"), None)
}

#[tool_router]
impl McpServer {
    #[tool(description = "List saved connections in the workbench. Returns name/host/port/database/username/ssl_mode/connected. Passwords are never returned.")]
    async fn list_connections(&self) -> Result<CallToolResult, McpError> {
        let r = core::list_connections(&self.core).await.map_err(err)?;
        ok_json(r)
    }

    #[tool(description = "Open (or re-open) a Postgres pool for the named connection and ping it. Idempotent.")]
    async fn connect(
        &self,
        Parameters(ConnArg { connection }): Parameters<ConnArg>,
    ) -> Result<CallToolResult, McpError> {
        core::connect(&self.core, &connection).await.map_err(err)?;
        ok_json(serde_json::json!({ "connected": connection }))
    }

    #[tool(description = "List non-system schemas for the named connection.")]
    async fn list_schemas(
        &self,
        Parameters(ConnArg { connection }): Parameters<ConnArg>,
    ) -> Result<CallToolResult, McpError> {
        let r = core::list_schemas(&self.core, &connection).await.map_err(err)?;
        ok_json(r)
    }

    #[tool(description = "List tables/views/matviews in the given schema. Returns objects with `name`, `kind` (table|view|matview|partitioned|foreign), and `row_estimate` (planner estimate from pg_class.reltuples; omitted if never analyzed).")]
    async fn list_tables(
        &self,
        Parameters(SchemaArg { connection, schema }): Parameters<SchemaArg>,
    ) -> Result<CallToolResult, McpError> {
        let r = core::list_tables(&self.core, &connection, &schema)
            .await
            .map_err(err)?;
        ok_json(r)
    }

    #[tool(description = "Describe a relation. Returns: `kind` (table|view|matview|partitioned|foreign), `columns` (name/data_type/is_nullable/default/is_primary_key/enum_values), `indexes` (name/definition/is_unique/is_primary/columns), `constraints` (name/kind=primary_key|foreign_key|unique|check|exclusion, definition, columns, references for FK), `triggers` (name/timing/events/level/definition; FK-synthesized triggers excluded), and `view_definition` (sql + is_materialized) when the relation is a view or matview.")]
    async fn describe_table(
        &self,
        Parameters(TableArg {
            connection,
            schema,
            table,
        }): Parameters<TableArg>,
    ) -> Result<CallToolResult, McpError> {
        let r = core::describe_table(&self.core, &connection, &schema, &table)
            .await
            .map_err(err)?;
        ok_json(r)
    }

    #[tool(description = "Run a SELECT (or WITH-prefixed SELECT) and return columns + rows. Writes/DDL are rejected at the POC seam. Capped at 1000 rows; the `truncated` field signals overflow. Columns classified as PHI/PCI/PII are always redacted on the MCP path — see redaction_meta.")]
    async fn run_query(
        &self,
        Parameters(QueryArg { connection, sql }): Parameters<QueryArg>,
    ) -> Result<CallToolResult, McpError> {
        // ── Privacy invariant ─────────────────────────────────────
        // The MCP handler ALWAYS calls core::run_query with reveal=false. The
        // workbench UI's `View > Reveal sensitive data` toggle CANNOT reach
        // this code path — see design/redaction.md §"MCP scope".
        let r = core::run_query(&self.core, &connection, &sql, /* reveal */ false)
            .await
            .map_err(err)?;
        ok_json(r)
    }

    #[tool(description = "Open a new query tab in the workbench with the given SQL and switch the human to it. Use this when you want the human to REVIEW a query before running it — the tab is marked 'written by agent' and will NOT auto-run; the human reviews and presses Run themselves. The tab opens under whichever connection the human is currently viewing (no connection arg). Returns immediately; the tool succeeds even if no UI is attached.")]
    async fn propose_query(
        &self,
        Parameters(ProposeQueryArg { sql, title }): Parameters<ProposeQueryArg>,
    ) -> Result<CallToolResult, McpError> {
        let started = Instant::now();
        let detail = title.unwrap_or_else(|| "Proposed query".to_string());
        let payload = Some(cap_payload(&sql));
        // Fire-and-forget on the activity socket. We construct a synthetic
        // Ok result so record_ok_with_payload emits a status="ok" event; the
        // frontend listener turns it into a new agent-authored tab + toast.
        let result: anyhow::Result<()> = Ok(());
        self.core
            .record_ok_with_payload("propose_query", detail.clone(), payload, started, &result);
        ok_json(serde_json::json!({ "proposed": true, "title": detail }))
    }
}

#[tool_handler]
impl ServerHandler for McpServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_server_info(Implementation::from_build_env())
        .with_instructions(
            "Postgres workbench MCP server. Tools: list_connections, connect, list_schemas, list_tables, describe_table, run_query, propose_query. All schema/query tools require a `connection` arg matching a name from list_connections. Reads only — writes/DDL rejected. Use `propose_query` to surface a SQL statement to the human for review (opens a new editor tab; does not auto-run).",
        )
    }
}
