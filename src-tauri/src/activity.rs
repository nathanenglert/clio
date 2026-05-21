use anyhow::Result;
use std::sync::Arc;
use tauri::{AppHandle, Emitter as _};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::Mutex;

use crate::connections::activity_socket_path;
use crate::types::ActivityEvent;

/// Erased emitter shared by UI- and MCP-mode core fns.
pub type EmitFn = Arc<dyn Fn(ActivityEvent) + Send + Sync>;

/// UI-mode emitter: emit to the Tauri frontend.
pub fn tauri_emitter(app: AppHandle) -> EmitFn {
    Arc::new(move |evt: ActivityEvent| {
        // Best-effort; closed window means we drop the event.
        let _ = app.emit("activity", evt);
    })
}

/// MCP-mode emitter: write JSON line to the UI's unix socket (best effort).
/// We open a socket on first call and keep it warm; if the UI isn't running
/// we silently drop the event (POC behavior — see POC_NOTES).
pub fn mcp_emitter() -> EmitFn {
    let stream: Arc<Mutex<Option<UnixStream>>> = Arc::new(Mutex::new(None));
    let handle = tokio::runtime::Handle::try_current().ok();
    Arc::new(move |evt: ActivityEvent| {
        let Some(rt) = handle.clone() else { return };
        let stream = stream.clone();
        rt.spawn(async move {
            let mut guard = stream.lock().await;
            if guard.is_none() {
                let path = match activity_socket_path() {
                    Ok(p) => p,
                    Err(_) => return,
                };
                if let Ok(s) = UnixStream::connect(path).await {
                    *guard = Some(s);
                }
            }
            if let Some(s) = guard.as_mut() {
                let mut line = match serde_json::to_string(&evt) {
                    Ok(s) => s,
                    Err(_) => return,
                };
                line.push('\n');
                if s.write_all(line.as_bytes()).await.is_err() {
                    *guard = None;
                }
            }
        });
    })
}

/// UI side: listen on the unix socket for events from external processes
/// (the MCP subprocess) and forward them to the frontend. Uses Tauri's
/// async runtime (tokio under the hood) so this is safe to call from
/// `Builder::setup` where no plain tokio reactor is bound.
pub fn spawn_socket_listener(app: AppHandle) {
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
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stream).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Ok(evt) = serde_json::from_str::<ActivityEvent>(&line) {
                        let _ = app.emit("activity", evt);
                    }
                }
            });
        }
    });
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
