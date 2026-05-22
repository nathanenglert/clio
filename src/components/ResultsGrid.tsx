import { useEffect, useMemo, useRef, useState } from "react";
import type { ColumnDescription, QueryResult } from "../lib/api";
import {
  type ActiveAdd,
  type PendingBatch,
  getEdit,
  isDeleted,
} from "../lib/editing";

type Props = {
  result: QueryResult | null;
  error: string | null;
  // Editing
  editable: boolean;
  /** Why the result is read-only (only used when editable=false). */
  readOnlyReason?: string;
  /** Full describe_table metadata for the editable base table. */
  columnsMeta: ColumnDescription[] | null;
  batch: PendingBatch;
  // Drafts for active in-progress add rows (pre-staged).
  activeAdds: ActiveAdd[];
  // Callbacks
  onStageEdit: (rowIdx: number, col: string, newValue: string | null) => void;
  onStageDelete: (rowIdx: number) => void;
  onUndoDelete: (rowIdx: number) => void;
  onCancelAdd: (tempId: string) => void;
  onUpdateActiveAdd: (tempId: string, col: string, value: string | null) => void;
  onStartAdd: () => void;
};

type EditingCell =
  | { kind: "row"; rowIdx: number; col: string }
  | { kind: "add"; tempId: string; col: string };

export function ResultsGrid(props: Props) {
  const {
    result,
    error,
    editable,
    readOnlyReason,
    columnsMeta,
    batch,
    activeAdds,
    onStageEdit,
    onStageDelete,
    onUndoDelete,
    onCancelAdd,
    onUpdateActiveAdd,
    onStartAdd,
  } = props;

  const [editing, setEditing] = useState<EditingCell | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Keyboard: ⌘N starts add, Delete deletes selected row.
  const [selectedRow, setSelectedRow] = useState<number | null>(null);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Don't intercept while editing or when focus is in an input.
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
      if (editing) return;
      if (!editable) return;
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === "n") {
        e.preventDefault();
        onStartAdd();
        return;
      }
      if ((e.key === "Backspace" || e.key === "Delete") && selectedRow !== null) {
        e.preventDefault();
        onStageDelete(selectedRow);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editing, editable, selectedRow, onStartAdd, onStageDelete]);

  const colTypeByName = useMemo(() => {
    const m = new Map<string, ColumnDescription>();
    columnsMeta?.forEach((c) => m.set(c.name, c));
    return m;
  }, [columnsMeta]);

  if (error) {
    return (
      <div className="grid-wrap">
        <div className="result-error mono">{error}</div>
      </div>
    );
  }
  if (!result) {
    return <div className="grid-wrap" />;
  }

  return (
    <div className="grid-wrap" ref={wrapRef}>
      {!editable && (
        <ReadOnlyBanner reason={readOnlyReason ?? "ad-hoc SQL — open via schema tree to edit"} />
      )}

      <table className="grid">
        <thead>
          <tr>
            <th className="grid-rownum" aria-label="row number">#</th>
            {result.columns.map((c) => {
              const meta = colTypeByName.get(c.name);
              const notNullMissing =
                editable && meta && !meta.is_nullable && !meta.default;
              return (
                <th key={c.name}>
                  <div className="th-content">
                    <span className="grid-col-name">{c.name}</span>
                    {notNullMissing && <span className="col-notnull-dot" title="NOT NULL" />}
                    <span className="grid-col-type mono">{c.data_type}</span>
                  </div>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, ri) => {
            const deleted = isDeleted(batch, ri);
            const isSel = selectedRow === ri;
            return (
              <tr
                key={ri}
                className={[
                  deleted ? "row-deleted" : "",
                  isSel ? "row-selected" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                onClick={() => setSelectedRow(ri)}
              >
                <td className="grid-rownum">
                  {deleted ? (
                    <button
                      className="row-action-btn destruct"
                      title="Undo delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        onUndoDelete(ri);
                      }}
                    >
                      ▲
                    </button>
                  ) : (
                    <>
                      <span className="row-num">{ri + 1}</span>
                      {editable && (
                        <button
                          className="row-action-btn delete-hover"
                          title="Delete row"
                          onClick={(e) => {
                            e.stopPropagation();
                            onStageDelete(ri);
                          }}
                        >
                          ✗
                        </button>
                      )}
                    </>
                  )}
                </td>
                {row.map((v, ci) => {
                  const col = result.columns[ci];
                  const meta = colTypeByName.get(col.name);
                  const editState = getEdit(batch, ri, col.name);
                  const displayValue: string | null = editState.staged ? editState.value : v;
                  const dirty = editState.staged;
                  const isJson = col.data_type === "jsonb" || col.data_type === "json";
                  const isNull = displayValue === null;
                  const cls = [
                    isNull ? "null" : "",
                    isJson ? "json" : "",
                    dirty ? "dirty" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  const isEditing =
                    editable &&
                    !deleted &&
                    editing?.kind === "row" &&
                    editing.rowIdx === ri &&
                    editing.col === col.name;
                  if (isEditing && meta) {
                    return (
                      <td key={ci} className="cell-editing">
                        <CellEditor
                          meta={meta}
                          initial={displayValue}
                          schema=""
                          table=""
                          onCommit={(newValue) => {
                            onStageEdit(ri, col.name, newValue);
                            setEditing(null);
                          }}
                          onCancel={() => setEditing(null)}
                        />
                      </td>
                    );
                  }
                  return (
                    <td
                      key={ci}
                      className={cls}
                      onDoubleClick={() => {
                        if (!editable || deleted) return;
                        setEditing({ kind: "row", rowIdx: ri, col: col.name });
                      }}
                      title={editable && !deleted ? "Double-click to edit" : undefined}
                    >
                      {isNull ? "null" : displayValue}
                    </td>
                  );
                })}
              </tr>
            );
          })}

          {/* Active (pre-staged) adds — editable inline */}
          {editable && activeAdds.map((add) => (
            <tr key={`add-${add.tempId}`} className="row-add">
              <td className="grid-rownum">
                <button
                  className="row-action-btn write"
                  title="Cancel new row"
                  onClick={() => onCancelAdd(add.tempId)}
                >
                  ✗
                </button>
              </td>
              {result.columns.map((col, ci) => {
                const meta = colTypeByName.get(col.name);
                const isEditing =
                  editing?.kind === "add" &&
                  editing.tempId === add.tempId &&
                  editing.col === col.name;
                const v = add.cells[col.name];
                const present = v !== undefined;
                if (isEditing && meta) {
                  return (
                    <td key={ci} className="cell-editing">
                      <CellEditor
                        meta={meta}
                        initial={present ? v : null}
                        schema=""
                        table=""
                        onCommit={(newValue) => {
                          onUpdateActiveAdd(add.tempId, col.name, newValue);
                          setEditing(null);
                        }}
                        onCancel={() => setEditing(null)}
                      />
                    </td>
                  );
                }
                let display: React.ReactNode;
                if (!present) {
                  display = (
                    <span className="add-placeholder mono">
                      {meta?.default ? meta.default : meta?.is_nullable ? "null" : "—"}
                    </span>
                  );
                } else if (v === null) {
                  display = <span className="null">null</span>;
                } else {
                  display = v;
                }
                return (
                  <td
                    key={ci}
                    className={`add-cell ${present ? "" : "empty"}`}
                    onClick={() => setEditing({ kind: "add", tempId: add.tempId, col: col.name })}
                  >
                    {display}
                  </td>
                );
              })}
            </tr>
          ))}

          {/* Ghost row prompt */}
          {editable && (
            <tr className="row-ghost" onClick={onStartAdd}>
              <td className="grid-rownum">+</td>
              <td colSpan={result.columns.length}>
                <span className="ghost-prompt mono">Click or ⌘N to add a row…</span>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ── Inline cell editor (type-aware) ──────────────────────────────

function CellEditor(props: {
  meta: ColumnDescription;
  initial: string | null;
  schema: string;
  table: string;
  onCommit: (value: string | null) => void;
  onCancel: () => void;
}) {
  const { meta, initial, onCommit, onCancel } = props;
  const dt = meta.data_type;
  const [val, setVal] = useState<string>(initial ?? "");
  const [isNull, setIsNull] = useState<boolean>(initial === null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    if (inputRef.current && "select" in inputRef.current) {
      try {
        inputRef.current.select();
      } catch {}
    }
  }, []);

  function commit() {
    onCommit(isNull ? null : val);
  }

  function handleKey(e: React.KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }

  // Bool: segmented control
  if (dt === "boolean") {
    const current = isNull ? "null" : val === "true" ? "true" : val === "false" ? "false" : "";
    return (
      <div className="cell-editor bool" onKeyDown={handleKey}>
        <div className="bool-seg" role="group">
          <button className={current === "true" ? "on" : ""} onClick={() => { setIsNull(false); setVal("true"); }}>true</button>
          <button className={current === "false" ? "on" : ""} onClick={() => { setIsNull(false); setVal("false"); }}>false</button>
          <button className={current === "null" ? "on" : ""} onClick={() => setIsNull(true)}>null</button>
        </div>
        <div className="cell-editor-actions">
          <button className="ce-commit" onClick={commit}>↵</button>
          <button className="ce-cancel" onClick={onCancel}>esc</button>
        </div>
      </div>
    );
  }

  // Date/timestamp: native date input
  const isDate = dt === "date" || dt === "timestamp" || dt === "timestamp without time zone";
  const isTimestamptz = dt === "timestamp with time zone" || dt === "timestamptz";
  if (isDate || isTimestamptz) {
    const inputType = dt === "date" ? "date" : "datetime-local";
    // Normalize the initial value to the input's format.
    const dateVal = isNull ? "" : normalizeForDateInput(val, inputType);
    return (
      <div className="cell-editor date" onKeyDown={handleKey}>
        <input
          ref={inputRef as React.RefObject<HTMLInputElement>}
          type={inputType}
          value={dateVal}
          className="mono"
          onChange={(e) => { setIsNull(false); setVal(e.target.value); }}
        />
        <button className="set-null" onClick={() => setIsNull(true)} title="Set NULL">∅</button>
        <div className="cell-editor-actions">
          <button className="ce-commit" onClick={commit}>↵</button>
          <button className="ce-cancel" onClick={onCancel}>esc</button>
        </div>
      </div>
    );
  }

  // Long-text expander: use textarea when the value is multi-line or long.
  const long = (initial?.length ?? 0) > 80 || (initial?.includes("\n") ?? false);
  if (long) {
    return (
      <div className="cell-editor long" onKeyDown={handleKey}>
        <textarea
          ref={inputRef as React.RefObject<HTMLTextAreaElement>}
          value={isNull ? "" : val}
          className="mono"
          rows={4}
          onChange={(e) => { setIsNull(false); setVal(e.target.value); }}
        />
        <button className="set-null" onClick={() => setIsNull(true)} title="Set NULL">∅</button>
        <div className="cell-editor-actions">
          <button className="ce-commit" onClick={commit}>⏎</button>
          <button className="ce-cancel" onClick={onCancel}>esc</button>
        </div>
        <div className="cell-editor-hint mono">⇧↵ newline · ↵ commit · esc cancel</div>
      </div>
    );
  }

  // Default: plain mono input.
  return (
    <div className="cell-editor" onKeyDown={handleKey}>
      <input
        ref={inputRef as React.RefObject<HTMLInputElement>}
        type="text"
        value={isNull ? "" : val}
        placeholder={isNull ? "null" : undefined}
        className="mono"
        onChange={(e) => { setIsNull(false); setVal(e.target.value); }}
      />
      <button className="set-null" onClick={() => setIsNull(true)} title="Set NULL">∅</button>
      <div className="cell-editor-actions">
        <button className="ce-commit" onClick={commit}>↵</button>
        <button className="ce-cancel" onClick={onCancel}>esc</button>
      </div>
    </div>
  );
}

function normalizeForDateInput(s: string, inputType: "date" | "datetime-local"): string {
  if (!s) return "";
  // datetime-local wants "YYYY-MM-DDTHH:MM" (no seconds, no Z).
  if (inputType === "datetime-local") {
    // Try to parse and reformat. Tolerant of "YYYY-MM-DD HH:MM:SS" / ISO.
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    if (m) return `${m[1]}T${m[2]}`;
    return s;
  }
  // date: keep just the date portion if a longer string was passed.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}

// ── Read-only banner ──────────────────────────────────────────────

function ReadOnlyBanner({ reason }: { reason: string }) {
  return (
    <div className="readonly-banner">
      <span className="rb-icon" aria-hidden>🔒</span>
      <span>
        <span className="rb-strong">Read-only result</span>
        <span className="rb-muted"> · {reason}</span>
      </span>
    </div>
  );
}
