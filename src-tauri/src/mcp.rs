//! rmcp 1.7 server — a thin proxy. Each DB-touching tool forwards a
//! `ToolCall` over the Unix socket to the running UI process (see
//! `bridge.rs`), which owns the only Postgres pool and credentials and runs
//! the call only if a human has connected that database. This process holds no
//! pool, no credentials, and no metadata DB.

use rmcp::{
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    schemars,
    service::{RequestContext, RoleServer},
    tool, tool_handler, tool_router,
    ErrorData as McpError, ServerHandler,
};

use crate::bridge::{ProxyClient, ToolCall};

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

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ExecuteStatementArg {
    /// Connection name as it appears in the workbench.
    pub connection: String,
    /// Any SQL statement. Read statements that pass policy run immediately;
    /// writes/DDL go through the permission gate (human approves before run).
    pub sql: String,
    /// Optional plain-English description of what the agent intends. Shown on
    /// the permission card so the human sees the agent's reasoning, not just
    /// the SQL.
    #[serde(default)]
    pub intent: Option<String>,
}

#[derive(serde::Deserialize, schemars::JsonSchema)]
pub struct ExecuteMigrationArg {
    /// Connection name as it appears in the workbench.
    pub connection: String,
    /// Each entry MUST be a single SQL statement. The workbench classifies
    /// the whole batch up front, shows the human a numbered plan, and only
    /// runs it after they approve. Deviations pause one-by-one during
    /// execution via the standard permission card.
    pub statements: Vec<String>,
    /// Optional plain-English description of the migration's purpose.
    #[serde(default)]
    pub intent: Option<String>,
}

#[derive(Clone)]
pub struct McpServer {
    proxy: ProxyClient,
    #[allow(dead_code)] // populated for the #[tool_router] macro
    tool_router: ToolRouter<McpServer>,
}

impl McpServer {
    pub fn new(proxy: ProxyClient) -> Self {
        Self {
            proxy,
            tool_router: Self::tool_router(),
        }
    }

    /// Forward a tool call to the UI and wrap its JSON result. Every DB tool
    /// goes through here, so there is no code path in this process that
    /// touches Postgres directly.
    async fn forward(&self, call: ToolCall) -> Result<CallToolResult, McpError> {
        let value = self.proxy.call(call).await.map_err(err)?;
        let json = serde_json::to_string_pretty(&value)
            .map_err(|e| McpError::internal_error(e.to_string(), None))?;
        Ok(CallToolResult::success(vec![Content::text(json)]))
    }
}

fn err(e: anyhow::Error) -> McpError {
    McpError::internal_error(format!("{e:#}"), None)
}

#[tool_router]
impl McpServer {
    #[tool(description = "List saved connections in the workbench. Returns name/host/port/database/username/ssl_mode/connected. Passwords are never returned.")]
    async fn list_connections(&self) -> Result<CallToolResult, McpError> {
        self.forward(ToolCall::ListConnections).await
    }

    #[tool(description = "Report whether the workbench is currently connected to the named database. Cannot open a connection: a human must connect the database in the workbench first. Returns connected:true when usable, or an error telling you to ask the human to connect it.")]
    async fn connect(
        &self,
        Parameters(ConnArg { connection }): Parameters<ConnArg>,
    ) -> Result<CallToolResult, McpError> {
        self.forward(ToolCall::Connect { connection }).await
    }

    #[tool(description = "List non-system schemas for the named connection.")]
    async fn list_schemas(
        &self,
        Parameters(ConnArg { connection }): Parameters<ConnArg>,
    ) -> Result<CallToolResult, McpError> {
        self.forward(ToolCall::ListSchemas { connection }).await
    }

    #[tool(description = "List tables/views/matviews in the given schema. Returns objects with `name`, `kind` (table|view|matview|partitioned|foreign), and `row_estimate` (planner estimate from pg_class.reltuples; omitted if never analyzed).")]
    async fn list_tables(
        &self,
        Parameters(SchemaArg { connection, schema }): Parameters<SchemaArg>,
    ) -> Result<CallToolResult, McpError> {
        self.forward(ToolCall::ListTables { connection, schema }).await
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
        self.forward(ToolCall::DescribeTable {
            connection,
            schema,
            table,
        })
        .await
    }

    #[tool(description = "Run a SELECT (or WITH-prefixed SELECT) and return columns + rows. Writes/DDL are rejected at the POC seam. Capped at 1000 rows; the `truncated` field signals overflow. Columns classified as PHI/PCI/PII are always redacted on the MCP path — see redaction_meta.")]
    async fn run_query(
        &self,
        Parameters(QueryArg { connection, sql }): Parameters<QueryArg>,
    ) -> Result<CallToolResult, McpError> {
        // The privacy invariant (reveal=false on the MCP path) is enforced UI-
        // side in the dispatcher — see bridge::dispatch and design/redaction.md.
        self.forward(ToolCall::RunQuery { connection, sql }).await
    }

    #[tool(description = "Open a new query tab in the workbench with the given SQL and switch the human to it. Use this when you want the human to REVIEW a query before running it — the tab is marked 'written by agent' and will NOT auto-run; the human reviews and presses Run themselves. The tab opens under whichever connection the human is currently viewing (no connection arg). Returns immediately; the tool succeeds even if no UI is attached.")]
    async fn propose_query(
        &self,
        Parameters(ProposeQueryArg { sql, title }): Parameters<ProposeQueryArg>,
    ) -> Result<CallToolResult, McpError> {
        self.forward(ToolCall::ProposeQuery { sql, title }).await
    }

    #[tool(description = "Run a SQL statement (any kind — SELECT/INSERT/UPDATE/DELETE/DDL) through the workbench's permission gate. Reads inside the policy run immediately. Writes/DDL pause and ask the human via a permission card; the human can allow, deny, or modify the SQL before running. Returns rows on success (empty rows + empty columns for writes/DDL without RETURNING). Pass `intent` to surface a plain-English description on the card. Distinct from `propose_query`: that opens a tab for review and never runs; this is for the agent's own gated execution.")]
    async fn execute_statement(
        &self,
        Parameters(ExecuteStatementArg {
            connection,
            sql,
            intent,
        }): Parameters<ExecuteStatementArg>,
    ) -> Result<CallToolResult, McpError> {
        self.forward(ToolCall::ExecuteStatement {
            connection,
            sql,
            intent,
        })
        .await
    }

    #[tool(description = "Run a multi-statement migration through the workbench's bulk permission gate. The full plan (numbered, with policy verdicts per statement) is shown to the human; they approve once with a transaction-wrap toggle, then each deviation pauses one-by-one for individual approval. Any denial or runtime error rolls back the whole batch when transactions are enabled (default). Each entry in `statements` MUST be exactly one SQL statement. Pass `intent` to describe the migration's purpose on the bulk card.")]
    async fn execute_migration(
        &self,
        Parameters(ExecuteMigrationArg {
            connection,
            statements,
            intent,
        }): Parameters<ExecuteMigrationArg>,
    ) -> Result<CallToolResult, McpError> {
        self.forward(ToolCall::ExecuteMigration {
            connection,
            statements,
            intent,
        })
        .await
    }
}

#[tool_handler]
impl ServerHandler for McpServer {
    /// Capture the real client identity from the MCP handshake so the
    /// workbench's agent roster shows "Claude Code" / "Cursor" / etc. instead
    /// of a generic label. The handshake always precedes the first tool call
    /// (which is what lazily opens the proxy socket), so the captured name is
    /// in place before the Hello frame is sent. Preserves the default
    /// `set_peer_info` behavior the rest of rmcp relies on.
    async fn initialize(
        &self,
        request: InitializeRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<InitializeResult, McpError> {
        let info = &request.client_info;
        let label = info
            .title
            .clone()
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| info.name.clone());
        if !label.is_empty() {
            self.proxy.set_label(label);
        }
        if context.peer.peer_info().is_none() {
            context.peer.set_peer_info(request);
        }
        Ok(self.get_info())
    }

    fn get_info(&self) -> ServerInfo {
        ServerInfo::new(
            ServerCapabilities::builder()
                .enable_tools()
                .build(),
        )
        .with_server_info(Implementation::from_build_env())
        .with_instructions(
            "Postgres workbench MCP server. Tools: list_connections, connect, list_schemas, list_tables, describe_table, run_query, propose_query, execute_statement, execute_migration. All schema/query tools require a `connection` arg matching a name from list_connections. The workbench (a desktop app the human runs) owns every database connection: a human must open a connection there before any tool can use it — `connect` only reports whether that has happened. `run_query` is SELECT-only and never prompts. `propose_query` opens a tab for human review (does not run). `execute_statement` is the gated runner for a single statement — reads run immediately if policy allows, writes/DDL pause for human approval. `execute_migration` is the bulk variant — show the plan, approve once, runs in a transaction with per-deviation prompts.",
        )
    }
}
