import { useEffect, useRef, useState } from "react";
import type { SavedQuery } from "../lib/api";
import { Modal } from "./Modal";

type Props = {
  /** When set, the sheet is editing this entry (Save). When null, creating new (Save as…). */
  existing: SavedQuery | null;
  /** Initial name suggestion when creating — typically the tab title. */
  initialName: string;
  /** SQL body to be saved. The body is not user-editable in this sheet. */
  body: string;
  /** Currently active connection. Drives the scope toggle default and option label. */
  connectionName: string | null;
  /** Already-saved queries — used for friendly "name already used" guard. */
  existingNames: { id: string; name: string }[];
  onClose: () => void;
  onSubmit: (input: {
    id: string | null;
    name: string;
    description: string;
    connection_name: string | null;
  }) => Promise<void>;
};

/**
 * Small save dialog for the Library. Three fields: name (required),
 * description (optional), and scope toggle. The body comes from the editor
 * and isn't re-displayed — this sheet is the "name this thing and stash it"
 * step, not a SQL editor.
 *
 * When `existing` is non-null we're in update mode: the name pre-fills from
 * the saved entry and the scope toggle is preselected to match.
 */
export function SaveQuerySheet({
  existing,
  initialName,
  body,
  connectionName,
  existingNames,
  onClose,
  onSubmit,
}: Props) {
  const isEdit = !!existing;
  const [name, setName] = useState(existing?.name ?? initialName);
  const [description, setDescription] = useState(existing?.description ?? "");
  // Scope state: null = global, string = connection-scoped. Default to the
  // current connection when creating new (we assume "scoped" is the more
  // common save). Existing entries preserve their stored scope.
  const [scope, setScope] = useState<string | null>(
    existing ? existing.connection_name : connectionName,
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    nameRef.current?.select();
  }, []);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError("Name is required.");
      return;
    }
    if (body.trim().length === 0) {
      setError("Query body is empty.");
      return;
    }
    const clash = existingNames.find(
      (q) => q.id !== (existing?.id ?? "") && q.name.toLowerCase() === trimmed.toLowerCase(),
    );
    if (clash) {
      setError(`"${clash.name}" already exists in this scope.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        id: existing?.id ?? null,
        name: trimmed,
        description: description.trim(),
        connection_name: scope,
      });
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <Modal onClose={onClose}>
      <h2>{isEdit ? "Save changes" : "Save query"}</h2>
      <div className="modal-row">
        <label>Name</label>
        <input
          ref={nameRef}
          value={name}
          autoFocus
          onKeyDown={onKeyDown}
          onChange={(e) => {
            setName(e.target.value);
            setError(null);
          }}
          placeholder="e.g. monthly active users"
        />
      </div>
      <div className="modal-row">
        <label>Description</label>
        <input
          value={description}
          onKeyDown={onKeyDown}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional — shown in the Library list"
        />
      </div>
      <div className="modal-row">
        <label>Scope</label>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
            }}
          >
            <input
              type="radio"
              name="save-query-scope"
              checked={scope === null}
              onChange={() => setScope(null)}
            />
            Global
          </label>
          <label
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              opacity: connectionName ? 1 : 0.5,
            }}
          >
            <input
              type="radio"
              name="save-query-scope"
              checked={scope !== null}
              disabled={!connectionName}
              onChange={() => setScope(connectionName)}
            />
            {connectionName ? `Only on "${connectionName}"` : "Only on this connection"}
          </label>
        </div>
      </div>
      {error && <div className="modal-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn primary" onClick={submit} disabled={busy}>
          {busy ? "Saving…" : isEdit ? "Save" : "Create"}
        </button>
      </div>
    </Modal>
  );
}
