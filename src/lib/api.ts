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
  mcp_snippet: () => invoke<McpSnippet>("mcp_snippet"),
};

export function onActivity(
  cb: (event: ActivityEvent) => void
): Promise<UnlistenFn> {
  return listen<ActivityEvent>("activity", (e) => cb(e.payload));
}
