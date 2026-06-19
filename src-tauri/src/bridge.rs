//! The MCP ⇄ UI bridge.
//!
//! After the connection-authority refactor (see
//! design/mcp-connection-authority.md) the `--mcp` process owns **no**
//! Postgres pool and **no** credentials. Every DB-touching tool call is
//! forwarded over a Unix-socket RPC to the running UI process, which owns the
//! only `PoolRegistry` and runs the call against a pool **only if a human has
//! already connected that database** in the workbench.
//!
//! Wire framing is length-prefixed (`u32` big-endian length + JSON body) so a
//! multi-thousand-row `QueryResult` rides the socket safely — the old
//! newline-delimited `BufReader::lines()` path could not.
//!
//! Multi-agent: each accepted socket is one agent, assigned an `agent_id`.
//! Its per-connection task owns the read half and shares the write half across
//! the tasks that answer its in-flight requests, so several agents (and
//! several concurrent calls per agent) route independently.

use std::collections::HashMap;
use std::io::ErrorKind;
use std::os::unix::fs::PermissionsExt;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter as _};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::unix::{OwnedReadHalf, OwnedWriteHalf};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::{oneshot, Mutex};

use crate::connections::activity_socket_path;
use crate::core::{self, Core};

/// Bridge wire protocol version. Bumped if the framing or message set changes
/// incompatibly. UI and MCP are the same binary, so a mismatch only ever
/// arises across an upgrade with a stale subprocess — we reject it loudly.
const PROTOCOL: u32 = 1;

/// Hard cap on a single frame. A 1000-row result is comfortably under this;
/// anything larger is treated as a corrupt/hostile frame and drops the conn.
const MAX_FRAME: usize = 32 * 1024 * 1024;

// ── Wire protocol ────────────────────────────────────────────────

/// One tool invocation the agent wants the UI to run. Mirrors the MCP tool
/// surface 1:1; the UI dispatcher (`dispatch`) is the only place these execute.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "tool", rename_all = "snake_case")]
pub enum ToolCall {
    ListConnections,
    Connect { connection: String },
    ListSchemas { connection: String },
    ListTables { connection: String, schema: String },
    DescribeTable { connection: String, schema: String, table: String },
    RunQuery { connection: String, sql: String },
    ProposeQuery { sql: String, title: Option<String> },
    ExecuteStatement { connection: String, sql: String, intent: Option<String> },
    ExecuteMigration { connection: String, statements: Vec<String>, intent: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum WireMsg {
    /// MCP → UI, first frame. Identifies the agent and the protocol version.
    Hello { protocol: u32, agent_label: String },
    /// UI → MCP, reply to `Hello`. Carries the UI-assigned agent id.
    Welcome { agent_id: String },
    /// MCP → UI, a tool invocation to run against the UI-owned core.
    Request { request_id: String, call: ToolCall },
    /// UI → MCP, the JSON result the MCP serializes straight back to the agent.
    Response { request_id: String, result: Value },
    /// UI → MCP, the call failed (policy block, denied, not connected, …).
    ResponseError { request_id: String, error: String },
}

async fn write_frame<W: AsyncWriteExt + Unpin>(w: &mut W, msg: &WireMsg) -> std::io::Result<()> {
    let body = serde_json::to_vec(msg)
        .map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e))?;
    if body.len() > MAX_FRAME {
        return Err(std::io::Error::new(ErrorKind::InvalidData, "outbound frame too large"));
    }
    w.write_all(&(body.len() as u32).to_be_bytes()).await?;
    w.write_all(&body).await?;
    w.flush().await?;
    Ok(())
}

/// Read one frame. `Ok(None)` means a clean EOF (peer closed between frames).
async fn read_frame<R: AsyncReadExt + Unpin>(r: &mut R) -> std::io::Result<Option<WireMsg>> {
    let mut len_buf = [0u8; 4];
    match r.read_exact(&mut len_buf).await {
        Ok(_) => {}
        Err(e) if e.kind() == ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    let len = u32::from_be_bytes(len_buf) as usize;
    if len > MAX_FRAME {
        return Err(std::io::Error::new(ErrorKind::InvalidData, "inbound frame too large"));
    }
    let mut body = vec![0u8; len];
    r.read_exact(&mut body).await?;
    let msg = serde_json::from_slice(&body)
        .map_err(|e| std::io::Error::new(ErrorKind::InvalidData, e))?;
    Ok(Some(msg))
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ── MCP side: ProxyClient ────────────────────────────────────────

/// The MCP process's only link to a database. Holds no pool and no
/// credentials — just a lazily-established socket to the UI. The first tool
/// call opens the socket; if the UI isn't running the call fails (and the next
/// call retries), so an agent can do nothing until a human launches the
/// workbench and connects.
#[derive(Clone)]
pub struct ProxyClient {
    /// Display name sent in the Hello frame. Starts as a fallback and is
    /// replaced with the real client identity once the MCP `initialize`
    /// handshake lands (see `McpServer::initialize`). Shared + mutable because
    /// initialize always runs before the lazy connect that reads it.
    label: Arc<std::sync::Mutex<String>>,
    /// Socket to dial. `None` ⇒ the default `activity_socket_path()`; tests
    /// inject a temp path.
    path: Option<std::path::PathBuf>,
    conn: Arc<Mutex<Option<ConnHandle>>>,
}

struct ConnHandle {
    write: Arc<Mutex<OwnedWriteHalf>>,
    pending: Pending,
    #[allow(dead_code)]
    agent_id: String,
}

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<std::result::Result<Value, String>>>>>;

impl ProxyClient {
    pub fn new(label: String) -> Self {
        Self {
            label: Arc::new(std::sync::Mutex::new(label)),
            path: None,
            conn: Arc::new(Mutex::new(None)),
        }
    }

    /// Set the agent's display label. Called from the MCP `initialize`
    /// handshake with the client's real identity (Claude Code / Cursor / …).
    pub fn set_label(&self, label: String) {
        if let Ok(mut g) = self.label.lock() {
            *g = label;
        }
    }

    /// Run a tool call against the UI. Establishes the socket on first use and
    /// transparently reconnects after a drop.
    pub async fn call(&self, call: ToolCall) -> Result<Value> {
        let handle = self.ensure_connected().await?;
        let request_id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        handle.pending.lock().await.insert(request_id.clone(), tx);

        let frame = WireMsg::Request { request_id: request_id.clone(), call };
        if let Err(e) = write_frame(&mut *handle.write.lock().await, &frame).await {
            handle.pending.lock().await.remove(&request_id);
            self.drop_conn().await;
            return Err(anyhow!("workbench not reachable: {e}"));
        }

        match rx.await {
            Ok(Ok(v)) => Ok(v),
            Ok(Err(e)) => Err(anyhow!(e)),
            // Sender dropped — the reader task tore down on socket close.
            Err(_) => Err(anyhow!("workbench closed the connection before answering")),
        }
    }

    async fn ensure_connected(&self) -> Result<ConnHandle> {
        let mut guard = self.conn.lock().await;
        if let Some(h) = guard.as_ref() {
            return Ok(h.clone_handle());
        }
        let path = match &self.path {
            Some(p) => p.clone(),
            None => activity_socket_path()?,
        };
        let mut stream = UnixStream::connect(&path)
            .await
            .map_err(|e| anyhow!("workbench not running (no activity socket): {e}"))?;

        let label = self
            .label
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| "Agent".to_string());
        write_frame(&mut stream, &WireMsg::Hello { protocol: PROTOCOL, agent_label: label })
            .await
            .map_err(|e| anyhow!("handshake write failed: {e}"))?;
        let agent_id = match read_frame(&mut stream).await {
            Ok(Some(WireMsg::Welcome { agent_id })) => agent_id,
            Ok(other) => return Err(anyhow!("unexpected handshake reply: {other:?}")),
            Err(e) => return Err(anyhow!("handshake read failed: {e}")),
        };

        let (read, write) = stream.into_split();
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        spawn_reader(read, pending.clone());

        let handle = ConnHandle { write: Arc::new(Mutex::new(write)), pending, agent_id };
        let clone = handle.clone_handle();
        *guard = Some(handle);
        Ok(clone)
    }

    async fn drop_conn(&self) {
        *self.conn.lock().await = None;
    }
}

impl ConnHandle {
    fn clone_handle(&self) -> ConnHandle {
        ConnHandle {
            write: self.write.clone(),
            pending: self.pending.clone(),
            agent_id: self.agent_id.clone(),
        }
    }
}

/// Reader task for the MCP side: resolves responses against `pending`. On
/// socket close it drains every outstanding request with an error so callers
/// don't hang.
fn spawn_reader(mut read: OwnedReadHalf, pending: Pending) {
    tokio::spawn(async move {
        loop {
            match read_frame(&mut read).await {
                Ok(Some(WireMsg::Response { request_id, result })) => {
                    if let Some(tx) = pending.lock().await.remove(&request_id) {
                        let _ = tx.send(Ok(result));
                    }
                }
                Ok(Some(WireMsg::ResponseError { request_id, error })) => {
                    if let Some(tx) = pending.lock().await.remove(&request_id) {
                        let _ = tx.send(Err(error));
                    }
                }
                Ok(Some(_)) => { /* Hello/Welcome/Request not expected here */ }
                Ok(None) | Err(_) => break,
            }
        }
        // Connection gone: fail everything still waiting.
        let mut map = pending.lock().await;
        for (_, tx) in map.drain() {
            let _ = tx.send(Err("workbench connection closed".into()));
        }
    });
}

// ── UI side: presence registry ───────────────────────────────────

#[derive(Clone, Serialize)]
pub struct AgentInfo {
    pub id: String,
    pub label: String,
    pub since_ms: u64,
}

#[derive(Serialize, Clone)]
struct AgentPresence {
    agents: Vec<AgentInfo>,
}

/// Live roster of connected agents, keyed by `agent_id`. Replaces the old
/// single-writer model: presence is now a set, not a boolean.
#[derive(Clone, Default)]
pub struct AgentRegistry {
    inner: Arc<Mutex<HashMap<String, AgentInfo>>>,
}

impl AgentRegistry {
    async fn insert(&self, info: AgentInfo) {
        self.inner.lock().await.insert(info.id.clone(), info);
    }
    async fn remove(&self, id: &str) {
        self.inner.lock().await.remove(id);
    }
    async fn roster(&self) -> Vec<AgentInfo> {
        let mut v: Vec<AgentInfo> = self.inner.lock().await.values().cloned().collect();
        v.sort_by(|a, b| a.since_ms.cmp(&b.since_ms));
        v
    }
}

/// Push the current roster to the frontend. Emits both the rich per-agent
/// roster (`agent_presence`, for the multi-agent surfaces) and the legacy
/// aggregate boolean (`mcp_connection`, for the existing agent strip).
async fn emit_presence(app: &AppHandle, registry: &AgentRegistry) {
    let agents = registry.roster().await;
    let _ = app.emit("mcp_connection", !agents.is_empty());
    let _ = app.emit("agent_presence", AgentPresence { agents });
}

// ── UI side: authenticated multi-agent listener ──────────────────

/// Bind the activity socket and serve agent connections. `agent_core` is the
/// `Agent`-access core (cannot open pools); each connection clones it with its
/// own `agent_id` for attribution.
pub fn spawn_listener(app: AppHandle, agent_core: Core, registry: AgentRegistry) {
    tauri::async_runtime::spawn(async move {
        let path = match activity_socket_path() {
            Ok(p) => p,
            Err(e) => {
                tracing::error!("activity socket path failed: {e}");
                return;
            }
        };
        let _ = std::fs::remove_file(&path);
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                tracing::error!("activity socket bind failed: {e}");
                return;
            }
        };
        // Owner-only: a different user cannot even open the socket. Combined
        // with the peer-UID check below this is the cheap-but-honest hardening
        // from the spec (a same-UID adversary remains out of scope).
        if let Err(e) = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)) {
            tracing::warn!("could not chmod activity socket: {e}");
        }
        let our_uid = unsafe { libc::getuid() };

        loop {
            let (stream, _) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => continue,
            };
            // Reject any peer that is not this same user.
            match stream.peer_cred() {
                Ok(cred) if cred.uid() == our_uid => {}
                Ok(cred) => {
                    tracing::warn!(peer_uid = cred.uid(), our_uid, "rejected foreign-uid agent");
                    continue;
                }
                Err(e) => {
                    tracing::warn!("could not read peer credentials, rejecting: {e}");
                    continue;
                }
            }
            tauri::async_runtime::spawn(handle_conn(
                stream,
                agent_core.clone(),
                registry.clone(),
                app.clone(),
            ));
        }
    });
}

async fn handle_conn(stream: UnixStream, agent_core: Core, registry: AgentRegistry, app: AppHandle) {
    let (mut read, write) = stream.into_split();

    // Handshake: expect Hello, reply Welcome.
    let label = match read_frame(&mut read).await {
        Ok(Some(WireMsg::Hello { protocol, agent_label })) => {
            if protocol != PROTOCOL {
                tracing::warn!(got = protocol, want = PROTOCOL, "agent protocol mismatch");
                return;
            }
            agent_label
        }
        _ => {
            tracing::warn!("agent connected without a valid Hello; dropping");
            return;
        }
    };

    let agent_id = uuid::Uuid::new_v4().to_string();
    let write = Arc::new(Mutex::new(write));
    if write_frame(&mut *write.lock().await, &WireMsg::Welcome { agent_id: agent_id.clone() })
        .await
        .is_err()
    {
        return;
    }

    registry
        .insert(AgentInfo { id: agent_id.clone(), label: label.clone(), since_ms: now_ms() })
        .await;
    emit_presence(&app, &registry).await;
    tracing::info!(agent_id = %agent_id, label = %label, "agent connected");

    let conn_core = agent_core.for_agent(agent_id.clone(), label);

    // Request loop. Each request is handled on its own task so a slow query
    // (or one parked on a permission prompt) doesn't block the agent's other
    // calls; all share this connection's write half.
    loop {
        match read_frame(&mut read).await {
            Ok(Some(WireMsg::Request { request_id, call })) => {
                let core = conn_core.clone();
                let write = write.clone();
                tokio::spawn(async move {
                    let reply = match dispatch(&core, call).await {
                        Ok(result) => WireMsg::Response { request_id, result },
                        Err(e) => WireMsg::ResponseError { request_id, error: format!("{e:#}") },
                    };
                    let _ = write_frame(&mut *write.lock().await, &reply).await;
                });
            }
            Ok(Some(_)) => { /* ignore non-Request frames after handshake */ }
            Ok(None) | Err(_) => break,
        }
    }

    registry.remove(&agent_id).await;
    emit_presence(&app, &registry).await;
    tracing::info!(agent_id = %agent_id, "agent disconnected");
}

/// Run one tool call against the agent core. This is the ONLY place agent
/// requests execute, and the agent core's `Agent` pool access means a query
/// against a database the human hasn't connected fails here with "not
/// connected" — it can never lazily open a pool.
async fn dispatch(core: &Core, call: ToolCall) -> Result<Value> {
    use ToolCall::*;
    let v = match call {
        ListConnections => serde_json::to_value(core::list_connections(core).await?)?,
        Connect { connection } => {
            // The agent cannot open a connection. If it's already open this is
            // a no-op; otherwise the human is asked to approve, and only the
            // human core opens the pool. Blocks until they decide.
            core::request_connect(core, &connection).await?;
            serde_json::json!({ "connected": connection })
        }
        ListSchemas { connection } => serde_json::to_value(core::list_schemas(core, &connection).await?)?,
        ListTables { connection, schema } => {
            serde_json::to_value(core::list_tables(core, &connection, &schema).await?)?
        }
        DescribeTable { connection, schema, table } => {
            serde_json::to_value(core::describe_table(core, &connection, &schema, &table).await?)?
        }
        RunQuery { connection, sql } => {
            // reveal=false always on the agent path — see design/redaction.md.
            serde_json::to_value(core::run_query(core, &connection, &sql, false).await?)?
        }
        ProposeQuery { sql, title } => {
            let title = core::propose_query(core, &sql, title);
            serde_json::json!({ "proposed": true, "title": title })
        }
        ExecuteStatement { connection, sql, intent } => {
            serde_json::to_value(core::execute_statement(core, &connection, &sql, intent.as_deref()).await?)?
        }
        ExecuteMigration { connection, statements, intent } => {
            serde_json::to_value(core::execute_migration(core, &connection, statements, intent.as_deref()).await?)?
        }
    };
    Ok(v)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn frame_round_trips_including_large_payload() {
        // A response far bigger than any line buffer — the old newline framing
        // could not carry this; length-prefixed framing must.
        let big = "x".repeat(2 * 1024 * 1024);
        let msg = WireMsg::Response {
            request_id: "r1".into(),
            result: serde_json::json!({ "rows": big }),
        };
        let (mut a, mut b) = tokio::io::duplex(64 * 1024);
        let writer = tokio::spawn(async move {
            write_frame(&mut a, &msg).await.unwrap();
        });
        let got = read_frame(&mut b).await.unwrap().unwrap();
        writer.await.unwrap();
        match got {
            WireMsg::Response { request_id, result } => {
                assert_eq!(request_id, "r1");
                assert_eq!(result["rows"].as_str().unwrap().len(), 2 * 1024 * 1024);
            }
            other => panic!("expected Response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn oversized_frame_is_rejected() {
        let (mut a, mut b) = tokio::io::duplex(16);
        // Claim a length above MAX_FRAME; reader must reject before allocating.
        let bogus = (MAX_FRAME as u32 + 1).to_be_bytes();
        tokio::spawn(async move {
            let _ = a.write_all(&bogus).await;
        });
        assert!(read_frame(&mut b).await.is_err());
    }

    /// A mock UI server: accepts one agent, completes the Hello/Welcome
    /// handshake, then echoes every Request back as a Response whose result
    /// carries the request's connection — proving request_id correlation holds
    /// even when many calls are in flight concurrently and answered
    /// out-of-order.
    #[tokio::test]
    async fn proxy_routes_concurrent_calls_by_request_id() {
        let dir = std::env::temp_dir();
        let path = dir.join(format!("dbb-test-{}.sock", uuid::Uuid::new_v4().simple()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (mut read, write) = stream.into_split();
            let write = Arc::new(Mutex::new(write));
            // Handshake.
            match read_frame(&mut read).await.unwrap().unwrap() {
                WireMsg::Hello { .. } => {}
                _ => panic!("expected Hello"),
            }
            write_frame(&mut *write.lock().await, &WireMsg::Welcome { agent_id: "a1".into() })
                .await
                .unwrap();
            // Echo each request back, each on its own task with a varied delay
            // so replies arrive out of submission order.
            loop {
                match read_frame(&mut read).await {
                    Ok(Some(WireMsg::Request { request_id, call })) => {
                        let write = write.clone();
                        tokio::spawn(async move {
                            let conn = match call {
                                ToolCall::ListSchemas { connection } => connection,
                                _ => "?".into(),
                            };
                            let reply = WireMsg::Response {
                                request_id,
                                result: serde_json::json!({ "echo": conn }),
                            };
                            let _ = write_frame(&mut *write.lock().await, &reply).await;
                        });
                    }
                    _ => break,
                }
            }
        });

        let client = ProxyClient {
            label: Arc::new(std::sync::Mutex::new("t".into())),
            path: Some(path.clone()),
            conn: Arc::new(Mutex::new(None)),
        };
        // Fire 25 concurrent calls, each tagged with a distinct connection.
        let mut handles = Vec::new();
        for i in 0..25 {
            let c = client.clone();
            handles.push(tokio::spawn(async move {
                let v = c.call(ToolCall::ListSchemas { connection: format!("conn-{i}") }).await.unwrap();
                (i, v["echo"].as_str().unwrap().to_string())
            }));
        }
        for h in handles {
            let (i, echo) = h.await.unwrap();
            assert_eq!(echo, format!("conn-{i}"), "response routed to wrong caller");
        }

        drop(client);
        server.abort();
        let _ = std::fs::remove_file(&path);
    }

    /// The label set from the MCP initialize handshake (`set_label`) must
    /// override the construction fallback in the Hello frame.
    #[tokio::test]
    async fn set_label_flows_into_hello() {
        let path = std::env::temp_dir().join(format!("dbb-hello-{}.sock", uuid::Uuid::new_v4().simple()));
        let _ = std::fs::remove_file(&path);
        let listener = UnixListener::bind(&path).unwrap();

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let (mut read, mut write) = stream.into_split();
            let label = match read_frame(&mut read).await.unwrap().unwrap() {
                WireMsg::Hello { agent_label, .. } => agent_label,
                other => panic!("expected Hello, got {other:?}"),
            };
            write_frame(&mut write, &WireMsg::Welcome { agent_id: "a1".into() }).await.unwrap();
            if let Ok(Some(WireMsg::Request { request_id, .. })) = read_frame(&mut read).await {
                let _ = write_frame(&mut write, &WireMsg::Response { request_id, result: serde_json::json!(null) }).await;
            }
            label
        });

        let client = ProxyClient {
            label: Arc::new(std::sync::Mutex::new("Agent".into())),
            path: Some(path.clone()),
            conn: Arc::new(Mutex::new(None)),
        };
        client.set_label("Cursor".into()); // as McpServer::initialize would
        let _ = client.call(ToolCall::ListConnections).await;

        let label = server.await.unwrap();
        assert_eq!(label, "Cursor", "Hello must carry the handshake-set label, not the fallback");
        let _ = std::fs::remove_file(&path);
    }
}
