import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type Connection = {
  id: string;
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  ssl_mode: string;
  connected: boolean;
};

export type Column = {
  name: string;
  data_type: string;
  is_nullable: boolean;
};

export type ColumnDescription = Column & {
  default: string | null;
  is_primary_key: boolean;
  /** Postgres enum labels in declared order; absent for non-enum columns. */
  enum_values?: string[];
};

export type IndexInfo = {
  name: string;
  /** Reconstructed CREATE INDEX from pg_get_indexdef. */
  definition: string;
  is_unique: boolean;
  is_primary: boolean;
  /** Column names in index order. "(expression)" for expression indexes. */
  columns: string[];
};

export type ConstraintKind =
  | "primary_key"
  | "foreign_key"
  | "unique"
  | "check"
  | "exclusion";

export type ForeignKeyTarget = {
  schema: string;
  table: string;
  columns: string[];
};

export type ConstraintInfo = {
  name: string;
  kind: ConstraintKind;
  /** pg_get_constraintdef text — uniform across kinds. */
  definition: string;
  columns: string[];
  /** Present only when kind === "foreign_key". */
  references?: ForeignKeyTarget;
};

export type TriggerInfo = {
  name: string;
  /** "BEFORE" | "AFTER" | "INSTEAD OF". */
  timing: string;
  /** Comma-joined: "INSERT", "UPDATE", "DELETE", "TRUNCATE". */
  events: string;
  /** "ROW" | "STATEMENT". */
  level: string;
  /** pg_get_triggerdef text. */
  definition: string;
};

export type ViewDefinition = {
  sql: string;
  is_materialized: boolean;
};

/** Full structural payload returned by describe_table — feeds the Structure
 *  pane and editing.ensureMeta's column cache. */
export type TableDescription = {
  kind: TableKind;
  columns: ColumnDescription[];
  indexes: IndexInfo[];
  constraints: ConstraintInfo[];
  triggers: TriggerInfo[];
  view_definition?: ViewDefinition;
};

export type TableKind = "table" | "view" | "matview" | "partitioned" | "foreign";

export type TableSummary = {
  name: string;
  kind: TableKind;
  /** Planner estimate from pg_class.reltuples; absent if never analyzed. */
  row_estimate?: number;
};

export type ColumnSearchHit = {
  schema: string;
  table: string;
  column: string;
};

export type Category = "phi" | "pci" | "pii";

export type ColumnMeta = {
  name: string;
  data_type: string;
  /** Whether the values in this column were replaced by the redactor. */
  redacted?: boolean;
  /** Classification category that fired; only present when redacted. */
  category?: Category;
};

export type RedactionMeta = {
  redacted_columns: string[];
  note: string;
};

export type QueryResult = {
  columns: ColumnMeta[];
  rows: (string | null)[][];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
  /** Present when one or more columns were redacted. */
  redaction_meta?: RedactionMeta;
};

export type ExportResult = {
  row_count: number;
  elapsed_ms: number;
  bytes_written: number;
};

export type ActivityEvent = {
  id: string;
  ts_ms: number;
  source: "ui" | "mcp";
  tool: string;
  detail: string;
  status: "ok" | "error" | "pending";
  duration_ms: number;
  /** Full-fidelity payload for tools whose `detail` is truncated. Carries the
   *  un-truncated SQL on `run_query`, and a JSON-serialized PermissionRequest
   *  on `permission_required`. */
  payload?: string;
};

// ── Mutation batch (staged editing) ──────────────────────────────
// Mirrors src-tauri/src/types.rs. Submitted to the Tauri-only apply_mutations
// command. NOT exposed via MCP — humans only. See design/result-editing.md.

export type MutationCol = [string, string | null];

export type MutationOp =
  | {
      kind: "update";
      schema: string;
      table: string;
      pk: MutationCol[];
      set: MutationCol[];
    }
  | {
      kind: "insert";
      schema: string;
      table: string;
      values: MutationCol[];
    }
  | {
      kind: "delete";
      schema: string;
      table: string;
      pk: MutationCol[];
    };

export type MutationBatch = {
  ops: MutationOp[];
};

export type MutationOutcome = {
  committed: boolean;
  statements_run: number;
  elapsed_ms: number;
  error: string | null;
  error_at: number | null;
};

// ── Snippets (SQL editor templates) ──────────────────────────────
// Global scope; surfaced in editor autocomplete and the manage modal.

export type Snippet = {
  id: string;
  name: string;
  prefix: string;
  body: string;
  description: string;
  created_at: number;
  updated_at: number;
};

export type SnippetInput = {
  /** Omit (or null) to insert; pass the existing id to update in place. */
  id?: string | null;
  name: string;
  prefix: string;
  body: string;
  description?: string;
};

// ── Saved queries (Library) ──────────────────────────────────────
// Named persistent SQL. Distinct from Snippet (autocomplete template).
// `connection_name` null = global; otherwise scoped to that connection.

export type SavedQuery = {
  id: string;
  name: string;
  body: string;
  description: string;
  connection_name: string | null;
  created_at: number;
  updated_at: number;
};

export type SavedQueryInput = {
  /** Omit / null to insert; pass the existing id to update in place. */
  id?: string | null;
  name: string;
  body: string;
  description?: string;
  /** null = global; otherwise scope to that connection. */
  connection_name?: string | null;
};

export type McpTarget = {
  key: string;
  label: string;
  language: "shell" | "json";
  instructions: string;
  snippet: string;
};

export type McpSnippet = {
  binary_path: string;
  targets: McpTarget[];
};

export type NewConnectionInput = {
  name: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  ssl_mode: string;
};

// ── Sensitivity classifications (per-connection) ─────────────────
// Mirrors src-tauri/src/types.rs. See design/redaction.md.

export type ClassificationStatus = "pending" | "confirmed";

export type Classification = {
  schema: string;
  table: string;
  column: string;
  category: Category;
  status: ClassificationStatus;
  reason: string;
  created_at: number;
};

export type ClassifyOutcome = {
  new_pending: number;
  already_classified: number;
  total_classified: number;
};

export type ClassificationAction =
  | { kind: "confirm" }
  | { kind: "remove" }
  | { kind: "set_category"; category: Category }
  | { kind: "add_manual"; category: Category };

// ── Permission gates ─────────────────────────────────────────────
// Mirrors src-tauri/src/core/permission.rs. Pushed to the frontend as the
// `payload` JSON on a `permission_required` activity event, then resolved
// via the `resolve_permission` Tauri command.

export type PermissionTarget = {
  schema?: string;
  name: string;
};

export type PermissionRequest = {
  id: string;
  source: "ui" | "mcp";
  sql: string;
  intent?: string;
  /** `read | write | ddl | destruct` */
  op_kind: string;
  /** Fine-grained: `select | update | drop_table | …` */
  stmt_kind: string;
  targets: PermissionTarget[];
  rule_label: string;
  reason: string;
  row_estimate?: number;
};

export type PermissionVerdict =
  | { kind: "allow" }
  | { kind: "deny" }
  | { kind: "modified"; sql: string };

// ── Migrations (bulk multi-statement) ────────────────────────────
// Mirrors src-tauri/src/core/permission.rs.

export type MigrationStatement = {
  index: number;
  sql: string;
  stmt_kind: string;
  op_kind: string;
  targets: PermissionTarget[];
  /** `"allow" | "prompt" | "block"` */
  verdict: string;
  rule_label: string;
  reason: string;
};

export type MigrationRequest = {
  id: string;
  source: "ui" | "mcp";
  intent?: string;
  statements: MigrationStatement[];
};

export type MigrationVerdict =
  | { kind: "approve_and_prompt"; wrap_in_transaction: boolean }
  | { kind: "reject" };

export const api = {
  list_connections: () => invoke<Connection[]>("list_connections"),
  add_connection: (input: NewConnectionInput) =>
    invoke<Connection>("add_connection", { input }),
  delete_connection: (name: string) =>
    invoke<void>("delete_connection", { name }),
  connect: (name: string) =>
    invoke<ClassifyOutcome | null>("connect", { name }),
  disconnect: (name: string) => invoke<void>("disconnect", { name }),
  list_schemas: (connection: string) =>
    invoke<string[]>("list_schemas", { connection }),
  list_tables: (connection: string, schema: string) =>
    invoke<TableSummary[]>("list_tables", { connection, schema }),
  search_columns: (connection: string, query: string, limit = 50) =>
    invoke<ColumnSearchHit[]>("search_columns", { connection, query, limit }),
  describe_table: (connection: string, schema: string, table: string) =>
    invoke<TableDescription>("describe_table", {
      connection,
      schema,
      table,
    }),
  run_query: (connection: string, sql: string, reveal: boolean = false) =>
    invoke<QueryResult>("run_query", { connection, sql, reveal }),
  apply_mutations: (connection: string, batch: MutationBatch) =>
    invoke<MutationOutcome>("apply_mutations", { connection, batch }),
  export_query: (
    connection: string,
    sql: string,
    path: string,
    format: "csv" | "json",
    reveal: boolean = false,
  ) => invoke<ExportResult>("export_query", { connection, sql, path, format, reveal }),
  write_file: (path: string, content: string) =>
    invoke<number>("write_file", { path, content }),
  mcp_snippet: () => invoke<McpSnippet>("mcp_snippet"),
  list_snippets: () => invoke<Snippet[]>("list_snippets"),
  upsert_snippet: (input: SnippetInput) =>
    invoke<Snippet>("upsert_snippet", { input }),
  delete_snippet: (id: string) => invoke<void>("delete_snippet", { id }),
  list_saved_queries: (connection: string | null = null) =>
    invoke<SavedQuery[]>("list_saved_queries", { connection }),
  upsert_saved_query: (input: SavedQueryInput) =>
    invoke<SavedQuery>("upsert_saved_query", { input }),
  delete_saved_query: (id: string) =>
    invoke<void>("delete_saved_query", { id }),
  classify_schema: (connection: string) =>
    invoke<ClassifyOutcome>("classify_schema", { connection }),
  list_classifications: (connection: string) =>
    invoke<Classification[]>("list_classifications", { connection }),
  update_classification: (
    connection: string,
    schema: string,
    table: string,
    column: string,
    action: ClassificationAction,
  ) =>
    invoke<void>("update_classification", {
      connection,
      schema,
      table,
      column,
      action,
    }),
  resolve_permission: (id: string, verdict: PermissionVerdict) =>
    invoke<void>("resolve_permission", { id, verdict }),
  resolve_migration: (id: string, verdict: MigrationVerdict) =>
    invoke<void>("resolve_migration", { id, verdict }),
};

export function onActivity(
  cb: (event: ActivityEvent) => void
): Promise<UnlistenFn> {
  return listen<ActivityEvent>("activity", (e) => cb(e.payload));
}
