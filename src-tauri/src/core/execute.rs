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
use super::policy::{self, OpKind, StmtInfo, StmtKind, Verdict};
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
/// and waits for a bulk verdict. On `ApproveAndPrompt`, runs the plan
/// statement-by-statement: in-policy statements run immediately, deviations
/// fall through to the standard single-statement permission card. Wrapping
/// in a transaction (default true on the verdict) makes any denial roll
/// back the whole batch.
///
/// Returns a vector of QueryResult — one per statement that ran. If a
/// deviation is denied (or any statement errors), returns Err and the
/// transaction is rolled back.
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
    let (id, rx) = core.pending_migrations.register().await;
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

    // Open the pool and (optionally) BEGIN a transaction.
    let pool = core.pool(conn).await?;
    let mut tx_opt = if wrap_in_tx {
        Some(pool.begin().await.context("begin migration transaction")?)
    } else {
        None
    };

    let mut results: Vec<QueryResult> = Vec::with_capacity(statements.len());
    for (idx, stmt) in parsed.iter().enumerate() {
        let original_sql = &statements[idx];
        let stmt_verdict = &classified[idx];

        let final_sql: String = if stmt_verdict.verdict == "allow" {
            original_sql.clone()
        } else {
            // Prompt fallthrough — emit single-statement card and wait.
            let (rid, rx) = core.pending_permissions.register().await;
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
                    if let Some(tx) = tx_opt.take() {
                        let _ = tx.rollback().await;
                    }
                    return Err(anyhow!(
                        "migration aborted: stmt {idx} denied by user"
                    ));
                }
                PermissionVerdict::Modified { sql: new_sql } => new_sql,
            }
        };

        // Run the statement. Inside a transaction we go straight through
        // sqlx — no redaction lookup, no pool round-trip — since redaction
        // applies to query *output*, and migrations rarely return rows.
        let exec_started = Instant::now();
        match tx_opt.as_mut() {
            Some(tx) => {
                sqlx::query(&final_sql)
                    .execute(&mut **tx)
                    .await
                    .with_context(|| format!("stmt {idx} failed"))?;
            }
            None => {
                sqlx::query(&final_sql)
                    .execute(&pool)
                    .await
                    .with_context(|| format!("stmt {idx} failed"))?;
            }
        }
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
    use crate::core::permission::PermissionVerdict;
    use crate::core::policy;
    use crate::core::Core;
    use crate::pool::PoolRegistry;
    use crate::types::{ActivityEvent, NewConnectionInput};
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
        pools.insert_for_test(TEST_CONN, pool.clone()).await;

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
}
