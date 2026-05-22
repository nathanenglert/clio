use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

/// A saved Postgres connection (sans password).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Connection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: i32,
    pub database: String,
    pub username: String,
    pub ssl_mode: String,
    #[serde(default)]
    pub connected: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NewConnectionInput {
    pub name: String,
    pub host: String,
    pub port: i32,
    pub database: String,
    pub username: String,
    pub password: String,
    pub ssl_mode: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnDescription {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub default: Option<String>,
    pub is_primary_key: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Option<String>>>,
    pub row_count: usize,
    pub truncated: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub row_count: usize,
    pub elapsed_ms: u64,
    pub bytes_written: u64,
}

/// Emitted from core fns whenever a tool runs (UI- or MCP-initiated).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ActivityEvent {
    pub id: String,
    pub ts_ms: u64,
    pub source: String, // "ui" | "mcp"
    pub tool: String,
    pub detail: String,
    pub status: String, // "ok" | "error"
    pub duration_ms: u64,
    /// Full-fidelity payload for tools whose `detail` is necessarily truncated
    /// (e.g. SQL on `run_query`). Capped by the caller; absent for most events.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub payload: Option<String>,
}

impl ActivityEvent {
    pub fn new(source: &str, tool: &str, detail: impl Into<String>, status: &str, duration_ms: u64) -> Self {
        Self {
            id: Uuid::new_v4().to_string(),
            ts_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0),
            source: source.into(),
            tool: tool.into(),
            detail: detail.into(),
            status: status.into(),
            duration_ms,
            payload: None,
        }
    }

    pub fn with_payload(mut self, payload: Option<String>) -> Self {
        self.payload = payload;
        self
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct McpTarget {
    pub key: String,
    pub label: String,
    pub language: String,
    pub instructions: String,
    pub snippet: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct McpSnippet {
    pub binary_path: String,
    pub targets: Vec<McpTarget>,
}
