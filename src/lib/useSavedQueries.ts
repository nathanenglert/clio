// Saved-query store backing the Library sidebar surface.
//
// The list is scoped: when a connection is active we show its scoped entries
// plus globals; with no active connection only globals are visible. We refetch
// on connection change rather than holding all rows in memory and filtering
// client-side — saved-query counts are expected to stay small, and the SQL
// query already does the filter cheaply.

import { useCallback, useEffect, useState } from "react";
import { api, type SavedQuery, type SavedQueryInput } from "./api";

export type SavedQueries = {
  list: SavedQuery[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  save: (input: SavedQueryInput) => Promise<SavedQuery>;
  remove: (id: string) => Promise<void>;
};

export function useSavedQueries(connectionName: string | null): SavedQueries {
  const [list, setList] = useState<SavedQuery[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await api.list_saved_queries(connectionName);
      setList(next);
      setError(null);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [connectionName]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(async (input: SavedQueryInput) => {
    const saved = await api.upsert_saved_query(input);
    setList((prev) => {
      const idx = prev.findIndex((q) => q.id === saved.id);
      const next = idx >= 0 ? prev.slice() : [...prev, saved];
      if (idx >= 0) next[idx] = saved;
      return next.sort((a, b) => a.name.localeCompare(b.name));
    });
    return saved;
  }, []);

  const remove = useCallback(async (id: string) => {
    await api.delete_saved_query(id);
    setList((prev) => prev.filter((q) => q.id !== id));
  }, []);

  return { list, loading, error, refresh, save, remove };
}
