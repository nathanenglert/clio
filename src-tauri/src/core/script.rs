//! Editor runs. The editor splits a tab's SQL into statements and sends them
//! here; they run in order on one connection and stop at the first error, like
//! `psql`. A transaction the run leaves open pins that connection to the tab,
//! so a later run — or Commit / Roll back — continues it.

use anyhow::{anyhow, Result};
use sqlx::pool::PoolConnection;
use sqlx::{Connection, Executor, PgConnection, Postgres, Row};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Instant;
use tokio::sync::Mutex;

use crate::types::{Notice, OpenTransaction, ScriptResult, ScriptStep, Undo};

use super::query::{cap_payload, run_decoded, strip_comments_lower};
use super::sensitivity;
use super::Core;

/// A tab's open transaction.
struct Session {
    /// Connection name the transaction belongs to.
    conn: String,
    /// Detached from the pool, so a parked transaction doesn't hold one of
    /// its slots or keep `PgPool::close` waiting.
    db: PgConnection,
    opened_at_ms: i64,
    /// Statements run inside the transaction. The pool can't see what they
    /// wrote until it ends, so the classify-the-copy pass runs again then.
    written: Vec<String>,
}

/// Each tab's open transaction, if any. The per-tab lock serializes that tab's
/// runs and its Commit / Roll back, so a second run can't start on a fresh
/// pooled connection while the first still owns the transaction.
#[derive(Clone, Default)]
pub(crate) struct Sessions(Arc<Mutex<HashMap<String, Arc<Mutex<Option<Session>>>>>>);

impl Sessions {
    async fn slot(&self, tab: &str) -> Arc<Mutex<Option<Session>>> {
        self.0.lock().await.entry(tab.to_string()).or_default().clone()
    }
}

/// The connection a run uses: one from the pool, or the tab's pinned one.
enum Db {
    Pooled(PoolConnection<Postgres>),
    Pinned(PgConnection),
}

impl Db {
    fn conn(&mut self) -> &mut PgConnection {
        match self {
            Db::Pooled(c) => c,
            Db::Pinned(c) => c,
        }
    }

    fn into_pinned(self) -> PgConnection {
        match self {
            Db::Pooled(c) => c.detach(),
            Db::Pinned(c) => c,
        }
    }

    /// Back to the pool, or closed if it was pinned.
    async fn release(self) {
        if let Db::Pinned(c) = self {
            let _ = c.close().await;
        }
    }
}

tokio::task_local! {
    /// Messages the server raised while this task's script runs. sqlx doesn't
    /// return notices; it only logs them, and [`NoticeLayer`] copies them here.
    static NOTICES: RefCell<Vec<Notice>>;
}

const NOTICE_TARGET: &str = "sqlx::postgres::notice";

/// Tracing layer that copies sqlx's Postgres notice events into the running
/// script's buffer. sqlx reads the connection inside the task polling it, so
/// the event fires within that task's `NOTICES` scope; elsewhere it's ignored.
pub struct NoticeLayer;

impl NoticeLayer {
    pub const TARGET: &'static str = NOTICE_TARGET;
}

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for NoticeLayer {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        if event.metadata().target() != NOTICE_TARGET {
            return;
        }
        struct Message(String);
        impl tracing::field::Visit for Message {
            fn record_str(&mut self, field: &tracing::field::Field, value: &str) {
                if field.name() == "message" {
                    self.0 = value.to_string();
                }
            }
            fn record_debug(&mut self, field: &tracing::field::Field, value: &dyn std::fmt::Debug) {
                if field.name() == "message" {
                    self.0 = format!("{value:?}");
                }
            }
        }
        let mut message = Message(String::new());
        event.record(&mut message);
        // sqlx's mapping from Postgres severity to tracing level, reversed.
        let severity = match *event.metadata().level() {
            tracing::Level::ERROR => "error",
            tracing::Level::WARN => "warning",
            tracing::Level::INFO => "notice",
            tracing::Level::DEBUG => "debug",
            tracing::Level::TRACE => "info",
        };
        let _ = NOTICES.try_with(|buf| {
            buf.borrow_mut().push(Notice {
                severity: severity.into(),
                message: message.0,
            })
        });
    }
}

fn take_notices() -> Vec<Notice> {
    NOTICES
        .try_with(|buf| std::mem::take(&mut *buf.borrow_mut()))
        .unwrap_or_default()
}

/// Run a tab's statements in order. Errors that stop the run are reported in
/// the result (per step, or `error` for the run as a whole), so the editor can
/// show what ran before the failure.
pub async fn run_script(
    core: &Core,
    conn: &str,
    tab: &str,
    statements: Vec<String>,
    reveal: bool,
) -> Result<ScriptResult> {
    if statements.is_empty() {
        return Err(anyhow!("nothing to run"));
    }
    let started = Instant::now();
    let result = NOTICES
        .scope(RefCell::new(Vec::new()), run(core, conn, tab, &statements, reveal, started))
        .await;

    // One activity entry per run, with the whole script as the payload so
    // History can re-open it.
    let script = statements.join(";\n");
    let one_line = script.replace('\n', " ");
    let detail = if one_line.chars().count() > 80 {
        format!("{}...", one_line.chars().take(77).collect::<String>())
    } else {
        one_line
    };
    let failure = result
        .error
        .as_ref()
        .or_else(|| result.steps.iter().find_map(|s| s.error.as_ref()));
    let outcome: Result<()> = match failure {
        Some(e) => Err(anyhow!(e.clone())),
        None => Ok(()),
    };
    core.record_ok_with_payload("run_query", detail, Some(cap_payload(&script)), started, &outcome);
    Ok(result)
}

async fn run(
    core: &Core,
    conn: &str,
    tab: &str,
    statements: &[String],
    reveal: bool,
    started: Instant,
) -> ScriptResult {
    let run_started_ms = chrono::Utc::now().timestamp_millis();
    let mut out = ScriptResult {
        steps: Vec::new(),
        result: None,
        result_step: None,
        transaction: None,
        error: None,
        elapsed_ms: 0,
    };
    let finish = |mut out: ScriptResult| {
        out.elapsed_ms = started.elapsed().as_millis() as u64;
        out
    };

    let slot = core.sessions.slot(tab).await;
    let mut held = slot.lock().await;
    let pool = match core.pool(conn).await {
        Ok(p) => p,
        Err(e) => {
            out.error = Some(format!("{e:#}"));
            return finish(out);
        }
    };
    // A tab belongs to one connection, so a session for another can't happen;
    // if it did, dropping it closes the connection and Postgres rolls it back.
    let (mut db, earlier) = match held.take().filter(|s| s.conn == conn) {
        Some(s) => (Db::Pinned(s.db), Some((s.opened_at_ms, s.written))),
        None => match pool.acquire().await {
            Ok(c) => (Db::Pooled(c), None),
            Err(e) => {
                out.error = Some(format!("couldn't get a connection: {e}"));
                return finish(out);
            }
        },
    };

    // Inside an already-open transaction, mark where this run starts so a
    // failure undoes only this run's statements.
    if earlier.is_some() {
        if let Err(e) = db.conn().execute(sqlx::raw_sql("SAVEPOINT clio_run")).await {
            db.release().await;
            out.error = Some(format!(
                "This tab's open transaction was lost, so Postgres rolled it back ({e}). \
                 The server may have ended it for sitting idle. Nothing in this run ran."
            ));
            return finish(out);
        }
    }

    // Still in the transaction the run started in, with its savepoint live.
    let mut same_tx = earlier.is_some();
    let mut ran: Vec<String> = Vec::new();
    let mut failed = false;
    for (i, sql) in statements.iter().enumerate() {
        take_notices();
        let t = Instant::now();
        let r = run_decoded(core, conn, sql, reveal, false, Some(db.conn())).await;
        let notices = take_notices();
        let elapsed_ms = t.elapsed().as_millis() as u64;
        match r {
            Ok(res) => {
                if ends_transaction(sql) {
                    same_tx = false;
                }
                out.steps.push(ScriptStep {
                    error: None,
                    rows_affected: res.rows_affected.unwrap_or(0),
                    row_count: res.row_count,
                    elapsed_ms,
                    notices,
                    rolled_back: None,
                });
                ran.push(sql.clone());
                // A statement with no rows reports no columns either, so a
                // single statement always fills the grid ("0 rows").
                if !res.columns.is_empty() || statements.len() == 1 {
                    out.result_step = Some(i);
                    out.result = Some(res);
                }
            }
            Err(e) => {
                let undo = recover(db.conn(), same_tx).await;
                out.steps.push(ScriptStep {
                    error: Some(error_text(&e)),
                    rows_affected: 0,
                    row_count: 0,
                    elapsed_ms,
                    notices,
                    rolled_back: undo,
                });
                failed = true;
                break;
            }
        }
    }
    if same_tx && !failed {
        let _ = db.conn().execute(sqlx::raw_sql("RELEASE SAVEPOINT clio_run")).await;
    }

    let in_tx = in_transaction(db.conn()).await;
    let (earlier_at, earlier_written) = earlier.unzip();
    let earlier_written = earlier_written.unwrap_or_default();

    // Classify what this run's writes copied. The pool sees only committed
    // data: pass now for whatever is visible, and keep writes made inside a
    // still-open transaction for a second pass once it ends.
    let continues = in_tx == Some(true) && same_tx;
    let (now, keep) = if in_tx == Some(true) {
        let keep = if continues { [earlier_written.clone(), ran.clone()].concat() } else { ran.clone() };
        let now = if continues { ran } else { [earlier_written, ran].concat() };
        (now, keep)
    } else {
        ([earlier_written, ran].concat(), Vec::new())
    };
    for sql in &now {
        if let Err(e) = sensitivity::inherit_from_write(core, conn, &pool, sql).await {
            out.error.get_or_insert(format!(
                "The statements ran, but classifying the data they copied failed: {e:#}"
            ));
        }
    }

    match in_tx {
        Some(true) => {
            let opened_at_ms = earlier_at.filter(|_| continues).unwrap_or(run_started_ms);
            out.transaction = Some(OpenTransaction { opened_at_ms });
            *held = Some(Session {
                conn: conn.to_string(),
                db: db.into_pinned(),
                opened_at_ms,
                written: keep,
            });
        }
        Some(false) => db.release().await,
        // The state can't be read. Never hand that connection back to the
        // pool: roll back whatever is open and close it.
        None => {
            let _ = db.conn().execute(sqlx::raw_sql("ROLLBACK")).await;
            let _ = db.into_pinned().close().await;
            out.error.get_or_insert(
                "Clio couldn't read the connection's transaction state afterwards, so it \
                 rolled back anything still open and closed that connection."
                    .into(),
            );
        }
    }
    finish(out)
}

/// Commit or roll back a tab's open transaction: the status chip's buttons,
/// or closing the tab. Nothing to do when the tab has none open.
pub async fn end_transaction(core: &Core, tab: &str, commit: bool) -> Result<()> {
    let started = Instant::now();
    let slot = core.sessions.slot(tab).await;
    let Some(mut s) = slot.lock().await.take() else {
        return Ok(());
    };
    let verb = if commit { "COMMIT" } else { "ROLLBACK" };
    let r = s
        .db
        .execute(sqlx::raw_sql(verb))
        .await
        .map(|_| ())
        .map_err(|e| {
            let e = anyhow::Error::new(e);
            if commit {
                anyhow!("Commit failed, so Postgres rolled the transaction back: {}", error_text(&e))
            } else {
                e.context("roll back")
            }
        });
    let _ = s.db.close().await;
    core.record_ok_with_payload("run_query", verb, Some(verb.to_string()), started, &r);
    r?;
    if commit {
        let pool = core.pool(&s.conn).await?;
        for sql in &s.written {
            sensitivity::inherit_from_write(core, &s.conn, &pool, sql).await.map_err(|e| {
                e.context("committed, but classifying the data it copied failed")
            })?;
        }
    }
    Ok(())
}

/// Roll back every tab transaction on `conn`. Runs on disconnect, before the
/// pool closes.
pub(crate) async fn end_sessions_for(core: &Core, conn: &str) {
    let slots: Vec<_> = core.sessions.0.lock().await.values().cloned().collect();
    for slot in slots {
        let mut held = slot.lock().await;
        if held.as_ref().is_some_and(|s| s.conn == conn) {
            if let Some(mut s) = held.take() {
                let _ = s.db.execute(sqlx::raw_sql("ROLLBACK")).await;
                let _ = s.db.close().await;
            }
        }
    }
}

/// After a failed statement, never leave a broken transaction behind. Inside
/// the transaction the run started in (`savepoint` live), undo just this run;
/// otherwise roll the whole transaction back.
async fn recover(db: &mut PgConnection, savepoint: bool) -> Option<Undo> {
    if in_transaction(db).await == Some(false) {
        return None;
    }
    if savepoint
        && (&mut *db)
            .execute(sqlx::raw_sql("ROLLBACK TO SAVEPOINT clio_run; RELEASE SAVEPOINT clio_run"))
            .await
            .is_ok()
    {
        return Some(Undo::Run);
    }
    let _ = db.execute(sqlx::raw_sql("ROLLBACK")).await;
    Some(Undo::Transaction)
}

/// Whether `db` is inside a transaction block; `None` when the probe itself
/// fails (an aborted transaction, or a broken connection). sqlx keeps the
/// server's transaction status private, so ask: `now()` is the transaction's
/// start and `statement_timestamp()` this message's, equal only when the probe
/// began its own implicit transaction. It must go over the simple protocol
/// (`raw_sql`) — the extended protocol's Execute resets the statement time
/// after Parse has begun the transaction, so the two never match there.
async fn in_transaction(db: &mut PgConnection) -> Option<bool> {
    let row = db
        .fetch_one(sqlx::raw_sql("SELECT now() = statement_timestamp()"))
        .await
        .ok()?;
    row.try_get::<bool, _>(0).ok().map(|implicit| !implicit)
}

/// Whether `sql` ends the current transaction block, taking a savepoint in it
/// along. Lexical, to save a round trip per statement; the run re-reads the
/// real state from the server before deciding where the connection goes.
fn ends_transaction(sql: &str) -> bool {
    let s = strip_comments_lower(sql);
    let mut words = s.trim().trim_end_matches(';').split_whitespace();
    match words.next() {
        Some("commit" | "end" | "abort") => true,
        // `ROLLBACK [WORK | TRANSACTION] TO [SAVEPOINT] name` keeps it open.
        Some("rollback") => words.find(|w| *w != "work" && *w != "transaction") != Some("to"),
        Some("prepare") => words.next() == Some("transaction"),
        _ => false,
    }
}

/// A statement's error the way `psql` shows it: the message, then DETAIL,
/// HINT and CONTEXT (which names the failing line inside a DO block).
fn error_text(e: &anyhow::Error) -> String {
    let Some(sqlx::Error::Database(db)) = e.downcast_ref::<sqlx::Error>() else {
        return format!("{e:#}");
    };
    let Some(pg) = db.try_downcast_ref::<sqlx::postgres::PgDatabaseError>() else {
        return db.message().to_string();
    };
    let mut s = pg.message().to_string();
    for (label, part) in [("DETAIL", pg.detail()), ("HINT", pg.hint()), ("CONTEXT", pg.r#where())] {
        if let Some(p) = part {
            s.push_str(&format!("\n{label}: {p}"));
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::execute::tests::{setup, Harness, TEST_CONN};
    use crate::types::ScriptResult;

    impl Harness {
        async fn run(&self, tab: &str, statements: &[&str]) -> ScriptResult {
            let statements = statements.iter().map(|s| s.replace("{s}", &self.schema)).collect();
            run_script(&self.human, TEST_CONN, tab, statements, false).await.unwrap()
        }

        async fn seed(&self, n: i32) {
            let s = &self.schema;
            sqlx::query(&format!("CREATE TABLE {s}.t (id int primary key)"))
                .execute(&self.pool)
                .await
                .unwrap();
            sqlx::query(&format!("INSERT INTO {s}.t SELECT generate_series(1, {n})"))
                .execute(&self.pool)
                .await
                .unwrap();
        }

        /// Row count as everyone else sees it: committed data, via the pool.
        async fn committed_rows(&self) -> i64 {
            sqlx::query_scalar(&format!("SELECT count(*) FROM {}.t", self.schema))
                .fetch_one(&self.pool)
                .await
                .unwrap()
        }
    }

    fn ok(r: &ScriptResult) -> bool {
        r.error.is_none() && r.steps.iter().all(|s| s.error.is_none())
    }

    /// The LAS-2493 shape: BEGIN, a DO block that deletes and checks its own
    /// counts, COMMIT. Used to fail outright as one prepared statement.
    #[tokio::test]
    async fn begin_do_commit_script_runs_and_commits() {
        let Some(h) = setup().await else { return };
        h.seed(10).await;
        let r = h
            .run(
                "tab",
                &[
                    "-- header comment\nBEGIN",
                    "DO $$\nDECLARE n int;\nBEGIN\n  DELETE FROM {s}.t WHERE id <= 3;\n  GET DIAGNOSTICS n = ROW_COUNT;\n  IF n <> 3 THEN RAISE EXCEPTION 'expected 3, got %', n; END IF;\nEND $$",
                    "COMMIT",
                ],
            )
            .await;
        assert!(ok(&r), "{r:?}");
        assert_eq!(r.steps.len(), 3);
        assert!(r.transaction.is_none());
        assert_eq!(h.committed_rows().await, 7);
        h.drop_schema().await;
    }

    #[tokio::test]
    async fn failing_check_rolls_back_the_whole_script() {
        let Some(h) = setup().await else { return };
        h.seed(10).await;
        let r = h
            .run(
                "tab",
                &[
                    "BEGIN",
                    "DELETE FROM {s}.t WHERE id = 10",
                    "DO $$\nBEGIN\n  DELETE FROM {s}.t WHERE id <= 3;\n  RAISE EXCEPTION 'expected %, got %', 4, 3;\nEND $$",
                    "COMMIT",
                ],
            )
            .await;
        assert_eq!(r.steps.len(), 3, "stops at the failure: {r:?}");
        assert_eq!(r.steps[1].rows_affected, 1);
        let failed = &r.steps[2];
        let msg = failed.error.as_deref().unwrap();
        assert!(msg.starts_with("expected 4, got 3"), "{msg}");
        assert!(msg.contains("CONTEXT: PL/pgSQL function inline_code_block"), "{msg}");
        assert_eq!(failed.rolled_back, Some(Undo::Transaction));
        assert!(r.transaction.is_none());
        assert_eq!(h.committed_rows().await, 10, "nothing committed");
        h.drop_schema().await;
    }

    #[tokio::test]
    async fn an_open_transaction_stays_with_its_tab() {
        let Some(h) = setup().await else { return };
        h.seed(10).await;
        let r = h.run("tab", &["BEGIN", "DELETE FROM {s}.t WHERE id <= 4"]).await;
        assert!(ok(&r), "{r:?}");
        let opened = r.transaction.as_ref().expect("transaction stays open").opened_at_ms;

        // Nobody else sees the delete — not the pool, not another tab.
        assert_eq!(h.committed_rows().await, 10);
        for _ in 0..6 {
            let other = h.run("other", &["SELECT count(*)::int AS n FROM {s}.t"]).await;
            assert_eq!(other.result.unwrap().rows[0][0].as_deref(), Some("10"));
            assert!(other.transaction.is_none());
        }

        // The tab itself continues the transaction, and keeps its start time.
        let r = h.run("tab", &["SELECT count(*)::int AS n FROM {s}.t"]).await;
        assert_eq!(r.result.unwrap().rows[0][0].as_deref(), Some("6"));
        assert_eq!(r.transaction.unwrap().opened_at_ms, opened);

        end_transaction(&h.human, "tab", false).await.unwrap();
        assert_eq!(h.committed_rows().await, 10, "rolled back");
        let r = h.run("tab", &["SELECT 1"]).await;
        assert!(r.transaction.is_none());
        h.drop_schema().await;
    }

    #[tokio::test]
    async fn a_typo_inside_an_open_transaction_keeps_earlier_work() {
        let Some(h) = setup().await else { return };
        h.seed(10).await;
        h.run("tab", &["BEGIN", "DELETE FROM {s}.t WHERE id <= 3"]).await;
        let r = h.run("tab", &["DELETE FROM {s}.t WHERE id = 4", "SELEC 1"]).await;
        assert_eq!(r.steps[1].rolled_back, Some(Undo::Run), "{r:?}");
        assert!(r.transaction.is_some(), "transaction survives");

        let r = h.run("tab", &["COMMIT"]).await;
        assert!(ok(&r) && r.transaction.is_none(), "{r:?}");
        assert_eq!(h.committed_rows().await, 7, "first delete kept, the failed run's undone");
        h.drop_schema().await;
    }

    #[tokio::test]
    async fn commit_failure_reports_the_rollback() {
        let Some(h) = setup().await else { return };
        let s = &h.schema;
        sqlx::raw_sql(&format!(
            "CREATE TABLE {s}.p (id int primary key);
             CREATE TABLE {s}.c (p int REFERENCES {s}.p DEFERRABLE INITIALLY DEFERRED)"
        ))
        .execute(&h.pool)
        .await
        .unwrap();
        let r = h.run("tab", &["BEGIN", "INSERT INTO {s}.c VALUES (1)"]).await;
        assert!(r.transaction.is_some(), "{r:?}");
        let e = end_transaction(&h.human, "tab", true).await.unwrap_err();
        assert!(format!("{e:#}").contains("rolled the transaction back"), "{e:#}");
        let r = h.run("tab", &["SELECT count(*)::int FROM {s}.c"]).await;
        assert_eq!(r.result.unwrap().rows[0][0].as_deref(), Some("0"));
        h.drop_schema().await;
    }

    #[tokio::test]
    async fn disconnect_rolls_back_open_tabs() {
        let Some(h) = setup().await else { return };
        h.seed(5).await;
        h.run("tab", &["BEGIN", "DELETE FROM {s}.t"]).await;
        end_sessions_for(&h.human, TEST_CONN).await;
        assert_eq!(h.committed_rows().await, 5);
        let r = h.run("tab", &["SELECT 1"]).await;
        assert!(r.transaction.is_none());
        h.drop_schema().await;
    }

    #[tokio::test]
    async fn a_transaction_the_server_ended_is_reported_lost() {
        let Some(h) = setup().await else { return };
        let r = h.run("tab", &["BEGIN", "SELECT pg_backend_pid() AS pid"]).await;
        let pid: i32 = r.result.unwrap().rows[0][0].as_deref().unwrap().parse().unwrap();
        sqlx::query("SELECT pg_terminate_backend($1)").bind(pid).execute(&h.pool).await.unwrap();
        let r = h.run("tab", &["SELECT 1"]).await;
        assert!(r.error.as_deref().unwrap().contains("transaction was lost"), "{r:?}");
        assert!(r.steps.is_empty() && r.transaction.is_none());
        let r = h.run("tab", &["SELECT 1"]).await;
        assert!(ok(&r), "the tab recovers on the next run: {r:?}");
        h.drop_schema().await;
    }

    #[tokio::test]
    async fn notices_reach_the_step_that_raised_them() {
        use tracing_subscriber::{filter::Targets, prelude::*};
        let _guard = tracing_subscriber::registry()
            .with(NoticeLayer.with_filter(Targets::new().with_target(NoticeLayer::TARGET, tracing::Level::TRACE)))
            .set_default();
        let Some(h) = setup().await else { return };
        let r = h
            .run(
                "tab",
                &[
                    "SELECT 1",
                    "DO $$ BEGIN RAISE NOTICE 'deleted %', 5; RAISE WARNING 'careful'; RAISE INFO 'fyi'; END $$",
                    "COMMIT",
                ],
            )
            .await;
        assert!(r.steps[0].notices.is_empty());
        let got: Vec<_> = r.steps[1].notices.iter().map(|n| format!("{}: {}", n.severity, n.message)).collect();
        assert_eq!(got, ["notice: deleted 5", "warning: careful", "info: fyi"]);
        let commit: Vec<_> = r.steps[2].notices.iter().map(|n| n.message.as_str()).collect();
        assert_eq!(commit, ["there is no transaction in progress"]);
        h.drop_schema().await;
    }

    #[test]
    fn ends_transaction_reads_the_verb() {
        for sql in ["COMMIT", "commit work", "END", "abort", "ROLLBACK", "rollback and chain",
                    "-- done\nCOMMIT;", "PREPARE TRANSACTION 'x'"] {
            assert!(ends_transaction(sql), "{sql}");
        }
        for sql in ["ROLLBACK TO SAVEPOINT a", "rollback work to a", "BEGIN", "SAVEPOINT a",
                    "DELETE FROM t", "PREPARE q AS SELECT 1", "endpoint"] {
            assert!(!ends_transaction(sql), "{sql}");
        }
    }
}
