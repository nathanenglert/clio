use anyhow::Result;
use std::time::Instant;

use crate::connections;
use crate::types::{SavedQuery, SavedQueryInput};

use super::Core;

pub async fn list_saved_queries(
    core: &Core,
    connection: Option<&str>,
) -> Result<Vec<SavedQuery>> {
    let started = Instant::now();
    let detail = connection.unwrap_or("(global)").to_string();
    let r = connections::list_saved_queries(&core.meta, connection).await;
    core.record_ok("list_saved_queries", detail, started, &r);
    r
}

pub async fn upsert_saved_query(core: &Core, input: SavedQueryInput) -> Result<SavedQuery> {
    let started = Instant::now();
    let scope = input
        .connection_name
        .as_deref()
        .unwrap_or("(global)")
        .to_string();
    let detail = format!("{} [{}]", input.name, scope);
    let r = connections::upsert_saved_query(&core.meta, input).await;
    core.record_ok("upsert_saved_query", detail, started, &r);
    r
}

pub async fn delete_saved_query(core: &Core, id: &str) -> Result<()> {
    let started = Instant::now();
    let r = connections::delete_saved_query(&core.meta, id).await;
    core.record_ok("delete_saved_query", id, started, &r);
    r
}
