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

use anyhow::{anyhow, Context, Result};
use sqlx::Row as _;
use std::time::Instant;

use crate::types::{ActivityEvent, QueryResult};

use super::permission::{
    MigrationRequest, MigrationStatement, MigrationVerdict, PermissionRequest, PermissionVerdict,
};
use super::lineage;
use super::policy::{self, OpKind, StmtInfo, StmtKind, Verdict};
use super::query::{cap_payload, reject_untraceable, run_decoded, sanitize_db_error};
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
    let pool = core.pool(conn).await?;

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

    let view = {
        let connection = crate::connections::get(&core.meta, conn).await?;
        core.redactor_cache
            .view_for(&core.meta, &pool, conn, &connection.id)
            .await?
    };
    // Refuse untraceable SQL before asking the human anything: `run_decoded`
    // would refuse it after their approval anyway.
    reject_untraceable(core, view.is_some(), sql)?;

    // A write that touches a classified table can copy classified values
    // somewhere unredacted — into an unclassified column or table, or back out
    // through RETURNING — so it never rides a row-bounded allow rule.
    let verdict = match verdict {
        Verdict::Allow { .. } if stmt.kind.op_kind() != OpKind::Read => {
            match &view {
                Some(v) if lineage::references_classified_table(sql, v) => Verdict::Prompt {
                    rule: "Write touching classified data — prompt".into(),
                    reason: "This write reads or modifies a table with classified \
                             (PHI/PCI/PII) columns, so it could copy their values somewhere \
                             unredacted"
                        .into(),
                },
                _ => verdict,
            }
        }
        v => v,
    };

    // 5. Branch on verdict. A read that runs with no human approval runs in a
    //    read-only transaction, so a write the classifier missed still fails.
    let mut read_only = false;
    let final_sql: String = match verdict {
        Verdict::Allow { rule } => {
            tracing::debug!(rule = %rule, "execute_statement: allowed by policy");
            read_only = stmt.kind.op_kind() == OpKind::Read;
            sql.to_string()
        }
        Verdict::Block { rule, reason } => {
            return Err(anyhow!("blocked by policy '{rule}': {reason}"));
        }
        Verdict::Prompt { rule, reason } => {
            let (id, rx) = core.pending_permissions.register(core.agent_id.clone()).await;
            let request = PermissionRequest {
                id: id.clone(),
                source: core.source.clone(),
                agent_id: core.agent_id.clone(),
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
                PermissionVerdict::Modified { sql: new_sql } => {
                    // The human may have rewritten the statement entirely — a
                    // benign Prompt card edited into a DROP, say. Re-evaluate
                    // the edit against the same policy before it runs; a Block
                    // verdict here is the human editing past a hard gate, and
                    // must be refused. See `regate_modified`.
                    regate_modified(&rules, &new_sql)?;
                    new_sql
                }
            }
        }
    };

    // 6. Run the (possibly-modified) SQL. `reveal=false` — the MCP path
    //    never reveals sensitive data; see design/redaction.md §"MCP scope".
    run_decoded(core, conn, &final_sql, /* reveal */ false, read_only).await
}

/// Run `EXPLAIN (FORMAT JSON) <sql>` and pull the planner's estimate of the
/// rows the statement writes (see [`plan_rows`]). Returns `None` on any
/// failure — DDL gets rejected by EXPLAIN.
async fn estimate_rows(pool: &sqlx::PgPool, sql: &str) -> Option<u64> {
    let explained = format!("EXPLAIN (FORMAT JSON) {sql}");
    let row = sqlx::query(&explained).fetch_one(pool).await.ok()?;
    let plan: serde_json::Value = row.try_get(0).ok()?;
    plan_rows(&plan)
}

/// Rows a write will touch, from `EXPLAIN (FORMAT JSON)` output. A
/// `ModifyTable` node reports 0 `Plan Rows` (it returns nothing without
/// RETURNING); the rows it modifies are its input's — the `Outer` child. Sums
/// that across every `ModifyTable` in the tree, so a data-modifying CTE under
/// a `SELECT count(*)` counts too. A plan with no `ModifyTable` falls back to
/// the top node's estimate.
fn plan_rows(explained: &serde_json::Value) -> Option<u64> {
    use serde_json::Value;
    fn modified_rows(node: &Value, out: &mut Vec<f64>) {
        let children: &[Value] = node
            .get("Plans")
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if node.get("Node Type").and_then(Value::as_str) == Some("ModifyTable") {
            let input = children
                .iter()
                .find(|c| c.get("Parent Relationship").and_then(Value::as_str) == Some("Outer"))
                .or(children.first());
            out.push(input.and_then(|c| c.get("Plan Rows")).and_then(Value::as_f64).unwrap_or(0.0));
        }
        for c in children {
            modified_rows(c, out);
        }
    }
    let top = explained.as_array()?.first()?.get("Plan")?;
    let mut writes = Vec::new();
    modified_rows(top, &mut writes);
    let rows = if writes.is_empty() {
        top.get("Plan Rows")?.as_f64()?
    } else {
        writes.iter().sum()
    };
    Some(rows.round().max(0.0) as u64)
}

/// Re-evaluate human-edited SQL before it runs. When a user approves a Prompt
/// card with a modification, the new SQL must clear the same policy a fresh
/// statement would — otherwise the gate is trivially bypassed by editing an
/// allowed-looking statement into a destructive one. A `Block` verdict is
/// refused; `Allow`/`Prompt` are the human's explicit, in-policy choice and
/// run. Multi-statement or unparseable edits are rejected outright so a single
/// approval can't smuggle extra statements.
///
/// No row estimate is supplied: no `Block` rule depends on one (they relax the
/// row-bounded `Allow` rules, never escalate to `Block`), and re-running
/// `EXPLAIN` here would add a round-trip for no security gain.
fn regate_modified(rules: &[policy::Rule], new_sql: &str) -> Result<()> {
    let stmts = policy::parse_sql(new_sql)
        .map_err(|e| anyhow!("modified SQL did not parse: {e}"))?;
    if stmts.len() != 1 {
        return Err(anyhow!(
            "modified SQL must be exactly one statement; got {}",
            stmts.len()
        ));
    }
    match policy::evaluate(rules, &stmts[0], None) {
        Verdict::Block { rule, reason } => Err(anyhow!(
            "modified SQL blocked by policy '{rule}': {reason}"
        )),
        Verdict::Allow { .. } | Verdict::Prompt { .. } => Ok(()),
    }
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
    .with_payload(payload)
    .with_agent(core.agent_id.clone());
    (core.emit)(evt);
}

/// Bulk-migration runner. Parses every statement, classifies each against
/// the policy, surfaces the full plan to the UI via `migration_required`,
/// and waits for a bulk verdict. On `ApproveAndPrompt`, it resolves every
/// deviation to a final statement *first* — each via the standard
/// single-statement permission card — and only then runs the fully-approved
/// plan. Collecting all verdicts before touching the database means a denial
/// (or a rejected edit) aborts before any statement has run, so the batch is
/// never left half-applied, and no transaction or lock is ever held open
/// while a human deliberates.
///
/// `wrap_in_transaction` additionally wraps the run in BEGIN/COMMIT so a
/// *runtime* error rolls back the statements that did run.
///
/// Returns a vector of QueryResult — one per statement that ran. If a
/// deviation is denied or its edit fails re-gating, returns Err and nothing
/// has run.
pub async fn execute_migration(
    core: &Core,
    conn: &str,
    statements: Vec<String>,
    intent: Option<&str>,
) -> Result<Vec<QueryResult>> {
    let started = Instant::now();
    let r = run_migration_with_gate(core, conn, statements, intent).await;

    let detail = match &r {
        Ok(v) => format!("migration ran {} statement(s)", v.len()),
        Err(e) => format!("migration failed: {e}"),
    };
    core.record_ok("execute_migration", detail, started, &r);
    r
}

async fn run_migration_with_gate(
    core: &Core,
    conn: &str,
    statements: Vec<String>,
    intent: Option<&str>,
) -> Result<Vec<QueryResult>> {
    if statements.is_empty() {
        return Err(anyhow!("execute_migration requires at least one statement"));
    }

    // Parse + classify each. Each input string must be a single statement;
    // we reject multi-statement inputs to keep the per-row UI honest.
    let rules = policy::default_rules();
    let mut parsed: Vec<StmtInfo> = Vec::with_capacity(statements.len());
    let mut classified: Vec<MigrationStatement> = Vec::with_capacity(statements.len());
    for (idx, sql) in statements.iter().enumerate() {
        let stmts = policy::parse_sql(sql).map_err(|e| anyhow!("stmt {idx}: {e}"))?;
        if stmts.len() != 1 {
            return Err(anyhow!(
                "stmt {idx} must contain exactly one statement; got {}",
                stmts.len()
            ));
        }
        let info = stmts.into_iter().next().unwrap();
        // No EXPLAIN here — we'd need the pool open for each statement and
        // EXPLAIN fails for DDL (the bulk of migrations). The single-stmt
        // path picks up row estimates when a deviation pauses for prompt.
        let verdict = policy::evaluate(&rules, &info, /* estimate */ None);
        let (vstr, rule, reason) = match &verdict {
            Verdict::Allow { rule } => ("allow", rule.clone(), String::new()),
            Verdict::Prompt { rule, reason } => ("prompt", rule.clone(), reason.clone()),
            Verdict::Block { rule, reason } => ("block", rule.clone(), reason.clone()),
        };
        classified.push(MigrationStatement {
            index: idx,
            sql: sql.clone(),
            stmt_kind: stmt_kind_str(info.kind).into(),
            op_kind: op_kind_str(info.kind.op_kind()).into(),
            targets: info.targets.clone(),
            verdict: vstr.into(),
            rule_label: rule,
            reason,
        });
        parsed.push(info);
    }

    // Hard-stop on any Block — the UI surfaces the plan but won't even
    // offer to run it once a statement is blocked outright.
    let any_blocked = classified.iter().any(|s| s.verdict == "block");

    // Register the bulk verdict slot, emit the plan, await.
    let (id, rx) = core.pending_migrations.register(core.agent_id.clone()).await;
    let request = MigrationRequest {
        id: id.clone(),
        source: core.source.clone(),
        agent_id: core.agent_id.clone(),
        intent: intent.map(String::from),
        statements: classified.clone(),
    };
    emit_migration_required(core, &request);

    let bulk_verdict = rx
        .await
        .map_err(|_| anyhow!("migration request was cancelled before resolve"))?;
    let wrap_in_tx = match bulk_verdict {
        MigrationVerdict::Reject => {
            return Err(anyhow!("migration rejected by user"));
        }
        MigrationVerdict::ApproveAndPrompt {
            wrap_in_transaction,
        } => {
            if any_blocked {
                return Err(anyhow!(
                    "migration includes blocked statements; cannot proceed"
                ));
            }
            wrap_in_transaction
        }
    };

    // Acquire the pool up front (just an Arc clone — holds no locks) so we
    // fail fast if the connection is gone. The transaction is NOT opened yet:
    // we resolve every verdict first.
    let pool = core.pool(conn).await?;

    // ── Phase A: resolve every statement to its final SQL, before any DB
    // work. A deviation pauses for the standard single-statement card. A Deny
    // — or a Modified edit that fails re-gating — aborts here, when nothing
    // has run and no transaction is open. This is what keeps a denied batch
    // from being left half-applied and a transaction from being held open
    // across a human prompt.
    let mut final_sqls: Vec<String> = Vec::with_capacity(statements.len());
    for (idx, stmt) in parsed.iter().enumerate() {
        let original_sql = &statements[idx];
        let stmt_verdict = &classified[idx];

        let final_sql: String = if stmt_verdict.verdict == "allow" {
            original_sql.clone()
        } else {
            let (rid, rx) = core.pending_permissions.register(core.agent_id.clone()).await;
            let req = PermissionRequest {
                id: rid.clone(),
                source: core.source.clone(),
                agent_id: core.agent_id.clone(),
                sql: original_sql.clone(),
                intent: intent.map(String::from),
                op_kind: stmt_verdict.op_kind.clone(),
                stmt_kind: stmt_verdict.stmt_kind.clone(),
                targets: stmt.targets.clone(),
                rule_label: stmt_verdict.rule_label.clone(),
                reason: stmt_verdict.reason.clone(),
                row_estimate: None,
            };
            emit_permission_required(core, &req);

            let v = rx
                .await
                .map_err(|_| anyhow!("permission request was cancelled before resolve"))?;
            match v {
                PermissionVerdict::Allow => original_sql.clone(),
                PermissionVerdict::Deny => {
                    return Err(anyhow!("migration aborted: stmt {idx} denied by user"));
                }
                PermissionVerdict::Modified { sql: new_sql } => {
                    // Same re-gate as the single-statement path: a human edit
                    // must clear the policy before it joins the plan.
                    regate_modified(&rules, &new_sql)?;
                    new_sql
                }
            }
        };
        final_sqls.push(final_sql);
    }

    // Whether this connection redacts — governs error-message sanitization for
    // the statements about to run. A failed write can echo real classified
    // values in its DB error (e.g. a unique-violation `Key (email)=(real@x.com)
    // already exists`); on the agent path that must not cross the bridge.
    let classified = {
        let connection = crate::connections::get(&core.meta, conn).await?;
        core.redactor_cache
            .view_for(&core.meta, &pool, conn, &connection.id)
            .await?
            .is_some()
    };

    // ── Phase B: the plan is fully approved — now run it. Only here do we
    // (optionally) BEGIN, so locks live only for the duration of execution.
    let mut tx_opt = if wrap_in_tx {
        Some(pool.begin().await.context("begin migration transaction")?)
    } else {
        None
    };

    let mut results: Vec<QueryResult> = Vec::with_capacity(final_sqls.len());
    for (idx, final_sql) in final_sqls.iter().enumerate() {
        // Inside a transaction we go straight through sqlx — no redaction
        // lookup, no pool round-trip — since redaction applies to query
        // *output*, and migrations rarely return rows.
        let exec_started = Instant::now();
        let run = match tx_opt.as_mut() {
            Some(tx) => sqlx::query(final_sql).execute(&mut **tx).await,
            None => sqlx::query(final_sql).execute(&pool).await,
        };
        run.map(|_| ())
            .map_err(|e| sanitize_db_error(core, classified, e))
            .with_context(|| format!("stmt {idx} failed"))?;
        results.push(QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            row_count: 0,
            truncated: false,
            elapsed_ms: exec_started.elapsed().as_millis() as u64,
            redaction_meta: None,
        });
    }

    if let Some(tx) = tx_opt {
        tx.commit().await.context("commit migration transaction")?;
    }

    Ok(results)
}

fn emit_migration_required(core: &Core, req: &MigrationRequest) {
    let detail = format!("migration · {} statement(s)", req.statements.len());
    let payload = serde_json::to_string(req).ok();
    let evt = ActivityEvent::new(
        &core.source,
        "migration_required",
        detail,
        "pending",
        0,
    )
    .with_payload(payload)
    .with_agent(core.agent_id.clone());
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

// ─────────────────────────────────────────────────────────────────────────
// Integration tests for the gated runner.
//
// These drive `execute_statement` / `execute_migration` end-to-end against a
// real Postgres — the in-repo dev database (see `dev/db.sh`). Each test runs
// in a throwaway schema and skips (does not fail) when the DB is unreachable,
// so `cargo test` stays green on a box without it.
//
//   TEST_DATABASE_URL  overrides the target (default: the dev DB on :5433).
//   Start the DB with `dev/db.sh up`.
// ─────────────────────────────────────────────────────────────────────────
#[cfg(test)]
mod tests {
    use super::*;
    use crate::activity::EmitFn;
    use crate::connections;
    use crate::core::permission::{MigrationVerdict, PermissionVerdict};
    use crate::core::policy;
    use crate::core::Core;
    use crate::pool::PoolRegistry;
    use crate::types::{ActivityEvent, Category, ClassificationStatus, NewConnectionInput};
    use sqlx::postgres::PgPoolOptions;
    use sqlx::PgPool;
    use std::sync::Arc;
    use std::time::Duration;
    use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

    const TEST_CONN: &str = "testdb";

    fn test_db_url() -> String {
        std::env::var("TEST_DATABASE_URL")
            .unwrap_or_else(|_| "postgres://workbench:workbench@localhost:5433/workbench".into())
    }

    /// A `Core` wired to the live test DB, plus the captured activity stream
    /// and a private throwaway schema for the test to mutate.
    struct Harness {
        core: Core,
        events: UnboundedReceiver<ActivityEvent>,
        pool: PgPool,
        schema: String,
    }

    /// Build a [`Harness`], or return `None` (and print a skip notice) when the
    /// test DB is unreachable. The Postgres pool is injected directly into the
    /// registry, so no secret-store or real connection record is needed; the
    /// in-memory metadata DB just carries the `testdb` row `run_decoded` reads.
    async fn setup() -> Option<Harness> {
        let pool = match PgPoolOptions::new()
            .max_connections(4)
            .acquire_timeout(Duration::from_secs(3))
            .connect(&test_db_url())
            .await
        {
            Ok(p) => p,
            Err(e) => {
                eprintln!(
                    "SKIP integration test: DB unreachable at {} ({e}). \
                     Start it with `dev/db.sh up` or set TEST_DATABASE_URL.",
                    test_db_url()
                );
                return None;
            }
        };

        let meta = connections::open_metadata_in_memory().await.unwrap();
        connections::insert(
            &meta,
            &NewConnectionInput {
                name: TEST_CONN.into(),
                host: "localhost".into(),
                port: 0,
                database: "workbench".into(),
                username: "workbench".into(),
                password: String::new(), // empty ⇒ never touches the secret store
                ssl_mode: "disable".into(),
            },
        )
        .await
        .unwrap();

        let pools = PoolRegistry::default();
        pools.insert_for_test(TEST_CONN, pool.clone(), true).await;

        let (tx, rx) = unbounded_channel();
        let emit: EmitFn = Arc::new(move |e| {
            let _ = tx.send(e);
        });

        // The agent core mirrors the production caller of the gated runner.
        let (_human, agent) = Core::ui_with_agent(meta, pools, emit);

        let schema = format!("it_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE SCHEMA {schema}"))
            .execute(&pool)
            .await
            .unwrap();

        Some(Harness {
            core: agent,
            events: rx,
            pool,
            schema,
        })
    }

    impl Harness {
        async fn drop_schema(&self) {
            let _ = sqlx::query(&format!("DROP SCHEMA IF EXISTS {} CASCADE", self.schema))
                .execute(&self.pool)
                .await;
        }

        /// Await the next activity event whose `tool` matches, and return the
        /// `id` from its JSON payload (a `PermissionRequest`/`MigrationRequest`).
        async fn next_request_id(&mut self, tool: &str) -> String {
            loop {
                let evt = tokio::time::timeout(Duration::from_secs(5), self.events.recv())
                    .await
                    .expect("timed out waiting for an activity event")
                    .expect("activity channel closed");
                if evt.tool == tool {
                    let payload = evt.payload.expect("permission event carries a payload");
                    let v: serde_json::Value = serde_json::from_str(&payload).unwrap();
                    return v["id"].as_str().unwrap().to_string();
                }
            }
        }

        async fn table_exists(&self, table: &str) -> bool {
            sqlx::query_scalar::<_, bool>("SELECT to_regclass($1) IS NOT NULL")
                .bind(format!("{}.{}", self.schema, table))
                .fetch_one(&self.pool)
                .await
                .unwrap()
        }

        /// Approve the next bulk migration card.
        async fn approve_migration(&mut self, wrap_in_transaction: bool) {
            let id = self.next_request_id("migration_required").await;
            self.core
                .pending_migrations
                .resolve(&id, MigrationVerdict::ApproveAndPrompt { wrap_in_transaction })
                .await
                .unwrap();
        }

        /// Resolve the next single-statement permission card.
        async fn resolve_next_permission(&mut self, verdict: PermissionVerdict) {
            let id = self.next_request_id("permission_required").await;
            self.core.pending_permissions.resolve(&id, verdict).await.unwrap();
        }
    }

    /// Smoke test: the harness can drive `execute_statement` end-to-end through
    /// the Allow branch against the live DB and get rows back. Proves the wiring
    /// (injected pool + in-memory meta + redactor short-circuit) before the
    /// behavioral fixes build on it.
    #[tokio::test]
    async fn allow_read_runs_against_test_db() {
        let Some(h) = setup().await else { return };
        let r = execute_statement(&h.core, TEST_CONN, "SELECT 1 AS one", None).await;
        h.drop_schema().await;
        let res = r.expect("an allowed SELECT should run");
        assert_eq!(res.row_count, 1, "SELECT 1 returns one row");
    }

    /// An allowed read runs in a read-only transaction: a SELECT that writes
    /// through a function (`nextval`) is refused by Postgres instead of running
    /// with no prompt. Same for the SELECT-only `run_query` tool.
    #[tokio::test]
    async fn allowed_reads_are_read_only() {
        let Some(h) = setup().await else { return };
        sqlx::query(&format!("CREATE SEQUENCE {}.s", h.schema))
            .execute(&h.pool)
            .await
            .unwrap();
        let sql = format!("SELECT nextval('{}.s')", h.schema);
        let via_gate = execute_statement(&h.core, TEST_CONN, &sql, None).await;
        let via_query = crate::core::run_query(&h.core, TEST_CONN, &sql, false).await;
        let last: Option<i64> =
            sqlx::query_scalar(&format!("SELECT last_value FROM {}.s WHERE is_called", h.schema))
                .fetch_optional(&h.pool)
                .await
                .unwrap();
        h.drop_schema().await;

        let e = format!("{:#}", via_gate.expect_err("execute_statement read must be read-only"));
        assert!(e.contains("read-only"), "expected a read-only error, got: {e}");
        let e = format!("{:#}", via_query.expect_err("run_query must be read-only"));
        assert!(e.contains("read-only"), "expected a read-only error, got: {e}");
        assert_eq!(last, None, "the sequence must never have advanced");
    }

    /// `SELECT … INTO` creates a table: `run_query` refuses it outright, and
    /// `execute_statement` sends it to the human instead of the Read allow rule.
    #[tokio::test]
    async fn select_into_is_not_a_read() {
        let Some(mut h) = setup().await else { return };
        let sql = format!("SELECT 1 AS n INTO TABLE {}.copied", h.schema);

        let q = crate::core::run_query(&h.core, TEST_CONN, &sql, false).await;
        let e = format!("{:#}", q.expect_err("run_query must refuse SELECT INTO"));
        assert!(e.contains("execute_statement"), "expected a pointer to the gate, got: {e}");

        let core = h.core.clone();
        let sql2 = sql.clone();
        let handle =
            tokio::spawn(async move { execute_statement(&core, TEST_CONN, &sql2, None).await });
        h.resolve_next_permission(PermissionVerdict::Deny).await;
        let r = handle.await.unwrap();
        let copied = h.table_exists("copied").await;
        h.drop_schema().await;

        r.expect_err("denied");
        assert!(!copied, "SELECT INTO must not run without approval");
    }

    /// The laundering hole: a small `INSERT … SELECT … RETURNING` into
    /// `public.*` used to auto-run under the ≤1000-row allow rule and hand the
    /// copied classified value straight back. It must prompt instead.
    #[tokio::test]
    async fn write_reading_classified_table_prompts() {
        let Some(mut h) = setup().await else { return };
        setup_classified_patients(&h).await;
        let table = format!("public.it_{}", uuid::Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE TABLE {table} (v text)"))
            .execute(&h.pool)
            .await
            .unwrap();

        let core = h.core.clone();
        let sql = format!(
            "INSERT INTO {table} (v) SELECT ssn FROM {}.patients RETURNING v",
            h.schema
        );
        let handle = tokio::spawn(async move { execute_statement(&core, TEST_CONN, &sql, None).await });
        let id = tokio::time::timeout(Duration::from_secs(5), h.next_request_id("permission_required")).await;
        if let Ok(id) = &id {
            h.core.pending_permissions.resolve(id, PermissionVerdict::Deny).await.unwrap();
        }
        let r = handle.await.unwrap();
        let copied: i64 = sqlx::query_scalar(&format!("SELECT count(*) FROM {table}"))
            .fetch_one(&h.pool)
            .await
            .unwrap();
        let _ = sqlx::query(&format!("DROP TABLE {table}")).execute(&h.pool).await;
        h.drop_schema().await;

        assert!(id.is_ok(), "a write reading a classified table must prompt");
        r.expect_err("denied");
        assert_eq!(copied, 0, "nothing may be copied without approval");
    }

    // ── Row estimate ─────────────────────────────────────────────────────

    /// Shapes captured from Postgres 16 `EXPLAIN (FORMAT JSON)`: the top
    /// `ModifyTable` of a plain write reports 0 rows, so the estimate must come
    /// from its input; a data-modifying CTE hides the write under a 1-row
    /// aggregate.
    #[test]
    fn plan_rows_reads_the_modify_table_input() {
        let update = serde_json::json!([{ "Plan": {
            "Node Type": "ModifyTable", "Plan Rows": 0,
            "Plans": [{ "Node Type": "Seq Scan", "Parent Relationship": "Outer", "Plan Rows": 100 }]
        }}]);
        assert_eq!(plan_rows(&update), Some(100));

        let insert_values = serde_json::json!([{ "Plan": {
            "Node Type": "ModifyTable", "Plan Rows": 0,
            "Plans": [{ "Node Type": "Result", "Parent Relationship": "Outer", "Plan Rows": 1 }]
        }}]);
        assert_eq!(plan_rows(&insert_values), Some(1));

        let cte_write = serde_json::json!([{ "Plan": {
            "Node Type": "Aggregate", "Plan Rows": 1,
            "Plans": [
                { "Node Type": "ModifyTable", "Parent Relationship": "InitPlan", "Plan Rows": 114,
                  "Plans": [{ "Node Type": "Seq Scan", "Parent Relationship": "Outer", "Plan Rows": 114 }] },
                { "Node Type": "CTE Scan", "Parent Relationship": "Outer", "Plan Rows": 114 }
            ]
        }}]);
        assert_eq!(plan_rows(&cte_write), Some(114));

        let select = serde_json::json!([{ "Plan": { "Node Type": "Seq Scan", "Plan Rows": 7 } }]);
        assert_eq!(plan_rows(&select), Some(7));
        assert_eq!(plan_rows(&serde_json::json!({})), None);
    }

    /// Live check of the same thing: a write touching more rows than the
    /// `public.*` allow rule's cap must prompt, not auto-run.
    #[tokio::test]
    async fn large_public_write_is_estimated_and_prompts() {
        let Some(mut h) = setup().await else { return };
        // `public` is the allow rule's schema, so the table has to live there.
        let table = format!("public.it_{}", uuid::Uuid::new_v4().simple());
        sqlx::raw_sql(&format!(
            "CREATE TABLE {table} (n int); INSERT INTO {table} SELECT generate_series(1, 2000); ANALYZE {table}"
        ))
        .execute(&h.pool)
        .await
        .unwrap();
        let est = estimate_rows(&h.pool, &format!("UPDATE {table} SET n = n")).await;

        let core = h.core.clone();
        let sql = format!("UPDATE {table} SET n = n");
        let handle = tokio::spawn(async move { execute_statement(&core, TEST_CONN, &sql, None).await });
        let id = tokio::time::timeout(Duration::from_secs(5), h.next_request_id("permission_required")).await;
        if let Ok(id) = &id {
            h.core.pending_permissions.resolve(id, PermissionVerdict::Deny).await.unwrap();
        }
        let r = handle.await.unwrap();
        let _ = sqlx::query(&format!("DROP TABLE {table}")).execute(&h.pool).await;
        h.drop_schema().await;

        assert!(est.is_some_and(|n| n >= 1000), "estimate must reflect the scan, got {est:?}");
        assert!(id.is_ok(), "a 2000-row public write must prompt");
        r.expect_err("denied");
    }

    // ── Phase 2: re-gate human-edited (Modified) SQL ─────────────────────

    /// Pure check on the re-gate decision: Block-class edits are refused;
    /// in-policy edits pass; multi-statement / unparseable edits are rejected.
    #[test]
    fn regate_modified_refuses_block_and_multi_statement() {
        let rules = policy::default_rules();
        assert!(regate_modified(&rules, "DROP TABLE foo").is_err(), "DROP TABLE is Block");
        assert!(regate_modified(&rules, "DROP SCHEMA bar").is_err(), "DROP SCHEMA is Block");
        assert!(regate_modified(&rules, "SELECT 1").is_ok(), "reads are fine");
        assert!(
            regate_modified(&rules, "CREATE TABLE foo (id int)").is_ok(),
            "a Prompt-class edit is the human's explicit choice and runs"
        );
        assert!(
            regate_modified(&rules, "SELECT 1; SELECT 2").is_err(),
            "an edit can't smuggle multiple statements"
        );
        assert!(regate_modified(&rules, "NOT SQL AT ALL").is_err(), "unparseable is refused");
    }

    /// The hole this closes: a human approves a benign-looking Prompt card but
    /// rewrites it into a `DROP TABLE`. The edit must be re-gated and refused,
    /// and neither the original nor the edited statement may run.
    #[tokio::test]
    async fn modified_into_drop_is_refused_and_nothing_runs() {
        let Some(mut h) = setup().await else { return };
        sqlx::query(&format!("CREATE TABLE {}.victim (id int)", h.schema))
            .execute(&h.pool)
            .await
            .unwrap();

        let core = h.core.clone();
        let create = format!("CREATE TABLE {}.t (id int)", h.schema); // Prompt-class
        let handle = tokio::spawn(async move {
            execute_statement(&core, TEST_CONN, &create, None).await
        });

        let id = h.next_request_id("permission_required").await;
        let drop_sql = format!("DROP TABLE {}.victim", h.schema);
        h.core
            .pending_permissions
            .resolve(&id, PermissionVerdict::Modified { sql: drop_sql })
            .await
            .unwrap();

        let r = handle.await.unwrap();
        let victim = h.table_exists("victim").await;
        let t = h.table_exists("t").await;
        h.drop_schema().await;

        let err = r.expect_err("a modified-into-DROP edit must be refused");
        assert!(err.to_string().contains("blocked"), "expected a block error, got: {err}");
        assert!(victim, "the edited DROP must not have run");
        assert!(!t, "the original CREATE must not have run either");
    }

    /// The re-gate must not over-block: an edit that stays within policy still
    /// runs (the human's explicit choice), and the original is discarded.
    #[tokio::test]
    async fn modified_within_policy_runs() {
        let Some(mut h) = setup().await else { return };

        let core = h.core.clone();
        let original = format!("CREATE TABLE {}.orig (id int)", h.schema);
        let handle = tokio::spawn(async move {
            execute_statement(&core, TEST_CONN, &original, None).await
        });

        let id = h.next_request_id("permission_required").await;
        let edited = format!("CREATE TABLE {}.edited (id int)", h.schema);
        h.core
            .pending_permissions
            .resolve(&id, PermissionVerdict::Modified { sql: edited })
            .await
            .unwrap();

        let r = handle.await.unwrap();
        let edited_exists = h.table_exists("edited").await;
        let orig_exists = h.table_exists("orig").await;
        h.drop_schema().await;

        r.expect("an in-policy modified statement should run");
        assert!(edited_exists, "the edited statement should have run");
        assert!(!orig_exists, "the original statement should not have run");
    }

    // ── Phase 3+4: collect verdicts before BEGIN ─────────────────────────

    /// The half-apply / lock-held holes: in a non-transactional batch a
    /// mid-batch Deny used to leave earlier statements committed, because each
    /// statement ran as soon as its card was answered. Now every verdict is
    /// collected before any statement runs — so the moment stmt b's card
    /// appears, stmt a (already Allowed) still has not run, and denying b
    /// aborts the whole batch with nothing applied.
    #[tokio::test]
    async fn migration_deny_aborts_before_any_statement_runs() {
        let Some(mut h) = setup().await else { return };
        let core = h.core.clone();
        let s = h.schema.clone();
        let stmts = vec![
            format!("CREATE TABLE {s}.a (id int)"),
            format!("CREATE TABLE {s}.b (id int)"),
        ];
        let handle =
            tokio::spawn(async move { execute_migration(&core, TEST_CONN, stmts, None).await });

        // Approve WITHOUT a transaction — the mode that used to half-apply.
        h.approve_migration(false).await;

        // Allow stmt a's card.
        let card_a = h.next_request_id("permission_required").await;
        h.core
            .pending_permissions
            .resolve(&card_a, PermissionVerdict::Allow)
            .await
            .unwrap();

        // stmt b's card now appears — proving the runner is still collecting
        // verdicts and has not begun executing. Pre-fix, a would already exist.
        let card_b = h.next_request_id("permission_required").await;
        assert!(
            !h.table_exists("a").await,
            "no statement may run until every verdict is collected"
        );

        h.core
            .pending_permissions
            .resolve(&card_b, PermissionVerdict::Deny)
            .await
            .unwrap();

        let r = handle.await.unwrap();
        let a = h.table_exists("a").await;
        let b = h.table_exists("b").await;
        h.drop_schema().await;

        r.expect_err("a denied deviation must abort the migration");
        assert!(!a, "stmt a must not be left committed after the deny");
        assert!(!b, "stmt b was denied");
    }

    /// Happy path: every deviation approved, transaction-wrapped — the batch
    /// commits and all statements are present.
    #[tokio::test]
    async fn migration_all_approved_commits_atomically() {
        let Some(mut h) = setup().await else { return };
        let core = h.core.clone();
        let s = h.schema.clone();
        let stmts = vec![
            format!("CREATE TABLE {s}.a (id int)"),
            format!("CREATE TABLE {s}.b (id int)"),
        ];
        let handle =
            tokio::spawn(async move { execute_migration(&core, TEST_CONN, stmts, None).await });

        h.approve_migration(true).await;
        h.resolve_next_permission(PermissionVerdict::Allow).await;
        h.resolve_next_permission(PermissionVerdict::Allow).await;

        let r = handle.await.unwrap();
        let a = h.table_exists("a").await;
        let b = h.table_exists("b").await;
        h.drop_schema().await;

        let results = r.expect("an all-approved migration should commit");
        assert_eq!(results.len(), 2, "one result per statement");
        assert!(a && b, "both statements committed");
    }

    /// The migration path re-gates Modified deviations too: editing a card
    /// into a DROP is refused, and nothing runs.
    #[tokio::test]
    async fn migration_modified_into_drop_is_refused() {
        let Some(mut h) = setup().await else { return };
        sqlx::query(&format!("CREATE TABLE {}.victim (id int)", h.schema))
            .execute(&h.pool)
            .await
            .unwrap();

        let core = h.core.clone();
        let s = h.schema.clone();
        let stmts = vec![format!("CREATE TABLE {s}.t (id int)")];
        let handle =
            tokio::spawn(async move { execute_migration(&core, TEST_CONN, stmts, None).await });

        h.approve_migration(false).await;
        let card = h.next_request_id("permission_required").await;
        h.core
            .pending_permissions
            .resolve(&card, PermissionVerdict::Modified { sql: format!("DROP TABLE {s}.victim") })
            .await
            .unwrap();

        let r = handle.await.unwrap();
        let victim = h.table_exists("victim").await;
        h.drop_schema().await;

        let err = r.expect_err("a modified-into-DROP deviation must be refused");
        assert!(err.to_string().contains("blocked"), "expected a block error, got: {err}");
        assert!(victim, "the edited DROP must not have run");
    }

    // ── R2: redaction of derived result columns + error channel ──────────
    //
    // The agent read path (execute_statement's Allow-read branch → run_decoded)
    // must not leak a classified value by wrapping the column in an expression,
    // and a DB error must not echo it. See core::lineage + query::sanitize_db_error.

    /// Classify `<schema>.patients.ssn` and seed one row. Returns the real ssn.
    async fn setup_classified_patients(h: &Harness) -> String {
        let ssn = "111-22-3333";
        sqlx::query(&format!("CREATE TABLE {}.patients (id int, ssn text)", h.schema))
            .execute(&h.pool)
            .await
            .unwrap();
        sqlx::query(&format!("INSERT INTO {}.patients (id, ssn) VALUES (1, $1)", h.schema))
            .bind(ssn)
            .execute(&h.pool)
            .await
            .unwrap();
        let conn_id = connections::get(&h.core.meta, TEST_CONN).await.unwrap().id;
        connections::insert_classification(
            &h.core.meta,
            &conn_id,
            &h.schema,
            "patients",
            "ssn",
            Category::Pii,
            ClassificationStatus::Confirmed,
            "test",
        )
        .await
        .unwrap();
        h.core.redactor_cache.invalidate(TEST_CONN).await;
        ssn.to_string()
    }

    #[tokio::test]
    async fn derived_expression_column_is_redacted_but_bare_is_faked() {
        let Some(h) = setup().await else { return };
        let real = setup_classified_patients(&h).await;

        // Bare classified column → deterministic fake (not the real value, not
        // the derived marker).
        let bare = execute_statement(
            &h.core,
            TEST_CONN,
            &format!("SELECT ssn FROM {}.patients", h.schema),
            None,
        )
        .await
        .expect("bare select runs");
        let v = bare.rows[0][0].as_deref().unwrap();
        assert_ne!(v, real, "bare classified column must be faked");
        assert_ne!(v, "<redacted>", "bare column gets a type-preserving fake, not the marker");
        assert!(bare.columns[0].redacted, "bare classified column is marked redacted");

        // Expression over the classified column → the bypass; must be redacted.
        let derived = execute_statement(
            &h.core,
            TEST_CONN,
            &format!("SELECT ssn || '' AS x FROM {}.patients", h.schema),
            None,
        )
        .await
        .expect("derived select runs");
        let dv = derived.rows[0][0].as_deref().unwrap();
        assert_eq!(dv, "<redacted>", "expression over classified column must be redacted; got {dv}");
        assert!(!dv.contains(real.as_str()), "the real ssn must never appear");
        assert!(derived.redaction_meta.is_some(), "agent must be told data was redacted");

        // Non-sensitive aggregate over the same table stays visible.
        let agg = execute_statement(
            &h.core,
            TEST_CONN,
            &format!("SELECT count(*) AS n FROM {}.patients", h.schema),
            None,
        )
        .await
        .expect("count runs");
        assert_eq!(agg.rows[0][0].as_deref(), Some("1"), "count(*) must not be redacted");

        h.drop_schema().await;
    }

    /// SQL run from a string, and sampled-value catalogs, reach classified
    /// values with nothing in the statement for redaction to key on. On a
    /// classified connection the agent is refused them outright.
    #[tokio::test]
    async fn untraceable_sql_is_refused_on_classified_connection() {
        let Some(h) = setup().await else { return };
        let real = setup_classified_patients(&h).await;
        let xml = format!(
            "SELECT query_to_xml('select ssn from {}.patients', true, false, '')",
            h.schema
        );
        let via_gate = execute_statement(&h.core, TEST_CONN, &xml, None).await;
        let via_query = crate::core::run_query(&h.core, TEST_CONN, &xml, false).await;
        let stats = crate::core::run_query(
            &h.core,
            TEST_CONN,
            "SELECT most_common_vals::text FROM pg_stats WHERE attname = 'ssn'",
            false,
        )
        .await;
        h.drop_schema().await;

        for r in [via_gate, via_query, stats] {
            let e = format!("{:#}", r.expect_err("must be refused"));
            assert!(e.contains("not available to agents"), "got: {e}");
            assert!(!e.contains(real.as_str()));
        }
    }

    #[tokio::test]
    async fn db_error_does_not_echo_classified_value() {
        let Some(h) = setup().await else { return };
        let real = setup_classified_patients(&h).await;

        // `ssn::int` fails with `invalid input syntax for type integer:
        // "111-22-3333"`. On the agent path + classified connection that
        // message must be withheld before it reaches the agent.
        let err = execute_statement(
            &h.core,
            TEST_CONN,
            &format!("SELECT ssn::int FROM {}.patients", h.schema),
            None,
        )
        .await
        .expect_err("cast fails");
        let msg = format!("{err:#}");
        h.drop_schema().await;
        assert!(!msg.contains(real.as_str()), "DB error must not echo the real ssn; got: {msg}");
        assert!(
            msg.contains("withheld") || msg.contains("redaction"),
            "expected a sanitized error, got: {msg}"
        );
    }
}
