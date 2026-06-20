use anyhow::Result;
use std::time::Instant;

use crate::connections;
use crate::types::{ActivityEvent, ClassifyOutcome, Connection, NewConnectionInput};

use super::permission::ConnectRequest;
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

/// Agent-initiated connect. A human must approve before any pool opens. If the
/// database is already connected this is a no-op success. Otherwise it
/// registers a pending request, surfaces a `connect_required` card on the
/// activity stream, and blocks until the human approves — at which point the
/// *human* core opens the pool in `resolve_connect` — or declines. The agent
/// core itself can never open a pool (`PoolAccess::Agent`).
pub async fn request_connect(core: &Core, connection: &str) -> Result<()> {
    if core.pools.is_connected(connection).await {
        return Ok(());
    }
    let (id, rx) = core.pending_connects.register(connection.to_string()).await;
    let payload = serde_json::to_string(&ConnectRequest {
        id: id.clone(),
        connection: connection.to_string(),
        agent_id: core.agent_id.clone(),
    })
    .ok();
    let evt = ActivityEvent::new(
        &core.source,
        "connect_required",
        format!("connect to {connection}"),
        "pending",
        0,
    )
    .with_payload(payload)
    .with_agent(core.agent_id.clone());
    (core.emit)(evt);

    match rx.await {
        Ok(true) => Ok(()),
        Ok(false) => Err(anyhow::anyhow!("the human declined to connect '{connection}'")),
        Err(_) => Err(anyhow::anyhow!("connect request was cancelled before a decision")),
    }
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
