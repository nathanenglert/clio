import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { api, onActivity, type ActivityEvent, type Connection } from "./lib/api";
import { ConnectionRail } from "./components/ConnectionRail";
import { SchemaTree } from "./components/SchemaTree";
import { Workspace } from "./components/Workspace";
import { AgentSurface } from "./components/AgentSurface";
import { AddConnectionModal } from "./components/AddConnectionModal";
import { McpConfigModal } from "./components/McpConfigModal";
import { Splitter } from "./components/Splitter";
import { ToastHost } from "./components/Toast";
import { useResizable } from "./lib/useResizable";
import { useTabs } from "./lib/useTabs";

export function App() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showMcp, setShowMcp] = useState(false);

  const rail = useResizable({
    storageKey: "db.layout.rail.width",
    defaultSize: 260,
    min: 200,
    max: 480,
    axis: "x",
  });

  const refresh = async () => {
    try {
      const cs = await api.list_connections();
      setConnections(cs);
      if (!activeName && cs.length > 0) setActiveName(cs[0].name);
    } catch (e) {
      console.error(e);
    }
  };

  useEffect(() => {
    refresh();
    const unlisten = onActivity((e) => {
      setEvents((prev) => [...prev.slice(-199), e]);
      if (e.tool === "connect" || e.tool === "disconnect" || e.tool === "add_connection" || e.tool === "delete_connection") {
        refresh();
      }
    });
    return () => {
      unlisten.then((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const active = connections.find((c) => c.name === activeName) ?? null;
  const tabs = useTabs(activeName);

  // The agent dock should only show the agent's work; user-initiated activity
  // is surfaced separately (History tab). See design/README.md §"Agent activity
  // surface": "There must never be a moment of doubt about who initiated what."
  const agentEvents = useMemo(
    () => events.filter((e) => e.source === "mcp"),
    [events],
  );
  // run_query events from both sources — surfaced as History so the user can
  // re-run their own past queries alongside the agent's.
  const recentQueries = useMemo(
    () => events.filter((e) => e.tool === "run_query"),
    [events],
  );

  const runActive = useCallback(async () => {
    const tab = tabs.activeTab;
    if (!tab || !activeName) return;
    if (!active?.connected) {
      tabs.updateTab(tab.id, { error: "Not connected. Click a connection in the rail.", result: null });
      return;
    }
    tabs.updateTab(tab.id, { running: true, error: null });
    try {
      const result = await api.run_query(activeName, tab.sql);
      tabs.updateTab(tab.id, { result, running: false, dirty: false });
    } catch (e) {
      tabs.updateTab(tab.id, { error: String(e), running: false, result: null });
    }
  }, [tabs, activeName, active?.connected]);

  const onPickTable = (schema: string, table: string) => {
    tabs.openOrSwitchTable(schema, table);
  };

  const onAgentOpen = (sql: string) => {
    tabs.addAgentTab(sql);
  };

  const onAgentRerun = async (sql: string) => {
    const id = tabs.addAgentTab(sql);
    if (!id || !activeName || !active?.connected) return;
    // The new tab is now active; run it directly.
    tabs.updateTab(id, { running: true, error: null });
    try {
      const result = await api.run_query(activeName, sql);
      tabs.updateTab(id, { result, running: false, dirty: false });
    } catch (e) {
      tabs.updateTab(id, { error: String(e), running: false, result: null });
    }
  };

  return (
    <div
      className="shell"
      style={{ "--rail-w": `${rail.size}px` } as CSSProperties}
    >
      <div className="rail">
        <ConnectionRail
          connections={connections}
          activeName={activeName}
          onSelect={setActiveName}
          onChanged={refresh}
          onAdd={() => setShowAdd(true)}
        />
        <SchemaTree
          connectionName={active && active.connected ? active.name : null}
          onPickTable={onPickTable}
        />
        <Splitter
          orientation="vertical"
          dragging={rail.dragging}
          title="Drag to resize · double-click to reset"
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 0,
            width: 6,
          }}
          {...rail.handleProps}
        />
      </div>
      <div className="work">
        <Workspace
          active={active}
          tabs={tabs.tabs}
          activeTab={tabs.activeTab}
          onSelectTab={tabs.setActive}
          onCloseTab={tabs.closeTab}
          onAddTab={tabs.addScratchTab}
          onSqlChange={(id, sql) => tabs.setSql(id, sql)}
          onRun={runActive}
          onOpenMcpModal={() => setShowMcp(true)}
        />
      </div>
      <AgentSurface
        events={agentEvents}
        recentQueries={recentQueries}
        onOpenSql={onAgentOpen}
        onRerunSql={onAgentRerun}
      />
      <div className="status">
        <span>{connections.length} connection{connections.length === 1 ? "" : "s"}</span>
        <span>·</span>
        <span>{active ? (active.connected ? "connected" : "disconnected") : "no active connection"}</span>
        <span style={{ marginLeft: "auto", color: "var(--text-faint)" }}>
          POC v0.0
        </span>
      </div>

      {showAdd && (
        <AddConnectionModal
          onClose={() => setShowAdd(false)}
          onAdded={() => refresh()}
        />
      )}
      {showMcp && <McpConfigModal onClose={() => setShowMcp(false)} />}
      <ToastHost />
    </div>
  );
}
