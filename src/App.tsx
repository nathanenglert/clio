import { useEffect, useState } from "react";
import { api, onActivity, type ActivityEvent, type Connection } from "./lib/api";
import { ConnectionRail } from "./components/ConnectionRail";
import { SchemaTree } from "./components/SchemaTree";
import { Workspace } from "./components/Workspace";
import { AgentSurface } from "./components/AgentSurface";
import { AddConnectionModal } from "./components/AddConnectionModal";
import { McpConfigModal } from "./components/McpConfigModal";

export function App() {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [activeName, setActiveName] = useState<string | null>(null);
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [showMcp, setShowMcp] = useState(false);
  const [sql, setSql] = useState("SELECT now() AS server_time;");
  const [runTrigger, setRunTrigger] = useState(0);

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
      // Connection-state-changing tools should refresh the rail
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

  const onPickTable = (schema: string, table: string) => {
    setSql(`SELECT *\nFROM ${schema}.${table}\nLIMIT 100;`);
  };

  return (
    <div className="shell">
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
      </div>
      <div className="work">
        <Workspace
          active={active}
          sql={sql}
          setSql={setSql}
          onOpenMcpModal={() => setShowMcp(true)}
          runTrigger={runTrigger}
        />
      </div>
      <AgentSurface
        events={events}
        onOpenSql={setSql}
        onRerunSql={(s) => {
          setSql(s);
          setRunTrigger((n) => n + 1);
        }}
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
    </div>
  );
}
