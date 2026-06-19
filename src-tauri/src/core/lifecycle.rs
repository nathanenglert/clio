use anyhow::Result;
use std::time::Instant;

use crate::connections;
use crate::types::{ClassifyOutcome, Connection, NewConnectionInput};

use super::Core;

pub async fn list_connections(core: &Core) -> Result<Vec<Connection>> {
    let started = Instant::now();
    let r = async {
        let mut conns = connections::list(&core.meta).await?;
        for c in &mut conns {
            c.connected = core.pools.is_connected(&c.name).await;
        }
        Ok::<_, anyhow::Error>(conns)
    }
    .await;
    core.record_ok("list_connections", "", started, &r);
    r
}

pub async fn add_connection(core: &Core, input: NewConnectionInput) -> Result<Connection> {
    let started = Instant::now();
    let detail = input.name.clone();
    let r = connections::insert(&core.meta, &input).await;
    core.record_ok("add_connection", detail, started, &r);
    r
}

pub async fn delete_connection(core: &Core, name: &str) -> Result<()> {
    let started = Instant::now();
    let r = async {
        core.pools.drop_pool(name).await;
        connections::delete(&core.meta, name).await
    }
    .await;
    core.record_ok("delete_connection", name, started, &r);
    r
}

pub async fn connect(core: &Core, name: &str) -> Result<Option<ClassifyOutcome>> {
    let started = Instant::now();
    let r = async {
        let c = connections::get(&core.meta, name).await?;
        core.pools.connect(&c).await.map(|_| ())?;
        // Run the heuristic classifier synchronously. The privacy guarantee
        // ("MCP returns redacted data after connect") depends on this
        // completing before the connect call returns to the agent. Failures
        // are tolerated — the pool stays up; the UI just doesn't get a toast.
        let outcome = super::sensitivity::classify_schema(core, name).await.ok();
        Ok::<_, anyhow::Error>(outcome)
    }
    .await;
    core.record_ok("connect", name, started, &r);
    r
}

/// Surface an agent's proposed query to the human as a new (un-run) tab.
/// Fire-and-forget: records a `propose_query` activity event whose payload the
/// frontend turns into an agent-authored tab + toast. Never touches Postgres.
/// Returns the resolved tab title.
pub fn propose_query(core: &Core, sql: &str, title: Option<String>) -> String {
    let started = Instant::now();
    let detail = title.unwrap_or_else(|| "Proposed query".to_string());
    let payload = Some(super::query::cap_payload(sql));
    let result: Result<()> = Ok(());
    core.record_ok_with_payload("propose_query", detail.clone(), payload, started, &result);
    detail
}

pub async fn disconnect(core: &Core, name: &str) -> Result<()> {
    let started = Instant::now();
    core.pools.drop_pool(name).await;
    core.redactor_cache.invalidate(name).await;
    let r: Result<()> = Ok(());
    core.record_ok("disconnect", name, started, &r);
    r
}
