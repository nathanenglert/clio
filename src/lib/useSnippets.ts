// Global SQL snippet store + CodeMirror completion adapter.
//
// One copy of the list lives in App state (this hook). Snapshot is re-fetched
// after any mutation. The editor's autocomplete reads from `completions` —
// reference-stable as long as the snippet list hasn't changed — so the
// LanguageSupport compartment doesn't need a reconfigure on every keystroke.

import { useCallback, useEffect, useMemo, useState } from "react";
import { snippetCompletion, type Completion } from "@codemirror/autocomplete";
import { api, type Snippet, type SnippetInput } from "./api";

export type Snippets = {
  list: Snippet[];
  loading: boolean;
  error: string | null;
  /** Completions in the shape CodeMirror's autocomplete consumes. */
  completions: readonly Completion[];
  refresh: () => Promise<void>;
  save: (input: SnippetInput) => Promise<Snippet>;
  remove: (id: string) => Promise<void>;
};

function toCompletion(s: Snippet): Completion {
  // Label = prefix so the autocomplete filter matches what the user types
  // (`sfw` → select…where). Name + description show in the detail/info panel.
  // Boost ahead of bare keywords so the snippet rises above e.g. raw `select`.
  return snippetCompletion(s.body, {
    label: s.prefix,
    displayLabel: `${s.prefix}  ${s.name}`,
    detail: "snippet",
    info: s.description || undefined,
    type: "keyword",
    boost: 5,
  });
}

export function useSnippets(): Snippets {
  const [list, setList] = useState<Snippet[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.list_snippets();
      setList(next);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (input: SnippetInput) => {
      const saved = await api.upsert_snippet(input);
      setList((prev) => {
        const idx = prev.findIndex((s) => s.id === saved.id);
        if (idx >= 0) {
          const next = prev.slice();
          next[idx] = saved;
          return next.sort((a, b) => a.name.localeCompare(b.name));
        }
        return [...prev, saved].sort((a, b) => a.name.localeCompare(b.name));
      });
      return saved;
    },
    [],
  );

  const remove = useCallback(async (id: string) => {
    await api.delete_snippet(id);
    setList((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const completions = useMemo(() => list.map(toCompletion), [list]);

  return { list, loading, error, completions, refresh, save, remove };
}
