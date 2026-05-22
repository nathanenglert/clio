// Editing state for staged-tray result editing. One batch per tab; cached
// describe_table metadata per (connection, schema, table). All in-memory —
// pending edits never persist across app restarts.

import { useCallback, useEffect, useRef, useState } from "react";
import { api, type ColumnDescription, type MutationOutcome, type QueryResult } from "./api";
import {
  type ActiveAdd,
  type PendingBatch,
  emptyBatch,
  rowKey,
  stageEdit,
  stageDelete as stageDeleteOp,
  unstageEdit,
  unstageDelete,
  toMutationBatch,
} from "./editing";

export type ActiveAdd_ = ActiveAdd;

export type EditableTab = {
  id: string;
  schema: string;
  table: string;
  result: QueryResult | null;
};

type ColMetaKey = string; // `${conn}.${schema}.${table}`

export function useEditing(connectionName: string | null) {
  const [batches, setBatches] = useState<Record<string, PendingBatch>>({});
  const [activeAdds, setActiveAddsMap] = useState<Record<string, ActiveAdd_[]>>({});
  const [columnsMeta, setColumnsMeta] = useState<Record<ColMetaKey, ColumnDescription[]>>({});
  const [busy, setBusy] = useState(false);
  const tempIdCounter = useRef(0);

  // Fetch describe_table once per (conn, schema, table).
  const ensureMeta = useCallback(
    async (schema: string, table: string): Promise<ColumnDescription[] | null> => {
      if (!connectionName) return null;
      const key = `${connectionName}.${schema}.${table}`;
      const cached = columnsMeta[key];
      if (cached) return cached;
      try {
        const cols = await api.describe_table(connectionName, schema, table);
        setColumnsMeta((p) => ({ ...p, [key]: cols }));
        return cols;
      } catch {
        return null;
      }
    },
    [connectionName, columnsMeta],
  );

  const getMeta = useCallback(
    (schema: string, table: string): ColumnDescription[] | null => {
      if (!connectionName) return null;
      return columnsMeta[`${connectionName}.${schema}.${table}`] ?? null;
    },
    [connectionName, columnsMeta],
  );

  const getBatch = useCallback((tabId: string) => batches[tabId] ?? emptyBatch, [batches]);
  const getActiveAdds = useCallback((tabId: string) => activeAdds[tabId] ?? [], [activeAdds]);

  const mutateBatch = useCallback(
    (tabId: string, fn: (b: PendingBatch) => PendingBatch) => {
      setBatches((prev) => ({ ...prev, [tabId]: fn(prev[tabId] ?? emptyBatch) }));
    },
    [],
  );

  const stageEditCell = useCallback(
    (tab: EditableTab, rowIdx: number, col: string, value: string | null) => {
      const meta = getMeta(tab.schema, tab.table);
      if (!meta || !tab.result) return;
      const pk = rowKey(tab.result, meta, rowIdx);
      if (!pk) return; // no PK — should already be blocked at editable check
      mutateBatch(tab.id, (b) => stageEdit(b, rowIdx, pk, col, value));
    },
    [getMeta, mutateBatch],
  );

  const stageDeleteRow = useCallback(
    (tab: EditableTab, rowIdx: number) => {
      const meta = getMeta(tab.schema, tab.table);
      if (!meta || !tab.result) return;
      const pk = rowKey(tab.result, meta, rowIdx);
      if (!pk) return;
      mutateBatch(tab.id, (b) => stageDeleteOp(b, rowIdx, pk));
    },
    [getMeta, mutateBatch],
  );

  const undoDeleteRow = useCallback(
    (tab: EditableTab, rowIdx: number) => {
      mutateBatch(tab.id, (b) => unstageDelete(b, rowIdx));
    },
    [mutateBatch],
  );

  const undoCellEdit = useCallback(
    (tab: EditableTab, rowIdx: number, col: string) => {
      mutateBatch(tab.id, (b) => unstageEdit(b, rowIdx, col));
    },
    [mutateBatch],
  );

  const startAdd = useCallback(
    (tab: EditableTab) => {
      tempIdCounter.current += 1;
      const tempId = `add_${tempIdCounter.current}_${Date.now().toString(36)}`;
      setActiveAddsMap((prev) => ({
        ...prev,
        [tab.id]: [...(prev[tab.id] ?? []), { tempId, cells: {} }],
      }));
    },
    [],
  );

  const updateActiveAdd = useCallback(
    (tabId: string, tempId: string, col: string, value: string | null) => {
      setActiveAddsMap((prev) => {
        const list = prev[tabId] ?? [];
        return {
          ...prev,
          [tabId]: list.map((a) =>
            a.tempId === tempId ? { ...a, cells: { ...a.cells, [col]: value } } : a,
          ),
        };
      });
    },
    [],
  );

  const cancelActiveAdd = useCallback((tabId: string, tempId: string) => {
    setActiveAddsMap((prev) => ({
      ...prev,
      [tabId]: (prev[tabId] ?? []).filter((a) => a.tempId !== tempId),
    }));
  }, []);

  const discardAll = useCallback((tabId: string) => {
    setBatches((prev) => ({ ...prev, [tabId]: emptyBatch }));
    setActiveAddsMap((prev) => ({ ...prev, [tabId]: [] }));
  }, []);

  const commit = useCallback(
    async (tab: EditableTab): Promise<MutationOutcome | null> => {
      if (!connectionName) return null;
      const batch = batches[tab.id] ?? emptyBatch;
      const adds = activeAdds[tab.id] ?? [];
      const mb = toMutationBatch(batch, tab.schema, tab.table, adds);
      if (mb.ops.length === 0) return null;
      setBusy(true);
      try {
        const outcome = await api.apply_mutations(connectionName, mb);
        if (outcome.committed) {
          // Clear both batch and active adds on success.
          setBatches((prev) => ({ ...prev, [tab.id]: emptyBatch }));
          setActiveAddsMap((prev) => ({ ...prev, [tab.id]: [] }));
        }
        return outcome;
      } catch (e) {
        return {
          committed: false,
          statements_run: 0,
          elapsed_ms: 0,
          error: String(e),
          error_at: null,
        };
      } finally {
        setBusy(false);
      }
    },
    [connectionName, batches, activeAdds],
  );

  // When the connection switches, clear everything (different DB context).
  useEffect(() => {
    setBatches({});
    setActiveAddsMap({});
    setColumnsMeta({});
  }, [connectionName]);

  return {
    busy,
    getBatch,
    getActiveAdds,
    ensureMeta,
    getMeta,
    stageEditCell,
    stageDeleteRow,
    undoDeleteRow,
    undoCellEdit,
    startAdd,
    updateActiveAdd,
    cancelActiveAdd,
    discardAll,
    commit,
  };
}
