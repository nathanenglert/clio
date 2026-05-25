//! `execute_statement` — the gated runner that the agent calls via MCP.
//!
//! Pipeline (see design/README.md §"Permission gates"):
//!   1. Parse SQL (must be exactly one statement).
//!   2. Best-effort `EXPLAIN` for a row estimate (for the ≤1000-row rule).
//!   3. Evaluate the current policy.
//!   4. Allow ➜ run and return rows. Block ➜ return error.
//!      Prompt ➜ register a oneshot, emit `permission_required` on the
//!      activity stream, await the verdict, then run / deny / run-modified.
//!   5. Record the outcome on the activity strip.
//!
//! Phase 2 limitation: the resolve path only fires when the MCP server runs
//! **in the same process as the UI**. When the MCP runs as a stdio
//! subprocess (the production setup), the activity socket is one-way and
//! the prompt path will hang. Phase 3 lands the bidirectional bridge.

use anyhow::{anyhow, Result};
use sqlx::Row as _;
use std::time::Instant;

use crate::types::{ActivityEvent, QueryResult};

use super::permission::{PermissionRequest, PermissionVerdict};
use super::policy::{self, OpKind, StmtKind, Verdict};
use super::query::{cap_payload, run_decoded};
use super::Core;

pub async fn execute_statement(
    core: &Core,
    conn: &str,
    sql: &str,
    intent: Option<&str>,
) -> Result<QueryResult> {
    let started = Instant::now();
    let r = run_with_gate(core, conn, sql, intent).await;

    let mut detail = sql.replace('\n', " ");
    if detail.len() > 80 {
        detail.truncate(77);
        detail.push_str("...");
    }
    let payload = Some(cap_payload(sql));
    core.record_ok_with_payload("execute_statement", detail, payload, started, &r);
    r
}

async fn run_with_gate(
    core: &Core,
    conn: &str,
    sql: &str,
    intent: Option<&str>,
) -> Result<QueryResult> {
    // 1. Parse — must be exactly one statement. Use `execute_migration`
    // (Phase 4) for multi-statement plans.
    let stmts = policy::parse_sql(sql).map_err(|e| anyhow!(e))?;
    if stmts.len() != 1 {
        return Err(anyhow!(
            "execute_statement requires exactly one statement; got {}",
            stmts.len()
        ));
    }
    let stmt = stmts.into_iter().next().unwrap();

    // 2. Open the pool early — needed for EXPLAIN below and for running
    //    whatever statement comes out the other side of the gate.
    let pool = core.pools.ensure(&core.meta, conn).await?;

    // 3. Row estimate via EXPLAIN — only meaningful for data writes. DDL
    //    rejects EXPLAIN; reads don't trigger row-bounded rules; TRUNCATE
    //    isn't planner-estimable in a useful way. Best-effort — failure
    //    just leaves the estimate as `None`.
    let estimate = match stmt.kind.op_kind() {
        OpKind::Write => estimate_rows(&pool, sql).await,
        OpKind::Destruct if !matches!(stmt.kind, StmtKind::Truncate) => {
            estimate_rows(&pool, sql).await
        }
        _ => None,
    };

    // 4. Evaluate policy. Phase 2 uses the hardcoded default ruleset; Phase 5
    //    will look up per-connection rules + active session overrides.
    let rules = policy::default_rules();
    let verdict = policy::evaluate(&rules, &stmt, estimate);

    // 5. Branch on verdict.
    let final_sql: String = match verdict {
        Verdict::Allow { rule } => {
            tracing::debug!(rule = %rule, "execute_statement: allowed by policy");
            sql.to_string()
        }
        Verdict::Block { rule, reason } => {
            return Err(anyhow!("blocked by policy '{rule}': {reason}"));
        }
        Verdict::Prompt { rule, reason } => {
            let (id, rx) = core.pending_permissions.register().await;
            let request = PermissionRequest {
                id: id.clone(),
                source: core.source.clone(),
                sql: sql.to_string(),
                intent: intent.map(String::from),
                op_kind: op_kind_str(stmt.kind.op_kind()).into(),
                stmt_kind: stmt_kind_str(stmt.kind).into(),
                targets: stmt.targets.clone(),
                rule_label: rule,
                reason: reason.clone(),
                row_estimate: estimate,
            };
            emit_permission_required(core, &request);

            let v = rx
                .await
                .map_err(|_| anyhow!("permission request was cancelled before resolve"))?;
            match v {
                PermissionVerdict::Allow => sql.to_string(),
                PermissionVerdict::Deny => {
                    return Err(anyhow!(
                        "permission denied by user (policy: '{}')",
                        request.rule_label
                    ));
                }
                PermissionVerdict::Modified { sql: new_sql } => new_sql,
            }
        }
    };

    // 6. Run the (possibly-modified) SQL. `reveal=false` — the MCP path
    //    never reveals sensitive data; see design/redaction.md §"MCP scope".
    run_decoded(core, conn, &final_sql, /* reveal */ false).await
}

/// Run `EXPLAIN (FORMAT JSON) <sql>` and pull the planner's row estimate
/// out of the first plan node. Returns `None` on any failure — DDL gets
/// rejected by EXPLAIN, INSERT VALUES often returns 0 (which is fine and
/// matches what the planner thinks).
async fn estimate_rows(pool: &sqlx::PgPool, sql: &str) -> Option<u64> {
    let explained = format!("EXPLAIN (FORMAT JSON) {sql}");
    let row = sqlx::query(&explained).fetch_one(pool).await.ok()?;
    let plan: serde_json::Value = row.try_get(0).ok()?;
    plan.as_array()?
        .first()?
        .get("Plan")?
        .get("Plan Rows")?
        .as_f64()
        .map(|n| n.round().max(0.0) as u64)
}

fn emit_permission_required(core: &Core, req: &PermissionRequest) {
    let detail = if req.reason.is_empty() {
        "permission required".to_string()
    } else {
        format!("permission required: {}", req.reason)
    };
    let payload = serde_json::to_string(req).ok();
    let evt = ActivityEvent::new(
        &core.source,
        "permission_required",
        detail,
        "pending",
        /* duration_ms */ 0,
    )
    .with_payload(payload);
    (core.emit)(evt);
}

fn op_kind_str(k: OpKind) -> &'static str {
    match k {
        OpKind::Read => "read",
        OpKind::Write => "write",
        OpKind::Ddl => "ddl",
        OpKind::Destruct => "destruct",
    }
}

fn stmt_kind_str(k: StmtKind) -> &'static str {
    match k {
        StmtKind::Select => "select",
        StmtKind::Insert => "insert",
        StmtKind::Update => "update",
        StmtKind::Delete => "delete",
        StmtKind::Truncate => "truncate",
        StmtKind::DropTable => "drop_table",
        StmtKind::DropSchema => "drop_schema",
        StmtKind::DropOther => "drop_other",
        StmtKind::CreateTable => "create_table",
        StmtKind::CreateSchema => "create_schema",
        StmtKind::CreateIndex => "create_index",
        StmtKind::CreateView => "create_view",
        StmtKind::CreateOther => "create_other",
        StmtKind::AlterTable => "alter_table",
        StmtKind::AlterOther => "alter_other",
        StmtKind::Other => "other",
    }
}
