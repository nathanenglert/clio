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
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub row_count: usize,
    pub truncated: bool,
    pub elapsed_ms: u64,
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
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct McpSnippet {
    pub binary_path: String,
    pub snippet: String,
}
