import { useEffect, useMemo, useRef, useState } from "react";
import { Splitter } from "./Splitter";
import { useResizable } from "../lib/useResizable";

export type JsonSidebarTarget = {
  schema: string;
  table: string;
  column: string;
  rowIdx: number;
  rowDisplayNum: number;
  originalValue: string | null;
  /** Staged value from the pending batch. undefined when nothing is staged for this cell. */
  stagedValue: string | null | undefined;
  nullable: boolean;
  /** Column-level redaction blocks editing. */
  locked: boolean;
};

type Props = {
  target: JsonSidebarTarget;
  /** Result-level editability. Combined with `locked` to gate Stage. */
  editable: boolean;
  onClose: () => void;
  onStage: (value: string | null) => void;
  onRevert: () => void;
};

type Validation =
  | { ok: true }
  | { ok: false; message: string; line: number | null; col: number | null };

/** JSON viewer/editor that lives to the right of the results grid.
 *  Implements design/result-editing.md §"Type-aware editors" — jsonb cells
 *  route here instead of opening the inline cell editor. */
export function JsonSidebar(props: Props) {
  const { target, editable, onClose, onStage, onRevert } = props;

  const resize = useResizable({
    storageKey: "db.layout.json.width",
    defaultSize: 480,
    min: 320,
    max: 720,
    axis: "x",
    direction: -1, // handle is on the leading (left) edge; drag-left grows
  });

  const cellHasStaged = target.stagedValue !== undefined;
  const baseline = cellHasStaged ? target.stagedValue ?? null : target.originalValue;

  const [text, setText] = useState<string>(() => initialText(baseline));
  const [isNull, setIsNull] = useState<boolean>(baseline === null);
  const [caretPos, setCaretPos] = useState<number>(0);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // Re-seed when the targeted cell changes.
  useEffect(() => {
    setText(initialText(baseline));
    setIsNull(baseline === null);
    setCaretPos(0);
    // Defer to next tick so the textarea re-mounts with the new value before focusing.
    queueMicrotask(() => {
      textareaRef.current?.focus();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.rowIdx, target.column, target.schema, target.table]);

  const canEdit = editable && !target.locked;

  const validation: Validation = useMemo(() => {
    if (isNull) return { ok: true };
    if (text.trim() === "") return { ok: true };
    try {
      JSON.parse(text);
      return { ok: true };
    } catch (e) {
      const { line, col, msg } = parseErrorPosition(text, e);
      return { ok: false, message: msg, line, col };
    }
  }, [text, isNull]);

  const dirty = useMemo(() => {
    if (isNull) return baseline !== null;
    if (baseline === null) return true;
    return normalizeIfValid(text) !== normalizeIfValid(baseline);
  }, [text, isNull, baseline]);

  const path = useMemo(() => pathAtCursor(text, caretPos), [text, caretPos]);

  function stage() {
    if (!canEdit) return;
    if (!validation.ok) return;
    if (isNull) {
      onStage(null);
      return;
    }
    // Normalize on stage so the cell stores a canonical form.
    const normalized = normalizeIfValid(text);
    onStage(normalized ?? text);
  }

  function reformat() {
    if (isNull) return;
    if (!validation.ok) return;
    try {
      const parsed = JSON.parse(text);
      setText(JSON.stringify(parsed, null, 2));
    } catch {
      /* validation guard already prevented this */
    }
  }

  function setNull() {
    if (!canEdit || !target.nullable) return;
    setIsNull(true);
    setText("");
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // ⏎ alone (no Shift) stages. Shift+⏎ inserts a newline (default textarea behavior).
    if (e.key === "Enter" && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      stage();
      return;
    }
    // ⌥⏎ reformats.
    if (e.key === "Enter" && e.altKey) {
      e.preventDefault();
      reformat();
      return;
    }
    // ⌘⌫ sets NULL (mirrors the cell-editor "set null" affordance).
    if ((e.metaKey || e.ctrlKey) && e.key === "Backspace") {
      if (target.nullable) {
        e.preventDefault();
        setNull();
      }
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      // Close — but if there are in-flight unstaged edits, just close without
      // staging. The grid still reflects the previous staged state (if any).
      onClose();
      return;
    }
  }

  function syncCaret() {
    const el = textareaRef.current;
    if (!el) return;
    setCaretPos(el.selectionStart ?? 0);
  }

  return (
    <div
      className={`json-sidebar${canEdit ? " editable" : ""}`}
      style={{ width: resize.size, flex: "0 0 auto" }}
    >
      <Splitter
        orientation="vertical"
        dragging={resize.dragging}
        title="Drag to resize · double-click to reset"
        className="json-sidebar-handle"
        {...resize.handleProps}
      />

      <div className="json-sidebar-header">
        <span className="json-sidebar-glyph" aria-hidden>{"{}"}</span>
        <span className="mono json-sidebar-col">{target.column}</span>
        <span className="json-sidebar-row">· row {target.rowDisplayNum}</span>
        <div className="spacer" />
        <button
          className="json-sidebar-close"
          onClick={onClose}
          title="Close (⌘⇧J)"
          aria-label="Close JSON sidebar"
        >×</button>
      </div>

      <div className="json-breadcrumb mono" title="Path at caret">
        <span className="json-breadcrumb-root">{target.column}</span>
        {path.map((seg, i) => (
          <span key={i}>
            <span className="json-breadcrumb-sep">›</span>
            <span className="json-breadcrumb-seg">{seg}</span>
          </span>
        ))}
      </div>

      {cellHasStaged && (
        <div className="json-dirty-strip">
          <span className="json-dirty-glyph" aria-hidden>▢</span>
          <span>edited from original</span>
          <div className="spacer" />
          <button
            className="json-revert"
            onClick={() => {
              onRevert();
              // After revert the parent will re-seed via stagedValue → undefined.
            }}
            title="Discard staged change for this cell"
          >Revert</button>
        </div>
      )}

      <div className={`json-editor-body${validation.ok ? "" : " invalid"}`}>
        {isNull ? (
          <div className="json-null-placeholder mono">
            <span>NULL</span>
            {canEdit && (
              <button
                className="json-null-clear"
                onClick={() => {
                  setIsNull(false);
                  setText("");
                  queueMicrotask(() => textareaRef.current?.focus());
                }}
              >Replace with value</button>
            )}
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            className="json-textarea mono"
            value={text}
            spellCheck={false}
            readOnly={!canEdit}
            onChange={(e) => {
              setText(e.target.value);
              syncCaret();
            }}
            onKeyUp={syncCaret}
            onClick={syncCaret}
            onSelect={syncCaret}
            onKeyDown={onKeyDown}
            placeholder={canEdit ? "{ }" : ""}
          />
        )}
      </div>

      <div className="json-sidebar-footer">
        <div className={`json-validation mono${validation.ok ? " ok" : " err"}`}>
          {validation.ok ? (
            isNull ? <>NULL · ready to stage</> : <>✓ valid JSON</>
          ) : (
            <>✗ {validation.message}{validation.line != null && validation.col != null && (
              <span className="json-validation-pos"> at {validation.line}:{validation.col}</span>
            )}</>
          )}
        </div>
        {canEdit && (
          <div className="json-implied mono" title="Will stage this UPDATE statement">
            <span className="sql-write">will UPDATE</span>{" "}
            <span>{target.schema}.{target.table}</span>{" "}
            <span>SET {target.column} = </span>
            <span className="sql-str">{isNull ? "NULL" : "{…}"}</span>
          </div>
        )}
        <div className="json-sidebar-actions">
          {canEdit ? (
            <>
              <button
                className="json-action primary"
                onClick={stage}
                disabled={!validation.ok || !dirty}
                title={!validation.ok ? "Fix JSON errors first" : !dirty ? "No changes to stage" : "Stage this change"}
              >
                <kbd className="kbd">⏎</kbd> Stage
              </button>
              <button
                className="json-action"
                onClick={onClose}
                title="Close without staging"
              >
                <kbd className="kbd">esc</kbd> Cancel
              </button>
              <button
                className="json-action"
                onClick={setNull}
                disabled={!target.nullable || isNull}
                title={target.nullable ? "Set this cell to NULL" : "Column is NOT NULL"}
              >
                <kbd className="kbd">⌘⌫</kbd> Set NULL
              </button>
              <button
                className="json-action"
                onClick={reformat}
                disabled={isNull || !validation.ok}
                title="Pretty-print"
              >
                <kbd className="kbd">⌥⏎</kbd> Reformat
              </button>
            </>
          ) : (
            <span className="json-readonly-hint mono">
              {target.locked
                ? "Redacted column — toggle View > Reveal sensitive data to edit"
                : "Read-only result"}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Helpers ─────────────────────────────────────────────────────────

function initialText(v: string | null): string {
  if (v === null) return "";
  // Pretty-print on open if the value parses; otherwise show it verbatim
  // (Postgres jsonb is always valid JSON, but defensively handle anything).
  try {
    return JSON.stringify(JSON.parse(v), null, 2);
  } catch {
    return v;
  }
}

function normalizeIfValid(v: string | null): string | null {
  if (v === null) return null;
  try {
    return JSON.stringify(JSON.parse(v));
  } catch {
    return v;
  }
}

/** Walk the text up to `pos` and return the JSON key/index path at that caret.
 *  Best-effort: assumes valid-enough JSON. Falls back to a partial path if the
 *  text is mid-edit and not strictly parseable. */
function pathAtCursor(text: string, pos: number): string[] {
  type Ctx = { kind: "obj" | "arr"; currentKey?: string; arrayIdx?: number };
  const stack: Ctx[] = [];
  const end = Math.min(pos, text.length);

  let i = 0;
  let inString = false;
  let escape = false;
  let strBuf = "";
  let expectingKey = false; // start of object, or after a comma inside an object

  while (i < end) {
    const c = text[i];
    if (escape) {
      strBuf += c;
      escape = false;
      i++;
      continue;
    }
    if (inString) {
      if (c === "\\") { escape = true; i++; continue; }
      if (c === '"') {
        inString = false;
        if (expectingKey) {
          const top = stack[stack.length - 1];
          if (top && top.kind === "obj") top.currentKey = strBuf;
          expectingKey = false;
        }
        strBuf = "";
        i++;
        continue;
      }
      strBuf += c;
      i++;
      continue;
    }
    if (c === '"') { inString = true; strBuf = ""; i++; continue; }
    if (c === "{") { stack.push({ kind: "obj" }); expectingKey = true; i++; continue; }
    if (c === "[") { stack.push({ kind: "arr", arrayIdx: 0 }); i++; continue; }
    if (c === "}" || c === "]") { stack.pop(); i++; continue; }
    if (c === ",") {
      const top = stack[stack.length - 1];
      if (top?.kind === "obj") { top.currentKey = undefined; expectingKey = true; }
      else if (top?.kind === "arr") { top.arrayIdx = (top.arrayIdx ?? 0) + 1; }
      i++;
      continue;
    }
    i++;
  }

  const out: string[] = [];
  for (const ctx of stack) {
    if (ctx.kind === "obj" && ctx.currentKey !== undefined) out.push(ctx.currentKey);
    else if (ctx.kind === "arr") out.push(`[${ctx.arrayIdx ?? 0}]`);
  }
  return out;
}

/** Extract a line:col position from a SyntaxError thrown by JSON.parse.
 *  V8 includes the character offset in the message; JavaScriptCore (WebKit,
 *  what Tauri uses on macOS) does not. Return null line/col when we can't
 *  resolve a position. */
function parseErrorPosition(
  text: string,
  err: unknown,
): { line: number | null; col: number | null; msg: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const cleaned = raw
    .replace(/ in JSON at position \d+/, "")
    .replace(/ at position \d+/, "")
    .replace(/^JSON Parse error: /, "");
  const posMatch = raw.match(/at position (\d+)/) ?? raw.match(/position (\d+)/);
  if (!posMatch) return { line: null, col: null, msg: cleaned };
  const pos = Math.min(parseInt(posMatch[1], 10), text.length);
  let line = 1;
  let col = 1;
  for (let i = 0; i < pos; i++) {
    if (text[i] === "\n") { line++; col = 1; }
    else col++;
  }
  return { line, col, msg: cleaned };
}
