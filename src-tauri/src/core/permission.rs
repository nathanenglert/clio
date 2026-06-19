//! Pending-permission registry.
//!
//! When `execute_statement` evaluates a statement and the policy says
//! `Prompt`, the call registers a oneshot here, emits a `permission_required`
//! activity event with the request payload, and awaits on the receiver. The
//! UI's `resolve_permission` Tauri command sends the verdict in.
//!
//! The registry is shared via `Core::pending_permissions` so the same handle
//! is reachable from both the MCP tool entrypoint and the Tauri command.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{oneshot, Mutex};

use serde::{Deserialize, Serialize};

use super::policy::Target;

/// Payload pushed over the activity stream when a statement needs human
/// approval. Fields are flat strings so the frontend can render without
/// knowing about the Rust types.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub id: String,
    pub source: String,
    /// Which agent raised this request (proxied-MCP path). `None` for UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    pub sql: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    /// Lowercased op category: `read | write | ddl | destruct`.
    pub op_kind: String,
    /// Lowercased statement kind: `select | update | drop_table | …`.
    pub stmt_kind: String,
    pub targets: Vec<Target>,
    /// Label of the policy rule that fired (empty for the no-match fallback).
    pub rule_label: String,
    /// Human-readable reason for the prompt, surfaced on the card.
    pub reason: String,
    /// Best-effort row estimate from `EXPLAIN`. `None` when EXPLAIN failed
    /// (e.g. DDL) or wasn't applicable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub row_estimate: Option<u64>,
}

/// Verdict the UI sends back via `resolve_permission`. Serialized over the
/// bidirectional socket bridge (Phase 3), so we need both directions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum PermissionVerdict {
    Allow,
    Deny,
    /// User edited the SQL before approving. The new SQL runs instead of the
    /// agent's original. Phase 2 trusts the modified SQL as-is; re-running
    /// policy on it is a Phase 3+ decision.
    Modified { sql: String },
}

// ── Migration (bulk multi-statement) ─────────────────────────────
//
// Phase 4 (design/README.md §"Bulk migration permission"). The agent calls
// `execute_migration` with N statements; the backend classifies each, emits
// a `migration_required` event with the full plan, and waits for the bulk
// verdict. Approval then runs all in-policy statements automatically and
// pauses on each deviation (which uses the existing single-statement
// PermissionVerdict path).

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationRequest {
    pub id: String,
    pub source: String,
    /// Which agent raised this request (proxied-MCP path). `None` for UI.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub intent: Option<String>,
    pub statements: Vec<MigrationStatement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationStatement {
    pub index: usize,
    pub sql: String,
    pub stmt_kind: String,
    pub op_kind: String,
    pub targets: Vec<Target>,
    /// `"allow" | "prompt" | "block"`
    pub verdict: String,
    pub rule_label: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum MigrationVerdict {
    /// Approve all in-policy statements. Each deviation will pause and ask
    /// via the standard single-statement permission card during execution.
    /// `wrap_in_transaction` wraps the whole batch in BEGIN/COMMIT so any
    /// single denial / runtime error rolls back everything.
    ApproveAndPrompt { wrap_in_transaction: bool },
    /// Reject the whole batch — no statement runs.
    Reject,
}

#[derive(Default, Clone)]
pub struct PendingMigrations {
    inner: Arc<Mutex<HashMap<String, oneshot::Sender<MigrationVerdict>>>>,
}

impl PendingMigrations {
    pub async fn register(&self) -> (String, oneshot::Receiver<MigrationVerdict>) {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.inner.lock().await.insert(id.clone(), tx);
        (id, rx)
    }

    pub async fn resolve(&self, id: &str, verdict: MigrationVerdict) -> Result<(), String> {
        let tx = self
            .inner
            .lock()
            .await
            .remove(id)
            .ok_or_else(|| format!("no pending migration with id {id}"))?;
        tx.send(verdict)
            .map_err(|_| "migration requester is gone".to_string())?;
        Ok(())
    }

    #[allow(dead_code)]
    pub async fn cancel(&self, id: &str) {
        let _ = self.inner.lock().await.remove(id);
    }
}

// ── Connect approval ─────────────────────────────────────────────
//
// An agent may not open a database connection — a human must initiate it. The
// agent's `connect` tool, when the database isn't already open, surfaces a
// `connect_required` card; on approval the *human* core opens the pool and the
// agent's call unblocks. See design/mcp-connection-authority.md §3 and
// `lifecycle::request_connect`.

/// Payload pushed on the activity stream for a connect-approval card.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectRequest {
    pub id: String,
    /// Saved-connection name the agent wants opened.
    pub connection: String,
    /// Which agent is asking. Resolves to a label via the presence roster.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<String>,
}

/// `request_id → (connection_name, sender)`. The connection name is held here
/// (not just on the wire) so `resolve_connect` knows what to open on approval.
#[derive(Default, Clone)]
pub struct PendingConnects {
    inner: Arc<Mutex<HashMap<String, (String, oneshot::Sender<bool>)>>>,
}

impl PendingConnects {
    pub async fn register(&self, connection: String) -> (String, oneshot::Receiver<bool>) {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.inner.lock().await.insert(id.clone(), (connection, tx));
        (id, rx)
    }

    /// Remove and return a pending connect request by id (the connection name
    /// + its sender), or `None` if unknown.
    pub async fn take(&self, id: &str) -> Option<(String, oneshot::Sender<bool>)> {
        self.inner.lock().await.remove(id)
    }
}

/// In-memory map of `request_id → oneshot::Sender`. Default `Clone`
/// shares the same backing map so the UI command and the MCP tool see the
/// same pending list.
#[derive(Default, Clone)]
pub struct PendingPermissions {
    inner: Arc<Mutex<HashMap<String, oneshot::Sender<PermissionVerdict>>>>,
}

impl PendingPermissions {
    /// Register a pending request and get back its id + the receiver to
    /// await on. Caller is responsible for emitting the activity event with
    /// the id so the UI can reference it on resolve.
    pub async fn register(&self) -> (String, oneshot::Receiver<PermissionVerdict>) {
        let id = uuid::Uuid::new_v4().to_string();
        let (tx, rx) = oneshot::channel();
        self.inner.lock().await.insert(id.clone(), tx);
        (id, rx)
    }

    /// Deliver a verdict for a previously-registered id. Errors if the id
    /// is unknown (already resolved or never existed) or if the requester
    /// dropped its receiver before we could send.
    pub async fn resolve(&self, id: &str, verdict: PermissionVerdict) -> Result<(), String> {
        let tx = self
            .inner
            .lock()
            .await
            .remove(id)
            .ok_or_else(|| format!("no pending permission with id {id}"))?;
        tx.send(verdict)
            .map_err(|_| "permission requester is gone".to_string())?;
        Ok(())
    }

    /// Drop a request without resolving it (e.g. requester disconnected).
    /// Safe to call with an unknown id — no-op in that case.
    #[allow(dead_code)]
    pub async fn cancel(&self, id: &str) {
        let _ = self.inner.lock().await.remove(id);
    }

    /// How many requests are currently outstanding. Useful for the status
    /// bar's "N pending" indicator in Phase 3+; cheap so we expose it now.
    #[allow(dead_code)]
    pub async fn len(&self) -> usize {
        self.inner.lock().await.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn register_then_resolve_delivers_verdict() {
        let pending = PendingPermissions::default();
        let (id, rx) = pending.register().await;
        let p2 = pending.clone();
        let id2 = id.clone();
        tokio::spawn(async move {
            p2.resolve(&id2, PermissionVerdict::Allow).await.unwrap();
        });
        match rx.await.unwrap() {
            PermissionVerdict::Allow => {}
            v => panic!("expected Allow, got {v:?}"),
        }
    }

    #[tokio::test]
    async fn resolve_modified_carries_sql() {
        let pending = PendingPermissions::default();
        let (id, rx) = pending.register().await;
        pending
            .resolve(
                &id,
                PermissionVerdict::Modified {
                    sql: "SELECT 1".into(),
                },
            )
            .await
            .unwrap();
        match rx.await.unwrap() {
            PermissionVerdict::Modified { sql } => assert_eq!(sql, "SELECT 1"),
            v => panic!("expected Modified, got {v:?}"),
        }
    }

    #[tokio::test]
    async fn resolve_unknown_id_errors() {
        let pending = PendingPermissions::default();
        let err = pending
            .resolve("not-a-real-id", PermissionVerdict::Allow)
            .await
            .unwrap_err();
        assert!(err.contains("not-a-real-id"));
    }

    #[tokio::test]
    async fn double_resolve_errors() {
        let pending = PendingPermissions::default();
        let (id, _rx) = pending.register().await;
        pending
            .resolve(&id, PermissionVerdict::Allow)
            .await
            .unwrap();
        assert!(pending
            .resolve(&id, PermissionVerdict::Allow)
            .await
            .is_err());
    }

    #[tokio::test]
    async fn cancel_removes_request() {
        let pending = PendingPermissions::default();
        let (id, _rx) = pending.register().await;
        assert_eq!(pending.len().await, 1);
        pending.cancel(&id).await;
        assert_eq!(pending.len().await, 0);
    }

    #[tokio::test]
    async fn deny_dropped_receiver_errors_on_send() {
        let pending = PendingPermissions::default();
        let (id, rx) = pending.register().await;
        drop(rx);
        let err = pending
            .resolve(&id, PermissionVerdict::Allow)
            .await
            .unwrap_err();
        assert!(err.contains("requester is gone"));
    }

    #[tokio::test]
    async fn migration_register_resolve() {
        let pending = PendingMigrations::default();
        let (id, rx) = pending.register().await;
        let p2 = pending.clone();
        let id2 = id.clone();
        tokio::spawn(async move {
            p2.resolve(
                &id2,
                MigrationVerdict::ApproveAndPrompt {
                    wrap_in_transaction: true,
                },
            )
            .await
            .unwrap();
        });
        match rx.await.unwrap() {
            MigrationVerdict::ApproveAndPrompt {
                wrap_in_transaction,
            } => assert!(wrap_in_transaction),
            v => panic!("expected ApproveAndPrompt, got {v:?}"),
        }
    }

    #[tokio::test]
    async fn migration_resolve_unknown_errors() {
        let pending = PendingMigrations::default();
        let err = pending
            .resolve("nope", MigrationVerdict::Reject)
            .await
            .unwrap_err();
        assert!(err.contains("nope"));
    }
}
