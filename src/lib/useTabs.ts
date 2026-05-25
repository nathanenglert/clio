import { useCallback, useEffect, useRef, useState } from "react";
import type { QueryResult } from "./api";

export type TabSource = "scratch" | "table" | "agent" | "library";

export type Tab = {
  id: string;
  title: string;
  sql: string;
  dirty: boolean;
  source: TabSource;
  agentAuthored: boolean;
  /** "schema.table" for table-sourced tabs — used to open-or-switch. */
  schemaTableKey?: string;
  /** Saved-query id for library-sourced tabs — used to open-or-switch. */
  libraryId?: string;
  // Runtime (not persisted)
  result: QueryResult | null;
  error: string | null;
  running: boolean;
};

type ConnTabs = {
  tabs: Tab[];
  activeId: string | null;
  nextScratchN: number;
};

type State = Record<string, ConnTabs>;

const STORAGE_KEY = "db.tabs.v1";
const DEFAULT_SQL = "SELECT now() AS server_time;";

const emptyConn = (): ConnTabs => ({ tabs: [], activeId: null, nextScratchN: 1 });

function newId() {
  return `t_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function freshScratchTab(n: number): Tab {
  return {
    id: newId(),
    title: `Query ${n}`,
    sql: DEFAULT_SQL,
    dirty: false,
    source: "scratch",
    agentAuthored: false,
    result: null,
    error: null,
    running: false,
  };
}

type PersistedTab = Pick<
  Tab,
  "id" | "title" | "sql" | "dirty" | "source" | "agentAuthored" | "schemaTableKey" | "libraryId"
>;
type PersistedConn = { tabs: PersistedTab[]; activeId: string | null; nextScratchN: number };
type Persisted = Record<string, PersistedConn>;

function loadState(): State {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw) as Persisted;
    const out: State = {};
    for (const [conn, p] of Object.entries(data)) {
      out[conn] = {
        activeId: p.activeId,
        nextScratchN: p.nextScratchN ?? 1,
        tabs: (p.tabs ?? []).map((t) => ({
          ...t,
          agentAuthored: t.agentAuthored ?? false,
          source: t.source ?? "scratch",
          result: null,
          error: null,
          running: false,
        })),
      };
    }
    return out;
  } catch {
    return {};
  }
}

function persist(state: State) {
  const out: Persisted = {};
  for (const [conn, c] of Object.entries(state)) {
    out[conn] = {
      activeId: c.activeId,
      nextScratchN: c.nextScratchN,
      tabs: c.tabs.map((t) => ({
        id: t.id,
        title: t.title,
        sql: t.sql,
        dirty: t.dirty,
        source: t.source,
        agentAuthored: t.agentAuthored,
        schemaTableKey: t.schemaTableKey,
        libraryId: t.libraryId,
      })),
    };
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(out));
  } catch {
    // ignore quota / privacy errors
  }
}

export function useTabs(connectionName: string | null) {
  const [state, setState] = useState<State>(loadState);

  // Debounced persistence on state change.
  const saveTimer = useRef<number | null>(null);
  useEffect(() => {
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => persist(state), 250);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [state]);

  // Ensure the active connection has at least one tab.
  useEffect(() => {
    if (!connectionName) return;
    setState((prev) => {
      const c = prev[connectionName] ?? emptyConn();
      if (c.tabs.length > 0) return prev;
      const seed = freshScratchTab(c.nextScratchN);
      return {
        ...prev,
        [connectionName]: {
          tabs: [seed],
          activeId: seed.id,
          nextScratchN: c.nextScratchN + 1,
        },
      };
    });
  }, [connectionName]);

  const conn = (connectionName && state[connectionName]) || emptyConn();
  const activeTab = conn.tabs.find((t) => t.id === conn.activeId) ?? null;

  const mutate = useCallback(
    (fn: (c: ConnTabs) => ConnTabs) => {
      if (!connectionName) return;
      setState((prev) => {
        const cur = prev[connectionName] ?? emptyConn();
        return { ...prev, [connectionName]: fn(cur) };
      });
    },
    [connectionName],
  );

  const updateTab = useCallback(
    (id: string, patch: Partial<Tab>) => {
      mutate((c) => ({
        ...c,
        tabs: c.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      }));
    },
    [mutate],
  );

  const setActive = useCallback(
    (id: string) => mutate((c) => ({ ...c, activeId: id })),
    [mutate],
  );

  const closeTab = useCallback(
    (id: string) => {
      mutate((c) => {
        const idx = c.tabs.findIndex((t) => t.id === id);
        if (idx < 0) return c;
        const tabs = c.tabs.filter((t) => t.id !== id);
        let activeId = c.activeId;
        if (activeId === id) {
          const next = tabs[idx] ?? tabs[idx - 1] ?? null;
          activeId = next?.id ?? null;
        }
        if (tabs.length === 0) {
          const seed = freshScratchTab(c.nextScratchN);
          return { tabs: [seed], activeId: seed.id, nextScratchN: c.nextScratchN + 1 };
        }
        return { ...c, tabs, activeId };
      });
    },
    [mutate],
  );

  const addScratchTab = useCallback(() => {
    let createdId: string | null = null;
    mutate((c) => {
      const seed = freshScratchTab(c.nextScratchN);
      createdId = seed.id;
      return {
        tabs: [...c.tabs, seed],
        activeId: seed.id,
        nextScratchN: c.nextScratchN + 1,
      };
    });
    return createdId;
  }, [mutate]);

  const addAgentTab = useCallback(
    (sql: string, title?: string) => {
      let createdId: string | null = null;
      mutate((c) => {
        const tab: Tab = {
          id: newId(),
          title: title ?? `agent ${c.nextScratchN}`,
          sql,
          dirty: false,
          source: "agent",
          agentAuthored: true,
          result: null,
          error: null,
          running: false,
        };
        createdId = tab.id;
        return {
          ...c,
          tabs: [...c.tabs, tab],
          activeId: tab.id,
          nextScratchN: c.nextScratchN + 1,
        };
      });
      return createdId;
    },
    [mutate],
  );

  const openOrSwitchTable = useCallback(
    (schema: string, table: string) => {
      const key = `${schema}.${table}`;
      mutate((c) => {
        const existing = c.tabs.find((t) => t.schemaTableKey === key);
        if (existing) return { ...c, activeId: existing.id };
        const tab: Tab = {
          id: newId(),
          title: table,
          sql: `SELECT *\nFROM ${schema}.${table}\nLIMIT 100;`,
          dirty: false,
          source: "table",
          schemaTableKey: key,
          agentAuthored: false,
          result: null,
          error: null,
          running: false,
        };
        return { ...c, tabs: [...c.tabs, tab], activeId: tab.id };
      });
    },
    [mutate],
  );

  /**
   * Open a saved query in a tab. If the same libraryId is already open we just
   * focus it. If the active tab is an untouched scratch (still on its seed
   * SQL, no edits, no result yet) we reuse it — opening a query shouldn't
   * leave behind an empty "Query 1" tab on first interaction.
   */
  const openLibraryQuery = useCallback(
    (entry: { id: string; name: string; body: string }) => {
      let openedId: string | null = null;
      mutate((c) => {
        const existing = c.tabs.find((t) => t.libraryId === entry.id);
        if (existing) {
          openedId = existing.id;
          return { ...c, activeId: existing.id };
        }
        const active = c.tabs.find((t) => t.id === c.activeId);
        const reusable =
          active &&
          active.source === "scratch" &&
          !active.dirty &&
          active.result == null &&
          active.error == null &&
          active.sql === DEFAULT_SQL;
        if (reusable && active) {
          openedId = active.id;
          return {
            ...c,
            tabs: c.tabs.map((t) =>
              t.id === active.id
                ? {
                    ...t,
                    title: entry.name,
                    sql: entry.body,
                    dirty: false,
                    source: "library" as TabSource,
                    libraryId: entry.id,
                    result: null,
                    error: null,
                  }
                : t,
            ),
          };
        }
        const tab: Tab = {
          id: newId(),
          title: entry.name,
          sql: entry.body,
          dirty: false,
          source: "library",
          libraryId: entry.id,
          agentAuthored: false,
          result: null,
          error: null,
          running: false,
        };
        openedId = tab.id;
        return { ...c, tabs: [...c.tabs, tab], activeId: tab.id };
      });
      return openedId;
    },
    [mutate],
  );

  /**
   * Update a saved tab in place to reflect a fresh save: clears `dirty`,
   * stamps the (possibly renamed) title, and binds the libraryId on first
   * save. Used by the ⌘S write-through and the Save-as flows.
   */
  const bindLibrary = useCallback(
    (tabId: string, libraryId: string, name: string, body: string) => {
      updateTab(tabId, {
        source: "library",
        libraryId,
        title: name,
        sql: body,
        dirty: false,
      });
    },
    [updateTab],
  );

  /** Detach a library binding (e.g. saved query was deleted while open). */
  const unbindLibrary = useCallback(
    (libraryId: string) => {
      mutate((c) => ({
        ...c,
        tabs: c.tabs.map((t) =>
          t.libraryId === libraryId
            ? { ...t, source: "scratch" as TabSource, libraryId: undefined, dirty: true }
            : t,
        ),
      }));
    },
    [mutate],
  );

  const setSql = useCallback(
    (id: string, sql: string) => {
      updateTab(id, { sql, dirty: true });
    },
    [updateTab],
  );

  return {
    tabs: conn.tabs,
    activeId: conn.activeId,
    activeTab,
    setActive,
    closeTab,
    addScratchTab,
    addAgentTab,
    openOrSwitchTable,
    openLibraryQuery,
    bindLibrary,
    unbindLibrary,
    setSql,
    updateTab,
  };
}
