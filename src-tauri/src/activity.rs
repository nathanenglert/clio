use anyhow::Result;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter as _};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::unix::OwnedWriteHalf;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::connections::activity_socket_path;
use crate::core::permission::{
    MigrationVerdict, PendingMigrations, PendingPermissions, PermissionVerdict,
};
use crate::types::ActivityEvent;

/// Erased emitter shared by UI- and MCP-mode core fns.
pub type EmitFn = Arc<dyn Fn(ActivityEvent) + Send + Sync>;

/// Shared handle for sending verdicts back to whichever MCP process is
/// currently connected. Default = no connection (UI hasn't accepted any).
pub type McpWriter = Arc<Mutex<Option<OwnedWriteHalf>>>;

/// Wire envelope for the activity socket. The socket has always carried
/// `ActivityEvent` lines from MCP → UI; Phase 3 extends it to carry
/// `Verdict` lines back from UI → MCP. Wrapping both in a tagged enum keeps
/// the framing line-delimited but unambiguous.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "msg", rename_all = "snake_case")]
pub enum BridgeMsg {
    /// Event from the MCP process for the UI to render on its activity strip.
    Activity { event: ActivityEvent },
    /// Single-statement verdict in response to a `permission_required` event.
    /// MCP looks up `id` in its `PendingPermissions` and resolves the oneshot.
    Verdict {
        id: String,
        verdict: PermissionVerdict,
    },
    /// Bulk-migration verdict in response to a `migration_required` event.
    /// MCP looks up `id` in its `PendingMigrations`.
    MigrationVerdict {
        id: String,
        verdict: MigrationVerdict,
    },
}

/// UI-mode emitter: emit to the Tauri frontend.
pub fn tauri_emitter(app: AppHandle) -> EmitFn {
    Arc::new(move |evt: ActivityEvent| {
        // Best-effort; closed window means we drop the event.
        let _ = app.emit("activity", evt);
    })
}

/// MCP-mode bridge: connects to the UI's activity socket lazily on first
/// emit, splits the stream into read+write halves, spawns a reader task
/// that handles incoming verdicts (calls `pending.resolve`), and returns
/// an `EmitFn` that writes `BridgeMsg::Activity` lines on the write half.
///
/// If the UI is not running, the first emit's connect attempt fails and we
/// silently drop the event — same POC behavior as before. Subsequent emits
/// retry the connect.
pub fn mcp_bridge(pending: PendingPermissions, migrations: PendingMigrations) -> EmitFn {
    let writer: Arc<Mutex<Option<OwnedWriteHalf>>> = Arc::new(Mutex::new(None));
    let handle = tokio::runtime::Handle::try_current().ok();
    Arc::new(move |evt: ActivityEvent| {
        let Some(rt) = handle.clone() else { return };
        let writer = writer.clone();
        let pending = pending.clone();
        let migrations = migrations.clone();
        rt.spawn(async move {
            ensure_mcp_connection(&writer, &pending, &migrations).await;
            let mut guard = writer.lock().await;
            let Some(w) = guard.as_mut() else { return };
            let msg = BridgeMsg::Activity { event: evt };
            let mut line = match serde_json::to_string(&msg) {
                Ok(s) => s,
                Err(_) => return,
            };
            line.push('\n');
            if w.write_all(line.as_bytes()).await.is_err() {
                // Connection broken; drop it so the next emit reconnects.
                *guard = None;
            }
        });
    })
}

/// Open the socket and start the verdict reader if we haven't already.
/// No-op once the connection is established.
async fn ensure_mcp_connection(
    writer: &Arc<Mutex<Option<OwnedWriteHalf>>>,
    pending: &PendingPermissions,
    migrations: &PendingMigrations,
) {
    let mut guard = writer.lock().await;
    if guard.is_some() {
        return;
    }
    let path = match activity_socket_path() {
        Ok(p) => p,
        Err(_) => return,
    };
    let stream = match UnixStream::connect(path).await {
        Ok(s) => s,
        Err(_) => return,
    };
    let (read_half, write_half) = stream.into_split();
    *guard = Some(write_half);

    let pending = pending.clone();
    let migrations = migrations.clone();
    tokio::spawn(async move {
        let mut lines = BufReader::new(read_half).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            let msg: BridgeMsg = match serde_json::from_str(&line) {
                Ok(m) => m,
                Err(e) => {
                    tracing::warn!(error = %e, "mcp bridge: unparseable line dropped");
                    continue;
                }
            };
            match msg {
                BridgeMsg::Verdict { id, verdict } => {
                    if let Err(e) = pending.resolve(&id, verdict).await {
                        tracing::warn!(error = %e, id = %id, "verdict for unknown request");
                    }
                }
                BridgeMsg::MigrationVerdict { id, verdict } => {
                    if let Err(e) = migrations.resolve(&id, verdict).await {
                        tracing::warn!(error = %e, id = %id, "migration verdict for unknown request");
                    }
                }
                BridgeMsg::Activity { .. } => {
                    // MCP shouldn't receive activity events; ignore.
                }
            }
        }
        tracing::info!("mcp bridge: reader closed");
    });
}

/// UI side: listen on the unix socket for connections from MCP subprocesses.
/// For each connection, spawn a reader task that forwards activity events to
/// the frontend, and store the write half on `mcp_writer` so
/// `resolve_permission` can send verdicts back to that same process.
///
/// Single-connection model for now: a new MCP connection replaces the
/// previous writer. Multi-MCP scenarios (multiple agents in parallel) need
/// per-request routing — punt to a future phase.
pub fn spawn_socket_listener(app: AppHandle, mcp_writer: McpWriter) {
    // Shared count of live MCP readers. The strip's "disconnected" state is
    // driven entirely by this — > 0 means at least one MCP is connected.
    // Multiple concurrent readers are rare (single-connection model replaces
    // the writer on each accept) but a stale reader can briefly overlap a
    // new one, so a counter is more honest than a boolean.
    let active = Arc::new(AtomicUsize::new(0));
    tauri::async_runtime::spawn(async move {
        let path = match activity_socket_path() {
            Ok(p) => p,
            Err(_) => return,
        };
        let _ = std::fs::remove_file(&path);
        let listener = match UnixListener::bind(&path) {
            Ok(l) => l,
            Err(e) => {
                tracing::warn!("activity socket bind failed: {e}");
                return;
            }
        };
        loop {
            let (stream, _) = match listener.accept().await {
                Ok(x) => x,
                Err(_) => continue,
            };
            let (read_half, write_half) = stream.into_split();

            // Store the new writer (replacing any previous connection).
            {
                let mut guard = mcp_writer.lock().await;
                *guard = Some(write_half);
            }

            active.fetch_add(1, Ordering::SeqCst);
            let _ = app.emit("mcp_connection", true);

            let app = app.clone();
            let mcp_writer = mcp_writer.clone();
            let active = active.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(read_half).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    let msg: BridgeMsg = match serde_json::from_str(&line) {
                        Ok(m) => m,
                        Err(e) => {
                            tracing::warn!(error = %e, "ui bridge: unparseable line dropped");
                            continue;
                        }
                    };
                    match msg {
                        BridgeMsg::Activity { event } => {
                            let _ = app.emit("activity", event);
                        }
                        BridgeMsg::Verdict { .. }
                        | BridgeMsg::MigrationVerdict { .. } => {
                            // UI shouldn't receive verdicts; ignore.
                        }
                    }
                }
                let remaining = active.fetch_sub(1, Ordering::SeqCst) - 1;
                if remaining == 0 {
                    // Last reader exited — no MCP is connected. Clear the
                    // writer slot so resolve_permission fails fast instead
                    // of writing into a dead socket.
                    let mut guard = mcp_writer.lock().await;
                    *guard = None;
                }
                let _ = app.emit("mcp_connection", remaining > 0);
                tracing::info!("ui bridge: connection closed");
            });
        }
    });
}

/// Send a verdict line to the currently-connected MCP process.
/// Errors when no MCP is connected, or when the write fails (we then drop
/// the broken connection so the next attempt reflects reality).
pub async fn send_verdict_to_mcp(
    writer: &McpWriter,
    id: &str,
    verdict: PermissionVerdict,
) -> Result<(), String> {
    write_bridge_msg(
        writer,
        BridgeMsg::Verdict {
            id: id.to_string(),
            verdict,
        },
    )
    .await
}

/// Send a bulk-migration verdict over the same bridge.
pub async fn send_migration_verdict_to_mcp(
    writer: &McpWriter,
    id: &str,
    verdict: MigrationVerdict,
) -> Result<(), String> {
    write_bridge_msg(
        writer,
        BridgeMsg::MigrationVerdict {
            id: id.to_string(),
            verdict,
        },
    )
    .await
}

async fn write_bridge_msg(writer: &McpWriter, msg: BridgeMsg) -> Result<(), String> {
    let mut line = serde_json::to_string(&msg).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut guard = writer.lock().await;
    let w = guard
        .as_mut()
        .ok_or_else(|| "no MCP process is connected".to_string())?;
    if let Err(e) = w.write_all(line.as_bytes()).await {
        *guard = None;
        return Err(format!("socket write failed: {e}"));
    }
    Ok(())
}

/// Emit an activity event. Call once per tool invocation in core fns.
/// On error, the anyhow error chain is appended to `detail` so the
/// activity strip shows the actual failure reason, not just "error".
pub fn record<T>(
    emit: &EmitFn,
    source: &str,
    tool: &str,
    detail: impl Into<String>,
    started: std::time::Instant,
    result: &Result<T>,
) {
    record_with_payload(emit, source, tool, detail, None, started, result);
}

/// Like [`record`], but also attaches a full-fidelity `payload`. Used for
/// tools whose `detail` is necessarily a one-line summary (e.g. `run_query`
/// truncates SQL to 80 chars for the activity strip).
pub fn record_with_payload<T>(
    emit: &EmitFn,
    source: &str,
    tool: &str,
    detail: impl Into<String>,
    payload: Option<String>,
    started: std::time::Instant,
    result: &Result<T>,
) {
    let elapsed = started.elapsed().as_millis() as u64;
    let mut detail: String = detail.into();
    let status = match result {
        Ok(_) => "ok",
        Err(e) => {
            let err = format!("{e:#}");
            if detail.is_empty() {
                detail = err;
            } else {
                detail.push_str(" — ");
                detail.push_str(&err);
            }
            "error"
        }
    };
    emit(ActivityEvent::new(source, tool, detail, status, elapsed).with_payload(payload));
}

#[cfg(test)]
mod tests {
    use super::*;

    fn evt() -> ActivityEvent {
        ActivityEvent::new("mcp", "run_query", "select 1", "ok", 12)
    }

    #[test]
    fn activity_msg_round_trips() {
        let msg = BridgeMsg::Activity { event: evt() };
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"msg\":\"activity\""));
        assert!(s.contains("\"tool\":\"run_query\""));
        let back: BridgeMsg = serde_json::from_str(&s).unwrap();
        match back {
            BridgeMsg::Activity { event } => {
                assert_eq!(event.tool, "run_query");
                assert_eq!(event.status, "ok");
            }
            _ => panic!("expected Activity"),
        }
    }

    #[test]
    fn verdict_allow_round_trips() {
        let msg = BridgeMsg::Verdict {
            id: "abc-123".into(),
            verdict: PermissionVerdict::Allow,
        };
        let s = serde_json::to_string(&msg).unwrap();
        assert!(s.contains("\"msg\":\"verdict\""));
        assert!(s.contains("\"id\":\"abc-123\""));
        assert!(s.contains("\"kind\":\"allow\""));
        let back: BridgeMsg = serde_json::from_str(&s).unwrap();
        match back {
            BridgeMsg::Verdict { id, verdict } => {
                assert_eq!(id, "abc-123");
                assert!(matches!(verdict, PermissionVerdict::Allow));
            }
            _ => panic!("expected Verdict"),
        }
    }

    #[test]
    fn verdict_modified_carries_sql() {
        let msg = BridgeMsg::Verdict {
            id: "xyz".into(),
            verdict: PermissionVerdict::Modified {
                sql: "SELECT 2".into(),
            },
        };
        let s = serde_json::to_string(&msg).unwrap();
        let back: BridgeMsg = serde_json::from_str(&s).unwrap();
        match back {
            BridgeMsg::Verdict {
                verdict: PermissionVerdict::Modified { sql },
                ..
            } => assert_eq!(sql, "SELECT 2"),
            _ => panic!("expected Modified verdict"),
        }
    }

    #[test]
    fn unparseable_line_does_not_match_either_variant() {
        let r = serde_json::from_str::<BridgeMsg>("{\"msg\":\"bogus\"}");
        assert!(r.is_err());
    }

    #[tokio::test]
    async fn send_verdict_errors_when_no_mcp_connected() {
        let writer: McpWriter = Default::default();
        let err = send_verdict_to_mcp(&writer, "any-id", PermissionVerdict::Allow)
            .await
            .unwrap_err();
        assert!(err.contains("no MCP process"));
    }

    /// Full bidirectional wire test over a real Unix socket. Proves an
    /// `Activity` line going one direction and a `Verdict` line going the
    /// other can be framed, parsed, and matched by id.
    #[tokio::test]
    async fn full_round_trip_over_unix_socket() {
        use tokio::net::{UnixListener, UnixStream};

        // /tmp directly — std::env::temp_dir on macOS is too long for
        // Unix sockets (SUN_LEN ≤ 104 bytes). Short UUID suffix is enough
        // to keep parallel test runs from colliding.
        let path = std::path::PathBuf::from(format!(
            "/tmp/dbb-{}.sock",
            &uuid::Uuid::new_v4().simple().to_string()[..8]
        ));
        let _ = std::fs::remove_file(&path);

        let listener = UnixListener::bind(&path).unwrap();
        let listen_path = path.clone();

        // "UI" side: accept the MCP connection, read the activity event,
        // send back a verdict referencing the same id.
        let server = tokio::spawn(async move {
            let _ = listen_path; // path is just held to keep the temp file alive
            let (stream, _) = listener.accept().await.unwrap();
            let (read, mut write) = stream.into_split();

            let mut lines = BufReader::new(read).lines();
            let line = lines.next_line().await.unwrap().unwrap();
            let msg: BridgeMsg = serde_json::from_str(&line).unwrap();
            let event_id = match msg {
                BridgeMsg::Activity { event } => event.id,
                _ => panic!("expected Activity"),
            };

            let verdict_msg = BridgeMsg::Verdict {
                id: event_id.clone(),
                verdict: PermissionVerdict::Allow,
            };
            let mut out = serde_json::to_string(&verdict_msg).unwrap();
            out.push('\n');
            write.write_all(out.as_bytes()).await.unwrap();
            event_id
        });

        // "MCP" side: connect, send an Activity, then read the Verdict.
        let client_path = path.clone();
        let client = tokio::spawn(async move {
            let stream = UnixStream::connect(&client_path).await.unwrap();
            let (read, mut write) = stream.into_split();

            let event = ActivityEvent::new("mcp", "execute_statement", "test", "pending", 0);
            let event_id = event.id.clone();
            let mut out = serde_json::to_string(&BridgeMsg::Activity { event }).unwrap();
            out.push('\n');
            write.write_all(out.as_bytes()).await.unwrap();

            let mut lines = BufReader::new(read).lines();
            let line = lines.next_line().await.unwrap().unwrap();
            let response: BridgeMsg = serde_json::from_str(&line).unwrap();
            match response {
                BridgeMsg::Verdict { id, verdict } => {
                    assert_eq!(id, event_id);
                    assert!(matches!(verdict, PermissionVerdict::Allow));
                }
                _ => panic!("expected Verdict"),
            }
            event_id
        });

        let server_id = server.await.unwrap();
        let client_id = client.await.unwrap();
        assert_eq!(server_id, client_id);
        let _ = std::fs::remove_file(&path);
    }
}
