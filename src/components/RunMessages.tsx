import type { QueryResult, ScriptStep } from "../lib/api";
import type { TabRun } from "../lib/useTabs";
import type { Stmt } from "../lib/sqlStatements";

const WRITE_VERBS: Record<string, string> = {
  insert: "inserted",
  update: "updated",
  delete: "deleted",
  merge: "merged",
};

const READS = new Set(["select", "with", "table", "values", "show", "explain", "fetch"]);

function firstWord(sql: string): string {
  return (
    sql
      .replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, " ")
      .trim()
      .split(/\s+/)[0]
      ?.toLowerCase() ?? ""
  );
}

const rows = (n: number) => `${n.toLocaleString()} row${n === 1 ? "" : "s"}`;

/** What a statement did, in a few words. A write reports the rows it touched
 *  ("3 rows deleted"), a read the rows it returned. Postgres reports no count
 *  for DO, DDL or transaction control — "done", not a misleading "0 rows". */
function outcomeLabel(sql: string, rowCount: number, rowsAffected: number | undefined, hasColumns: boolean) {
  const word = firstWord(sql);
  const verb = WRITE_VERBS[word];
  if (verb && rowsAffected != null) return `${rows(rowsAffected)} ${verb}`;
  if (hasColumns || READS.has(word)) return rows(rowCount);
  if (rowsAffected) return `${rows(rowsAffected)} affected`;
  return "done";
}

/** Footer / empty-state label for a grid result. */
export function resultCountLabel(result: QueryResult, sql: string): string {
  return outcomeLabel(sql, result.row_count, result.rows_affected, result.columns.length > 0);
}

function stepLabel(sql: string, step: ScriptStep): string {
  return outcomeLabel(sql, step.row_count, step.rows_affected, step.row_count > 0);
}

export function formatMs(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

type Props = {
  run: TabRun;
  /** Move the editor to a statement. */
  onReveal: (stmt: Stmt) => void;
};

/** Per-statement log of a run: what ran, what it did, what Postgres said. */
export function RunMessages({ run, onReveal }: Props) {
  const { statements, script } = run;
  return (
    <div className="run-messages">
      {script.error && <pre className="run-msg-error mono">{script.error}</pre>}
      {statements.map((stmt, i) => {
        const step = script.steps[i];
        const state = !step ? "skipped" : step.error ? "err" : "ok";
        return (
          <div key={i} className={`run-step run-step--${state}`}>
            <button className="run-step-head mono" onClick={() => onReveal(stmt)} title="Show in editor">
              <span className="run-step-glyph" aria-hidden>
                {state === "ok" ? "✓" : state === "err" ? "✗" : "·"}
              </span>
              <span className="run-step-n">{String(i + 1).padStart(2, "0")}</span>
              <span className="run-step-sql">{stmt.sql.replace(/\s+/g, " ").slice(0, 200)}</span>
              <span className="run-step-outcome">
                {!step ? "skipped" : step.error ? "failed" : stepLabel(stmt.sql, step)}
              </span>
              <span className="run-step-ms">{step ? formatMs(step.elapsed_ms) : ""}</span>
            </button>
            {step?.notices.map((n, k) => (
              <div key={k} className={`run-notice run-notice--${n.severity} mono`}>
                <span className="run-notice-sev">{n.severity.toUpperCase()}</span>
                <span>{n.message}</span>
              </div>
            ))}
            {step?.error && <pre className="run-step-error mono">{step.error}</pre>}
            {step?.rolled_back && (
              <div className="run-step-undo">
                {step.rolled_back === "transaction"
                  ? "↺ The open transaction was rolled back. Nothing from it was committed."
                  : "↺ This run's statements were undone. The transaction is still open."}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
