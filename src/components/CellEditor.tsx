import { useEffect, useRef, useState } from "react";
import type { ColumnDescription } from "../lib/api";

type Props = {
  meta: ColumnDescription;
  initial: string | null;
  schema: string;
  table: string;
  onCommit: (value: string | null) => void;
  onCancel: () => void;
};

export function CellEditor({ meta, initial, onCommit, onCancel }: Props) {
  const dt = meta.data_type;
  const [val, setVal] = useState<string>(initial ?? "");
  const [isNull, setIsNull] = useState<boolean>(initial === null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null>(null);

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

  // Enum: native select populated with the type's labels.
  if (meta.enum_values && meta.enum_values.length > 0) {
    const current = isNull ? "" : val;
    return (
      <div className="cell-editor enum" onKeyDown={handleKey}>
        <select
          ref={inputRef as React.RefObject<HTMLSelectElement>}
          value={current}
          className="mono"
          onChange={(e) => { setIsNull(false); setVal(e.target.value); }}
        >
          {meta.is_nullable && <option value="">(null)</option>}
          {!meta.enum_values.includes(val) && !isNull && val !== "" && (
            <option value={val} disabled>{`${val} (invalid)`}</option>
          )}
          {meta.enum_values.map((v) => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
        {meta.is_nullable && (
          <button className="set-null" onClick={() => setIsNull(true)} title="Set NULL">∅</button>
        )}
        <div className="cell-editor-actions">
          <button
            className="ce-commit"
            onClick={() => onCommit(isNull || current === "" ? null : current)}
          >↵</button>
          <button className="ce-cancel" onClick={onCancel}>esc</button>
        </div>
      </div>
    );
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
    const m = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2})/);
    if (m) return `${m[1]}T${m[2]}`;
    return s;
  }
  // date: keep just the date portion if a longer string was passed.
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : s;
}
