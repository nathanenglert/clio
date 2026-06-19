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

/// Lightweight per-table summary returned by `list_tables`.
///
/// `kind` distinguishes ordinary tables from views/matviews/etc. so the rail
/// can show a different glyph (per design/screenshots/08).
/// `row_estimate` comes from `pg_class.reltuples` — fast, slightly stale, and
/// `None` for relations the planner has never analyzed (e.g. fresh views).
#[derive(Debug, Clone, Serialize)]
pub struct TableSummary {
    pub name: String,
    pub kind: TableKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub row_estimate: Option<i64>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum TableKind {
    Table,
    View,
    MatView,
    Partitioned,
    Foreign,
}

impl TableKind {
    pub fn from_relkind(c: char) -> Self {
        match c {
            'v' => TableKind::View,
            'm' => TableKind::MatView,
            'p' => TableKind::Partitioned,
            'f' => TableKind::Foreign,
            _ => TableKind::Table,
        }
    }
}

/// Hit from the column search command — used to power the COLUMNS section of
/// the schema rail's filter UI (design/screenshots/10).
#[derive(Debug, Clone, Serialize)]
pub struct ColumnSearchHit {
    pub schema: String,
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnDescription {
    pub name: String,
    pub data_type: String,
    pub is_nullable: bool,
    pub default: Option<String>,
    pub is_primary_key: bool,
    /// Schema-qualified underlying type name (e.g. "clinical.appointment_status").
    /// Required when data_type is "USER-DEFINED" so the commit path can cast to
    /// the real enum/domain/composite type instead of the literal string.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub udt_schema: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub udt_name: Option<String>,
    /// For columns typed as a Postgres enum: the enum's labels in
    /// declared order. None for non-enum columns.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enum_values: Option<Vec<String>>,
}

/// Full structural picture of one relation, surfaced by `describe_table` to
/// both the UI (Structure pane) and MCP agents. Sections that don't apply to
/// a given relkind come back empty/None — e.g. a table has no
/// `view_definition`, a view has no `triggers` (typically).
#[derive(Debug, Clone, Serialize)]
pub struct TableDescription {
    pub kind: TableKind,
    pub columns: Vec<ColumnDescription>,
    pub indexes: Vec<IndexInfo>,
    pub constraints: Vec<ConstraintInfo>,
    pub triggers: Vec<TriggerInfo>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub view_definition: Option<ViewDefinition>,
}

#[derive(Debug, Clone, Serialize)]
pub struct IndexInfo {
    pub name: String,
    /// Reconstructed CREATE INDEX statement from pg_get_indexdef. Captures
    /// expression indexes, partial WHERE clauses, ops classes — things you
    /// can't reconstruct from pg_index alone.
    pub definition: String,
    pub is_unique: bool,
    pub is_primary: bool,
    /// Column names in index order. For expression indexes, the expression's
    /// text appears in place of a column name.
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ConstraintKind {
    PrimaryKey,
    ForeignKey,
    Unique,
    Check,
    Exclusion,
}

impl ConstraintKind {
    /// Maps the single-char contype in pg_constraint.
    pub fn from_contype(c: char) -> Option<Self> {
        match c {
            'p' => Some(ConstraintKind::PrimaryKey),
            'f' => Some(ConstraintKind::ForeignKey),
            'u' => Some(ConstraintKind::Unique),
            'c' => Some(ConstraintKind::Check),
            'x' => Some(ConstraintKind::Exclusion),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ConstraintInfo {
    pub name: String,
    pub kind: ConstraintKind,
    /// Reconstructed definition from pg_get_constraintdef — uniform across
    /// PK/FK/UNIQUE/CHECK, includes the `REFERENCES ...` clause for FKs.
    pub definition: String,
    /// Columns this constraint covers, in declared order.
    pub columns: Vec<String>,
    /// FK only — target schema, table, columns.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub references: Option<ForeignKeyTarget>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ForeignKeyTarget {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct TriggerInfo {
    pub name: String,
    /// "BEFORE" | "AFTER" | "INSTEAD OF".
    pub timing: String,
    /// Comma-joined events: "INSERT", "UPDATE", "DELETE", "TRUNCATE".
    pub events: String,
    /// "ROW" | "STATEMENT".
    pub level: String,
    /// Reconstructed CREATE TRIGGER from pg_get_triggerdef — single source of
    /// truth for the action / WHEN clause / referenced function.
    pub definition: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ViewDefinition {
    /// pg_get_viewdef output — the SELECT body.
    pub sql: String,
    pub is_materialized: bool,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    /// True when the redactor replaced this column's values with fake data.
    /// Always false when the column was not classified or when `reveal` was on
    /// (UI-only). Always reflects the real treatment of the data shipped in `rows`.
    #[serde(default, skip_serializing_if = "is_false")]
    pub redacted: bool,
    /// Category of the classification that fired (PHI/PCI/PII), if any.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub category: Option<Category>,
}

fn is_false(b: &bool) -> bool {
    !*b
}

#[derive(Debug, Clone, Serialize)]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Option<String>>>,
    pub row_count: usize,
    pub truncated: bool,
    pub elapsed_ms: u64,
    /// Present only when one or more result columns were redacted. Lets the MCP
    /// serializer attach a single human-readable footer line so the agent knows
    /// the data is masked.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub redaction_meta: Option<RedactionMeta>,
}

#[derive(Debug, Clone, Serialize)]
pub struct RedactionMeta {
    pub redacted_columns: Vec<String>,
    pub note: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportResult {
    pub row_count: usize,
    pub elapsed_ms: u64,
    pub bytes_written: u64,
}

// ── Mutation batch ────────────────────────────────────────────────
//
// Submitted from the Tauri UI by the staged-tray editing flow (see
// design/result-editing.md). The MCP server stays read-only — agents
// cannot reach apply_mutations.

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MutationOp {
    Update {
        schema: String,
        table: String,
        /// Primary key columns → original values, used in WHERE.
        pk: Vec<(String, Option<String>)>,
        /// Columns to set → new values (None ⇒ NULL).
        set: Vec<(String, Option<String>)>,
    },
    Insert {
        schema: String,
        table: String,
        /// Columns provided by the user → values (None ⇒ explicit NULL).
        /// Columns omitted from this map fall through to DEFAULT.
        values: Vec<(String, Option<String>)>,
    },
    Delete {
        schema: String,
        table: String,
        pk: Vec<(String, Option<String>)>,
    },
}

#[derive(Debug, Clone, Deserialize)]
pub struct MutationBatch {
    pub ops: Vec<MutationOp>,
}

#[derive(Debug, Clone, Serialize)]
pub struct MutationOutcome {
    pub committed: bool,
    pub statements_run: usize,
    pub elapsed_ms: u64,
    pub error: Option<String>,
    /// Index into batch.ops where the failure occurred. None when committed.
    pub error_at: Option<usize>,
}

/// Emitted from core fns whenever a tool runs (UI- or MCP-initiated).
#[derive(Debug, Clone, Serialize, Deserialize, JsonSchema)]
pub struct ActivityEvent {
    pub id: String,
    pub ts_ms: u64,
    pub source: String, // "ui" | "mcp"
    /// Which agent produced this event, when `source == "mcp"`. `None` for
    /// UI-originated events. Lets the activity surfaces attribute and group by
    /// agent once more than one is connected.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
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
            agent_id: None,
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

    pub fn with_agent(mut self, agent_id: Option<String>) -> Self {
        self.agent_id = agent_id;
        self
    }
}

// ── SQL snippets ─────────────────────────────────────────────────
//
// User-managed templates surfaced in the editor's autocomplete. `prefix` is
// the trigger label users type to summon the snippet (e.g. `sfw` → select
// * from … where). `body` may contain ${name} tab stops in CodeMirror's
// snippet syntax. Storage lives in the metadata SQLite; see connections.rs.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Snippet {
    pub id: String,
    pub name: String,
    pub prefix: String,
    pub body: String,
    pub description: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SnippetInput {
    /// Empty / absent on insert; the existing id when updating.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub prefix: String,
    pub body: String,
    #[serde(default)]
    pub description: String,
}

// ── Saved queries (named, persistent SQL) ─────────────────────────
//
// Distinct from snippets: snippets are short autocomplete templates keyed by
// `prefix`; saved queries are full named SQL bodies you find again by name in
// the Library sidebar. `connection_name` is the scope — None means global
// (visible on every connection); Some(name) restricts visibility to that one
// connection.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SavedQuery {
    pub id: String,
    pub name: String,
    pub body: String,
    pub description: String,
    pub connection_name: Option<String>,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SavedQueryInput {
    /// Empty / absent on insert; the existing id when updating.
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub body: String,
    #[serde(default)]
    pub description: String,
    /// None = global; Some(name) = visible only on that connection.
    #[serde(default)]
    pub connection_name: Option<String>,
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

// ── Sensitivity classifications (PHI / PCI / PII) ─────────────────
//
// See design/redaction.md. Storage lives in the metadata SQLite next to the
// connection record; the redaction secret lives in the keychain. The MCP
// server cannot disable redaction — see core::run_query.

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Category {
    Phi,
    Pci,
    Pii,
}

impl Category {
    pub fn as_db(self) -> &'static str {
        match self {
            Category::Phi => "phi",
            Category::Pci => "pci",
            Category::Pii => "pii",
        }
    }
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "phi" => Some(Category::Phi),
            "pci" => Some(Category::Pci),
            "pii" => Some(Category::Pii),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ClassificationStatus {
    /// Suggested by the heuristic classifier, awaiting user review. Still
    /// applied to redaction — safe default.
    Pending,
    /// User-reviewed and accepted.
    Confirmed,
}

impl ClassificationStatus {
    pub fn as_db(self) -> &'static str {
        match self {
            ClassificationStatus::Pending => "pending",
            ClassificationStatus::Confirmed => "confirmed",
        }
    }
    pub fn from_db(s: &str) -> Option<Self> {
        match s {
            "pending" => Some(ClassificationStatus::Pending),
            "confirmed" => Some(ClassificationStatus::Confirmed),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Classification {
    pub schema: String,
    pub table: String,
    pub column: String,
    pub category: Category,
    pub status: ClassificationStatus,
    /// Human-readable reason: "matched 'email'" or "manual".
    pub reason: String,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClassifyOutcome {
    pub new_pending: u32,
    pub already_classified: u32,
    pub total_classified: u32,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ClassificationAction {
    /// Pending → Confirmed.
    Confirm,
    /// Remove the classification entirely.
    Remove,
    /// Change category; leaves status as-is.
    SetCategory { category: Category },
    /// Insert a new Confirmed classification (manual add path).
    AddManual { category: Category },
}
