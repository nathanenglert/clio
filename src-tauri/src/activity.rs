//! Activity emission.
//!
//! `core::*` functions call `record`/`record_with_payload` once per tool
//! invocation to push an `ActivityEvent` to the frontend. Both the human
//! (UI) and agent (proxied MCP) paths run in the UI process now, so there is
//! exactly one emitter — the Tauri frontend. The Unix-socket bridge that used
//! to carry MCP events lives in `bridge.rs`.

use std::sync::Arc;

use anyhow::Result;
use tauri::{AppHandle, Emitter as _};

use crate::types::ActivityEvent;

/// Erased emitter handed to every `Core`.
pub type EmitFn = Arc<dyn Fn(ActivityEvent) + Send + Sync>;

/// Emit to the Tauri frontend. Best-effort; a closed window drops the event.
pub fn tauri_emitter(app: AppHandle) -> EmitFn {
    Arc::new(move |evt: ActivityEvent| {
        let _ = app.emit("activity", evt);
    })
}

/// Emit an activity event. Call once per tool invocation in core fns.
/// On error, the anyhow error chain is appended to `detail` so the activity
/// strip shows the actual failure reason, not just "error".
pub fn record<T>(
    emit: &EmitFn,
    source: &str,
    agent_id: Option<&str>,
    tool: &str,
    detail: impl Into<String>,
    started: std::time::Instant,
    result: &Result<T>,
) {
    record_with_payload(emit, source, agent_id, tool, detail, None, started, result);
}

/// Like [`record`], but also attaches a full-fidelity `payload` (e.g. the
/// un-truncated SQL for `run_query`).
#[allow(clippy::too_many_arguments)]
pub fn record_with_payload<T>(
    emit: &EmitFn,
    source: &str,
    agent_id: Option<&str>,
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
    emit(
        ActivityEvent::new(source, tool, detail, status, elapsed)
            .with_payload(payload)
            .with_agent(agent_id.map(String::from)),
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::time::Instant;

    #[test]
    fn record_tags_agent_and_status() {
        let captured: Arc<Mutex<Vec<ActivityEvent>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = captured.clone();
        let emit: EmitFn = Arc::new(move |e| sink.lock().unwrap().push(e));

        let ok: Result<()> = Ok(());
        record(&emit, "mcp", Some("agent-1"), "run_query", "select 1", Instant::now(), &ok);

        let err: Result<()> = Err(anyhow::anyhow!("boom"));
        record(&emit, "ui", None, "run_query", "select 2", Instant::now(), &err);

        let evts = captured.lock().unwrap();
        assert_eq!(evts[0].agent_id.as_deref(), Some("agent-1"));
        assert_eq!(evts[0].status, "ok");
        assert_eq!(evts[1].agent_id, None);
        assert_eq!(evts[1].status, "error");
        assert!(evts[1].detail.contains("boom"));
    }
}
