import { useEffect, useMemo, useRef, useState } from "react";
import type { Snippet } from "../lib/api";
import type { Snippets } from "../lib/useSnippets";
import { Modal } from "./Modal";
import { SqlEditor } from "./SqlEditor";
import { showToast } from "./Toast";

type Props = {
  snippets: Snippets;
  /** When non-null, the modal opens in "new" mode with this prefilled body —
   *  surfaced from the editor toolbar's "Save as snippet" action. */
  seedBody?: string | null;
  onClose: () => void;
};

/** Draft state used by the form. `id: null` means "create on save". */
type Draft = {
  id: string | null;
  name: string;
  prefix: string;
  description: string;
  body: string;
};

const EMPTY_DRAFT: Draft = {
  id: null,
  name: "",
  prefix: "",
  description: "",
  body: "",
};

const PREFIX_RE = /^[a-zA-Z0-9_]+$/;

function fromSnippet(s: Snippet): Draft {
  return {
    id: s.id,
    name: s.name,
    prefix: s.prefix,
    description: s.description,
    body: s.body,
  };
}

/**
 * Snippet manager. Two-pane: a filterable list on the left, an edit form on
 * the right. The form uses the same SqlEditor for the body so users get the
 * full highlight experience while authoring (with snippets/schema disabled
 * to avoid recursion or schema-coupling).
 *
 * The "seedBody" prop captures the editor toolbar's "Save as snippet" flow:
 * when present, we open in "new" mode with the seed already filled in and
 * focus the name field.
 */
export function SnippetsModal({ snippets, seedBody, onClose }: Props) {
  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  /** Local form-error message; cleared on edit. Server errors land here too. */
  const [formError, setFormError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  // Seed-body open path. Treated as a one-shot effect: applied on mount only.
  // After that, normal selection logic takes over.
  useEffect(() => {
    if (seedBody && seedBody.trim().length > 0) {
      setDraft({ ...EMPTY_DRAFT, body: seedBody });
      // Defer focus so the modal has painted its inputs.
      queueMicrotask(() => nameInputRef.current?.focus());
    } else if (snippets.list.length > 0) {
      setDraft(fromSnippet(snippets.list[0]));
    }
    // Intentional: this is the open-time selection, not a live mirror.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the form synced when the underlying snippet changes (e.g. after a
  // save, the list reorders and the id we hold is still valid).
  useEffect(() => {
    if (draft.id == null) return;
    const live = snippets.list.find((s) => s.id === draft.id);
    if (live) setDraft(fromSnippet(live));
    // If the snippet was deleted out from under us, fall back to empty.
    else setDraft(EMPTY_DRAFT);
    // Only react to list changes; draft is intentionally excluded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snippets.list]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    if (!f) return snippets.list;
    return snippets.list.filter(
      (s) =>
        s.name.toLowerCase().includes(f) ||
        s.prefix.toLowerCase().includes(f) ||
        s.description.toLowerCase().includes(f),
    );
  }, [snippets.list, filter]);

  const dirty = useMemo(() => {
    if (draft.id == null) {
      return (
        draft.name.length > 0 ||
        draft.prefix.length > 0 ||
        draft.description.length > 0 ||
        draft.body.length > 0
      );
    }
    const live = snippets.list.find((s) => s.id === draft.id);
    if (!live) return false;
    return (
      live.name !== draft.name ||
      live.prefix !== draft.prefix ||
      live.description !== draft.description ||
      live.body !== draft.body
    );
  }, [draft, snippets.list]);

  function selectSnippet(s: Snippet) {
    // Switching with unsaved edits silently discards the draft. The form
    // shows an "unsaved" badge in the footer, so this isn't a surprise.
    setDraft(fromSnippet(s));
    setFormError(null);
    setConfirmDelete(false);
  }

  function newSnippet() {
    setDraft(EMPTY_DRAFT);
    setFormError(null);
    setConfirmDelete(false);
    queueMicrotask(() => nameInputRef.current?.focus());
  }

  function patch(p: Partial<Draft>) {
    setDraft((d) => ({ ...d, ...p }));
    setFormError(null);
  }

  function validate(): string | null {
    if (draft.name.trim().length === 0) return "Name is required.";
    if (draft.prefix.trim().length === 0) return "Prefix is required.";
    if (!PREFIX_RE.test(draft.prefix.trim()))
      return "Prefix may only contain letters, digits, and underscores.";
    if (draft.body.trim().length === 0) return "Body is required.";
    // Local uniqueness check — the server enforces this too, but a friendlier
    // error here saves a round trip.
    const clash = snippets.list.find(
      (s) =>
        s.prefix.toLowerCase() === draft.prefix.trim().toLowerCase() &&
        s.id !== draft.id,
    );
    if (clash) return `Prefix "${clash.prefix}" is already used by "${clash.name}".`;
    return null;
  }

  async function save() {
    const err = validate();
    if (err) {
      setFormError(err);
      return;
    }
    setSaving(true);
    try {
      const saved = await snippets.save({
        id: draft.id,
        name: draft.name.trim(),
        prefix: draft.prefix.trim(),
        description: draft.description.trim(),
        body: draft.body,
      });
      setDraft(fromSnippet(saved));
      showToast(`Saved "${saved.name}"`, "ok");
    } catch (e) {
      setFormError(String(e));
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!draft.id) return;
    try {
      await snippets.remove(draft.id);
      showToast(`Removed "${draft.name}"`, "ok");
      setConfirmDelete(false);
      // Slot to the next snippet (or empty form if none left).
      const remaining = snippets.list.filter((s) => s.id !== draft.id);
      setDraft(remaining[0] ? fromSnippet(remaining[0]) : EMPTY_DRAFT);
    } catch (e) {
      setFormError(String(e));
    }
  }

  return (
    <Modal onClose={onClose} className="snippets-modal">
      <div className="review-head">
        <span className="review-title">Snippets</span>
        <span className="tray-dot">·</span>
        <span className="mono review-meta">
          {snippets.list.length} saved
        </span>
        <div className="spacer" />
        <button className="editor-btn ghost" onClick={onClose} aria-label="Close">
          ✗
        </button>
      </div>

      <div className="snippets-body">
        <aside className="snippets-list">
          <div className="snippets-filter">
            <input
              type="text"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="Filter by name, prefix, or description"
              aria-label="Filter snippets"
            />
          </div>
          <div className="snippets-list-scroll">
            {filtered.length === 0 ? (
              <div className="snippets-empty">
                {snippets.loading
                  ? "Loading…"
                  : snippets.list.length === 0
                  ? "No snippets yet. Click New to create one."
                  : "No matches."}
              </div>
            ) : (
              filtered.map((s) => (
                <button
                  key={s.id}
                  className={`snippet-item${s.id === draft.id ? " active" : ""}`}
                  onClick={() => selectSnippet(s)}
                >
                  <span className="snippet-item-name">{s.name}</span>
                  <span className="snippet-item-prefix mono">{s.prefix}</span>
                </button>
              ))
            )}
          </div>
          <div className="snippets-list-foot">
            <button className="editor-btn" onClick={newSnippet}>
              <span aria-hidden>+</span> New snippet
            </button>
          </div>
        </aside>

        <section className="snippets-form">
          <div className="snippets-form-row two-col">
            <div className="snippets-field">
              <label>Name</label>
              <input
                ref={nameInputRef}
                type="text"
                value={draft.name}
                placeholder="e.g. recent users"
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>
            <div className="snippets-field prefix">
              <label>
                Prefix
                <span className="snippets-hint">type + Tab to expand</span>
              </label>
              <input
                type="text"
                value={draft.prefix}
                placeholder="e.g. ru"
                spellCheck={false}
                onChange={(e) => patch({ prefix: e.target.value })}
              />
            </div>
          </div>

          <div className="snippets-field">
            <label>Description</label>
            <input
              type="text"
              value={draft.description}
              placeholder="Optional — shown in the autocomplete popup"
              onChange={(e) => patch({ description: e.target.value })}
            />
          </div>

          <div className="snippets-field grow">
            <label>
              Body
              <span className="snippets-hint">
                {"use ${name} for tab stops, ${} for the final cursor"}
              </span>
            </label>
            <div className="snippets-body-editor">
              <SqlEditor
                value={draft.body}
                onChange={(v) => patch({ body: v })}
                snippets={[]}
                height="100%"
              />
            </div>
          </div>

          {formError && (
            <div className="modal-error" role="alert">
              {formError}
            </div>
          )}

          <div className="snippets-form-foot">
            {draft.id && !confirmDelete && (
              <button
                className="editor-btn destruct"
                onClick={() => setConfirmDelete(true)}
                title="Delete this snippet"
              >
                Delete
              </button>
            )}
            {confirmDelete && (
              <>
                <span className="snippets-confirm-text">Delete this snippet?</span>
                <button className="editor-btn" onClick={() => setConfirmDelete(false)}>
                  Cancel
                </button>
                <button className="editor-btn destruct" onClick={remove}>
                  Delete
                </button>
              </>
            )}
            <div className="spacer" />
            <span className="snippets-dirty mono">
              {dirty ? "unsaved" : draft.id ? "saved" : "new"}
            </span>
            <button
              className="btn primary"
              onClick={save}
              disabled={saving || !dirty}
            >
              {saving ? "Saving…" : draft.id ? "Save changes" : "Create snippet"}
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
