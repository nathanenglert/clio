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

export type ColumnMeta = {
  name: string;
  data_type: string;
};

export type QueryResult = {
  columns: ColumnMeta[];
  rows: (string | null)[][];
  row_count: number;
  truncated: boolean;
  elapsed_ms: number;
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
  status: "ok" | "error";
  duration_ms: number;
  /** Full-fidelity payload for tools whose `detail` is truncated. Currently the un-truncated SQL on `run_query`. */
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

export const api = {
  list_connections: () => invoke<Connection[]>("list_connections"),
  add_connection: (input: NewConnectionInput) =>
    invoke<Connection>("add_connection", { input }),
  delete_connection: (name: string) =>
    invoke<void>("delete_connection", { name }),
  connect: (name: string) => invoke<void>("connect", { name }),
  disconnect: (name: string) => invoke<void>("disconnect", { name }),
  list_schemas: (connection: string) =>
    invoke<string[]>("list_schemas", { connection }),
  list_tables: (connection: string, schema: string) =>
    invoke<string[]>("list_tables", { connection, schema }),
  describe_table: (connection: string, schema: string, table: string) =>
    invoke<ColumnDescription[]>("describe_table", {
      connection,
      schema,
      table,
    }),
  run_query: (connection: string, sql: string) =>
    invoke<QueryResult>("run_query", { connection, sql }),
  apply_mutations: (connection: string, batch: MutationBatch) =>
    invoke<MutationOutcome>("apply_mutations", { connection, batch }),
  export_query: (connection: string, sql: string, path: string, format: "csv" | "json") =>
    invoke<ExportResult>("export_query", { connection, sql, path, format }),
  write_file: (path: string, content: string) =>
    invoke<number>("write_file", { path, content }),
  mcp_snippet: () => invoke<McpSnippet>("mcp_snippet"),
};

export function onActivity(
  cb: (event: ActivityEvent) => void
): Promise<UnlistenFn> {
  return listen<ActivityEvent>("activity", (e) => cb(e.payload));
}
