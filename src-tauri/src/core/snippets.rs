use anyhow::Result;
use std::time::Instant;

use crate::connections;
use crate::types::{Snippet, SnippetInput};

use super::Core;

pub async fn list_snippets(core: &Core) -> Result<Vec<Snippet>> {
    let started = Instant::now();
    let r = connections::list_snippets(&core.meta).await;
    core.record_ok("list_snippets", "", started, &r);
    r
}

pub async fn upsert_snippet(core: &Core, input: SnippetInput) -> Result<Snippet> {
    let started = Instant::now();
    let detail = format!("{} ({})", input.name, input.prefix);
    let r = connections::upsert_snippet(&core.meta, input).await;
    core.record_ok("upsert_snippet", detail, started, &r);
    r
}

pub async fn delete_snippet(core: &Core, id: &str) -> Result<()> {
    let started = Instant::now();
    let r = connections::delete_snippet(&core.meta, id).await;
    core.record_ok("delete_snippet", id, started, &r);
    r
}
