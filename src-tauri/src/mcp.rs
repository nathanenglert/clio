//! rmcp 1.7 server. Tool handlers call into `core::*` exactly the way the
//! Tauri commands do — same functions, same emitter, same activity events.

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

    #[tool(description = "List tables and views in the given schema.")]
    async fn list_tables(
        &self,
        Parameters(SchemaArg { connection, schema }): Parameters<SchemaArg>,
    ) -> Result<CallToolResult, McpError> {
        let r = core::list_tables(&self.core, &connection, &schema)
            .await
            .map_err(err)?;
        ok_json(r)
    }

    #[tool(description = "Describe a table: columns with data types, nullability, defaults, primary-key membership.")]
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
            "Postgres workbench MCP server. Tools: list_connections, connect, list_schemas, list_tables, describe_table, run_query. All schema/query tools require a `connection` arg matching a name from list_connections. Reads only — writes/DDL rejected.",
        )
    }
}
