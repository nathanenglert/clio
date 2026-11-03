//! Sensitivity classifications (PHI / PCI / PII) per connection.
//!
//! See design/redaction.md. This module owns:
//!  - the classifier: column names, COMMENTs, types (text-like columns are
//!    redacted until a human marks them safe), and sampled values
//!  - inheritance: view columns and write targets that hold classified data
//!  - CRUD over classifications stored in the metadata SQLite
//!  - the scan record that carries classifications across renames and lets
//!    the agent path notice schema changes since the last scan
//!
//! The MCP server can call `list_classifications` and `classify_schema`
//! (read-only-ish; classify is idempotent and only adds Pending suggestions
//! — never auto-confirms). The mask toggle does NOT live here — see core::query.

use anyhow::{Context, Result};
use futures_util::stream::{self, StreamExt};
use sqlx::postgres::PgPool;
use sqlx::Row;
use std::collections::{BTreeMap, HashMap, HashSet};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

use crate::connections::{self, ScannedColumn};
use crate::pool::PoolAccess;
use crate::types::{
    Category, Classification, ClassificationAction, ClassificationStatus, ClassifyOutcome,
};

use super::lineage::{self, StoredColumn, StoredLineage};
use super::mutations::quote_ident;
use super::redactor::RedactorView;
use super::Core;

/// Compiled name-pattern set. Patterns are matched against `column_name`
/// lowercased; tie-break order is "first match wins" so put the more
/// specific patterns first.
struct Heuristic {
    pattern: &'static str,
    category: Category,
}

const HEURISTICS: &[Heuristic] = &[
    // PCI — card-shaped things first, since they're the most regulated.
    Heuristic { pattern: "card_number", category: Category::Pci },
    Heuristic { pattern: "card_holder", category: Category::Pci },
    Heuristic { pattern: "cardholder",  category: Category::Pci },
    Heuristic { pattern: "credit_card", category: Category::Pci },
    Heuristic { pattern: "cc_number",   category: Category::Pci },
    Heuristic { pattern: "cvv",         category: Category::Pci },
    Heuristic { pattern: "cvc",         category: Category::Pci },
    Heuristic { pattern: "iban",        category: Category::Pci },
    Heuristic { pattern: "routing_number", category: Category::Pci },
    Heuristic { pattern: "account_number", category: Category::Pci },

    // PHI — health-specific. (Names/DOBs that COULD be PHI under HIPAA are
    // classified as PII here; the user can re-categorize in the review panel.)
    Heuristic { pattern: "mrn",        category: Category::Phi },
    Heuristic { pattern: "diagnosis",  category: Category::Phi },
    Heuristic { pattern: "icd",        category: Category::Phi },
    Heuristic { pattern: "npi",        category: Category::Phi },
    Heuristic { pattern: "clinical_note", category: Category::Phi },
    Heuristic { pattern: "medication", category: Category::Phi },
    Heuristic { pattern: "prescription", category: Category::Phi },

    // PII — the broad bucket.
    Heuristic { pattern: "ssn",        category: Category::Pii },
    Heuristic { pattern: "social_security", category: Category::Pii },
    Heuristic { pattern: "email",      category: Category::Pii },
    Heuristic { pattern: "phone",      category: Category::Pii },
    Heuristic { pattern: "mobile",     category: Category::Pii },
    Heuristic { pattern: "first_name", category: Category::Pii },
    Heuristic { pattern: "last_name",  category: Category::Pii },
    Heuristic { pattern: "full_name",  category: Category::Pii },
    Heuristic { pattern: "given_name", category: Category::Pii },
    Heuristic { pattern: "surname",    category: Category::Pii },
    Heuristic { pattern: "dob",        category: Category::Pii },
    Heuristic { pattern: "date_of_birth", category: Category::Pii },
    Heuristic { pattern: "birth_date", category: Category::Pii },
    Heuristic { pattern: "street",     category: Category::Pii },
    Heuristic { pattern: "address",    category: Category::Pii },
    Heuristic { pattern: "city",       category: Category::Pii },
    Heuristic { pattern: "zip",        category: Category::Pii },
    Heuristic { pattern: "postal_code", category: Category::Pii },
];

/// COMMENT-based override. Treated as a strong signal; takes precedence over
/// name patterns when the comment names a category explicitly.
fn category_from_comment(comment: &str) -> Option<Category> {
    let lower = comment.to_ascii_lowercase();
    if lower.contains("phi") {
        Some(Category::Phi)
    } else if lower.contains("pci") {
        Some(Category::Pci)
    } else if lower.contains("pii")
        || lower.contains("sensitive")
        || lower.contains("redact")
    {
        Some(Category::Pii)
    } else {
        None
    }
}

/// Apply heuristics to a single column. Returns `(category, reason)` or None
/// when nothing matches.
pub(crate) fn classify_column(
    column_name: &str,
    comment: Option<&str>,
) -> Option<(Category, String)> {
    if let Some(c) = comment {
        if let Some(cat) = category_from_comment(c) {
            return Some((cat, format!("COMMENT marked as {}", cat.as_db().to_uppercase())));
        }
    }
    let lower = column_name.to_ascii_lowercase();
    for h in HEURISTICS {
        if lower.contains(h.pattern) {
            return Some((h.category, format!("matched \"{}\"", h.pattern)));
        }
    }
    None
}

// ── Fail-closed defaults ────────────────────────────────────────────

/// Reason for a text-like column nothing else flagged. Text, JSON, XML and
/// bytea columns are where identifiers hide under unhelpful names (`notes`,
/// `payload`, `patient`), so they redact until a human marks them safe.
const UNREVIEWED_REASON: &str = "unreviewed text: redacted until marked safe";
/// Reason for a Safe column that was dropped and recreated, or changed type.
const RECREATED_REASON: &str = "column was recreated or changed type: review again";

/// Rows read per relation when sampling values.
const SAMPLE_ROWS: u32 = 200;
/// Statement timeout for one relation's sample read.
const SAMPLE_TIMEOUT_MS: u32 = 2000;
/// Total time one scan spends sampling. Relations it doesn't reach are
/// sampled on a later scan; text columns are redacted meanwhile regardless.
const SAMPLE_BUDGET: Duration = Duration::from_secs(20);
/// Relations sampled at once.
const SAMPLE_CONCURRENCY: usize = 4;
/// Passes over view definitions, so a view over a view inherits too.
const VIEW_PASSES: usize = 8;

type Key = (String, String, String);

fn key_of(c: &Classification) -> Key {
    (c.schema.clone(), c.table.clone(), c.column.clone())
}

/// A column's identity as of a scan:
/// `(table_oid, attnum, type_oid, schema, table, column)`.
type ColumnIdentity = (i32, i16, i32, String, String, String);

/// What each connection's last scan saw, plus a lock so scans don't
/// interleave. Shared by the human and agent cores (`Core::ui_with_agent`).
#[derive(Default, Clone)]
pub struct ScanIndex {
    seen: Arc<Mutex<HashMap<String, Arc<HashSet<ColumnIdentity>>>>>,
    lock: Arc<Mutex<()>>,
}

impl ScanIndex {
    pub async fn forget(&self, conn: &str) {
        self.seen.lock().await.remove(conn);
    }
}

/// One user column from the catalog. See [`CATALOG_SQL`].
#[derive(Debug, Clone)]
struct CatalogColumn {
    schema: String,
    table: String,
    column: String,
    table_oid: i32,
    attnum: i16,
    type_oid: i32,
    /// `r` table, `p` partitioned, `v` view, `m` materialized view, `f` foreign.
    relkind: char,
    comment: Option<String>,
    /// Text, JSON, XML, bytea, tsvector, hstore, or an array of them.
    text_like: bool,
    /// `int8`/`numeric`: wide enough to hold a card number.
    number_like: bool,
    /// Identity or serial: generated, so never worth sampling.
    generated_key: bool,
    /// The connecting role may SELECT it.
    readable: bool,
}

impl CatalogColumn {
    fn key(&self) -> Key {
        (self.schema.clone(), self.table.clone(), self.column.clone())
    }
    fn identity(&self) -> ColumnIdentity {
        (
            self.table_oid,
            self.attnum,
            self.type_oid,
            self.schema.clone(),
            self.table.clone(),
            self.column.clone(),
        )
    }
}

/// Every user column of every table, partitioned table, view, materialized
/// view and foreign table, in `(table_oid, attnum)` order.
const CATALOG_SQL: &str = r#"
    SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
           c.oid::int AS table_oid, a.attnum AS attnum, a.atttypid::int AS type_oid,
           c.relkind::text AS relkind,
           col_description(c.oid, a.attnum) AS comment,
           coalesce(bt.typcategory = 'S'
                    OR bt.typname IN ('json','jsonb','xml','bytea','tsvector','hstore')
                    OR (bt.typcategory = 'A'
                        AND (et.typcategory = 'S'
                             OR et.typname IN ('json','jsonb','xml','bytea','tsvector','hstore'))),
                    false) AS text_like,
           bt.typname IN ('int8','numeric') AS number_like,
           -- Identity, or serial (a sequence owned by the column). Catalog-only:
           -- nothing here opens a relation another session might be dropping.
           (a.attidentity <> '' OR EXISTS (
               SELECT 1 FROM pg_depend dep
               JOIN pg_class seq ON seq.oid = dep.objid AND seq.relkind = 'S'
               WHERE dep.refobjid = c.oid AND dep.refobjsubid = a.attnum
                 AND dep.deptype IN ('a', 'i'))) AS generated_key,
           -- NULL when another session drops the relation mid-scan.
           coalesce(has_column_privilege(c.oid, a.attnum, 'SELECT'), false) AS readable
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_type t ON t.oid = a.atttypid
    JOIN pg_type bt ON bt.oid = CASE WHEN t.typtype = 'd' THEN t.typbasetype ELSE t.oid END
    LEFT JOIN pg_type et ON et.oid = bt.typelem AND bt.typcategory = 'A'
    WHERE c.relkind IN ('r','p','v','m','f')
      AND n.nspname NOT IN ('information_schema','pg_catalog','pg_toast')
      AND n.nspname NOT LIKE 'pg_temp_%'
      AND n.nspname NOT LIKE 'pg_toast_temp_%'
    ORDER BY c.oid, a.attnum
"#;

async fn read_catalog(pool: &PgPool) -> Result<Vec<CatalogColumn>> {
    let rows = sqlx::query(CATALOG_SQL)
        .fetch_all(pool)
        .await
        .with_context(|| "schema scan failed")?;
    rows.iter()
        .map(|r| {
            Ok(CatalogColumn {
                schema: r.try_get("schema")?,
                table: r.try_get("table")?,
                column: r.try_get("column")?,
                table_oid: r.try_get("table_oid")?,
                attnum: r.try_get("attnum")?,
                type_oid: r.try_get("type_oid")?,
                relkind: r.try_get::<String, _>("relkind")?.chars().next().unwrap_or('r'),
                comment: r.try_get("comment")?,
                text_like: r.try_get("text_like")?,
                number_like: r.try_get("number_like")?,
                generated_key: r.try_get("generated_key")?,
                readable: r.try_get("readable")?,
            })
        })
        .collect::<std::result::Result<_, sqlx::Error>>()
        .with_context(|| "decode schema scan")
}

/// What a scan changes, worked out from the catalog, the last scan's record,
/// and the stored classifications before anything is written.
#[derive(Debug, Default)]
struct ScanPlan {
    /// Classifications to move to a renamed column: `(old, new)`.
    moves: Vec<(Key, Key)>,
    /// Classifications whose column is gone.
    stale: Vec<Key>,
    /// Safe columns that were recreated or changed type: back to Pending.
    resets: Vec<Key>,
    /// New Pending classifications.
    suggestions: HashMap<Key, (Category, String)>,
    /// Indexes into the catalog of the columns to sample.
    sample: Vec<usize>,
}

fn plan_scan(
    current: &[CatalogColumn],
    prev: &HashMap<Key, ScannedColumn>,
    existing: &HashMap<Key, ClassificationStatus>,
) -> ScanPlan {
    let mut plan = ScanPlan::default();
    let by_key: HashMap<Key, &CatalogColumn> = current.iter().map(|c| (c.key(), c)).collect();
    let by_pos: HashMap<(i32, i16), &CatalogColumn> =
        current.iter().map(|c| ((c.table_oid, c.attnum), c)).collect();

    let mut classified: HashSet<Key> = HashSet::new();
    for (k, status) in existing {
        if let Some(c) = by_key.get(k) {
            classified.insert(k.clone());
            let changed = prev.get(k).is_some_and(|p| {
                (p.table_oid, p.attnum, p.type_oid) != (c.table_oid, c.attnum, c.type_oid)
            });
            if *status == ClassificationStatus::Safe && changed {
                plan.resets.push(k.clone());
            }
            continue;
        }
        // Gone under this name. Same `(table_oid, attnum)` under a new name
        // is a rename (of the column, its table, or its schema).
        let renamed = prev
            .get(k)
            .and_then(|p| by_pos.get(&(p.table_oid, p.attnum)))
            .map(|c| c.key())
            .filter(|nk| !existing.contains_key(nk) && !classified.contains(nk));
        match renamed {
            Some(nk) => {
                classified.insert(nk.clone());
                plan.moves.push((k.clone(), nk));
            }
            None => plan.stale.push(k.clone()),
        }
    }

    for (i, c) in current.iter().enumerate() {
        let k = c.key();
        let already = classified.contains(&k);
        let suggestion = if already {
            None
        } else {
            classify_column(&c.column, c.comment.as_deref())
                .or_else(|| c.text_like.then(|| (Category::Pii, UNREVIEWED_REASON.to_string())))
        };
        // Sample a column not yet sampled at its current identity, when its
        // values could change the outcome: a text column only the type rule
        // caught (to say what it holds), or a wide number nothing caught (to
        // find card numbers). Views aren't sampled; they inherit instead.
        let fresh = prev.get(&k).is_none_or(|p| {
            !p.sampled || (p.table_oid, p.attnum, p.type_oid) != (c.table_oid, c.attnum, c.type_oid)
        });
        let worth = match &suggestion {
            Some((_, reason)) => reason == UNREVIEWED_REASON,
            None => !already && c.number_like && !c.generated_key,
        };
        if fresh && worth && c.readable && c.relkind != 'v' {
            plan.sample.push(i);
        }
        if let Some(s) = suggestion {
            plan.suggestions.insert(k, s);
        }
    }
    plan
}

/// Run the classifier against `conn`'s live schema. Idempotent: it never
/// overrides a stored classification, only adds Pending ones, carries
/// classifications across renames, drops ones whose column is gone, and
/// sends a recreated Safe column back to review.
///
/// Returns counts so the UI can decide whether to show the post-connect toast.
pub async fn classify_schema(core: &Core, conn: &str) -> Result<ClassifyOutcome> {
    let started = Instant::now();
    let r = async {
        let _scan = core.scans.lock.lock().await;
        let pool = core.pool(conn).await?;
        let current = read_catalog(&pool).await?;

        // Connection id is required for the FK in sensitivity_classifications.
        let connection = connections::get(&core.meta, conn).await?;
        let existing = connections::list_classifications(&core.meta, &connection.id).await?;
        let prev: HashMap<Key, ScannedColumn> =
            connections::list_scanned(&core.meta, &connection.id)
                .await?
                .into_iter()
                .map(|c| ((c.schema.clone(), c.table.clone(), c.column.clone()), c))
                .collect();
        let statuses: HashMap<Key, ClassificationStatus> =
            existing.iter().map(|c| (key_of(c), c.status)).collect();
        let mut plan = plan_scan(&current, &prev, &statuses);

        // Sampled values sharpen a type-rule suggestion, or flag a number
        // column of card numbers.
        let tallies = sample_columns(&pool, &current, &plan.sample).await;
        for (i, tally) in &tallies {
            let k = current[*i].key();
            let refined = match plan.suggestions.get(&k) {
                Some((_, reason)) if reason == UNREVIEWED_REASON => text_suggestion(tally),
                Some(_) => None,
                None => number_suggestion(tally),
            };
            if let Some(s) = refined {
                plan.suggestions.insert(k, s);
            }
        }

        inherit_into_views(&pool, &current, &existing, &mut plan).await?;

        let id = &connection.id;
        for (from, to) in &plan.moves {
            connections::rename_classification(
                &core.meta,
                id,
                (&from.0, &from.1, &from.2),
                (&to.0, &to.1, &to.2),
            )
            .await?;
        }
        for (schema, table, column) in &plan.stale {
            connections::delete_classification(&core.meta, id, schema, table, column).await?;
        }
        for (schema, table, column) in &plan.resets {
            connections::set_classification_pending(
                &core.meta,
                id,
                schema,
                table,
                column,
                RECREATED_REASON,
            )
            .await?;
        }
        for ((schema, table, column), (category, reason)) in &plan.suggestions {
            connections::insert_classification(
                &core.meta,
                id,
                schema,
                table,
                column,
                *category,
                ClassificationStatus::Pending,
                reason,
            )
            .await?;
        }

        // Record what this scan saw. A column queued for sampling whose read
        // didn't finish stays unsampled, so the next scan tries again.
        let mut changed = Vec::new();
        for (i, c) in current.iter().enumerate() {
            let rec = ScannedColumn {
                schema: c.schema.clone(),
                table: c.table.clone(),
                column: c.column.clone(),
                table_oid: c.table_oid,
                attnum: c.attnum,
                type_oid: c.type_oid,
                sampled: !plan.sample.contains(&i) || tallies.contains_key(&i),
            };
            if prev.get(&c.key()) != Some(&rec) {
                changed.push(rec);
            }
        }
        let current_keys: HashSet<Key> = current.iter().map(CatalogColumn::key).collect();
        let removed: Vec<Key> =
            prev.keys().filter(|k| !current_keys.contains(*k)).cloned().collect();
        connections::update_scanned(&core.meta, id, &changed, &removed).await?;

        // Ensure the per-connection redaction secret exists. Generated on first
        // classify; reused forever. Same connection across sessions → stable
        // mapping.
        connections::ensure_redaction_secret(&connection.name)?;

        // Only now is the pool safe to hand to an agent. Drop any redactor
        // view cached before this scan so the new classifications apply.
        core.redactor_cache.invalidate(conn).await;
        core.scans
            .seen
            .lock()
            .await
            .insert(conn.to_string(), Arc::new(current.iter().map(CatalogColumn::identity).collect()));
        core.pools.mark_classified(conn).await;

        let already_classified = (existing.len() - plan.stale.len()) as u32;
        let new_pending = plan.suggestions.len() as u32;
        Ok::<_, anyhow::Error>(ClassifyOutcome {
            new_pending,
            already_classified,
            total_classified: already_classified + new_pending,
        })
    }
    .await;
    core.record_ok("classify_schema", conn, started, &r);
    r
}

// ── Inheritance ─────────────────────────────────────────────────────

/// Classify the columns of views and materialized views whose definitions
/// read classified columns. Runs after the base suggestions are known, and
/// repeats so a view over such a view inherits too. Adds to `plan.suggestions`.
async fn inherit_into_views(
    pool: &PgPool,
    current: &[CatalogColumn],
    existing: &[Classification],
    plan: &mut ScanPlan,
) -> Result<()> {
    let mut views: BTreeMap<i32, (String, String, Vec<String>)> = BTreeMap::new();
    for c in current.iter().filter(|c| matches!(c.relkind, 'v' | 'm')) {
        views
            .entry(c.table_oid)
            .or_insert_with(|| (c.schema.clone(), c.table.clone(), Vec::new()))
            .2
            .push(c.column.clone());
    }
    if views.is_empty() {
        return Ok(());
    }
    let defs = view_definitions(pool, views.keys().copied().collect()).await;

    // Columns that will redact after this scan: stored ones (minus stale and
    // Safe, following renames) plus the new suggestions.
    let moved: HashMap<&Key, &Key> = plan.moves.iter().map(|(a, b)| (a, b)).collect();
    let mut taken: HashSet<Key> = HashSet::new();
    let mut by_name: HashMap<String, HashSet<String>> = HashMap::new();
    let mut category: HashMap<String, Category> = HashMap::new();
    fn redacts(
        k: &Key,
        cat: Category,
        by_name: &mut HashMap<String, HashSet<String>>,
        category: &mut HashMap<String, Category>,
    ) {
        by_name.entry(k.1.to_ascii_lowercase()).or_default().insert(k.2.to_ascii_lowercase());
        category.entry(k.2.to_ascii_lowercase()).or_insert(cat);
    }
    for c in existing {
        let k = key_of(c);
        if plan.stale.contains(&k) {
            continue;
        }
        let k = moved.get(&k).map_or(k.clone(), |nk| (*nk).clone());
        if c.status != ClassificationStatus::Safe || plan.resets.contains(&k) {
            redacts(&k, c.category, &mut by_name, &mut category);
        }
        taken.insert(k);
    }
    for (k, (cat, _)) in &plan.suggestions {
        redacts(k, *cat, &mut by_name, &mut category);
        taken.insert(k.clone());
    }

    for _ in 0..VIEW_PASSES {
        let view = RedactorView {
            by_oid: Arc::new(HashMap::new()),
            by_name: Arc::new(by_name.clone()),
            secret: Arc::new([0u8; 32]),
        };
        let mut added = Vec::new();
        for (oid, def) in &defs {
            let Some((schema, table, cols)) = views.get(oid) else {
                continue;
            };
            let lineage = match def {
                Some(def) => lineage::definition_lineage(def, &view),
                None => StoredLineage::Opaque,
            };
            let flags = match lineage {
                StoredLineage::Clean => continue,
                StoredLineage::Columns(v) if v.len() == cols.len() => v,
                _ => vec![StoredColumn::Derived; cols.len()],
            };
            for (col, flag) in cols.iter().zip(flags) {
                let k = (schema.clone(), table.clone(), col.clone());
                if taken.contains(&k) {
                    continue;
                }
                let s = match flag {
                    StoredColumn::Clean => continue,
                    StoredColumn::Copy(src) => (
                        category.get(&src).copied().unwrap_or(Category::Pii),
                        format!("view copies classified column \"{src}\""),
                    ),
                    StoredColumn::Derived => {
                        (Category::Pii, "view derives it from classified data".to_string())
                    }
                };
                taken.insert(k.clone());
                added.push((k, s));
            }
        }
        if added.is_empty() {
            break;
        }
        for (k, s) in added {
            redacts(&k, s.0, &mut by_name, &mut category);
            plan.suggestions.insert(k, s);
        }
    }
    Ok(())
}

/// Each view's definition, keyed by oid. `None` means it couldn't be read, so
/// the caller treats the view as opaque. A view dropped since the catalog read
/// is left out, and so is its error: `pg_get_viewdef` fails the whole batch
/// when a view goes away mid-read, so that falls back to one read per view.
async fn view_definitions(pool: &PgPool, oids: Vec<i32>) -> Vec<(i32, Option<String>)> {
    const ONE: &str = "SELECT pg_get_viewdef(c.oid) FROM pg_class c WHERE c.oid::int = $1";
    let batch: std::result::Result<Vec<(i32, Option<String>)>, _> = sqlx::query_as(
        "SELECT c.oid::int, pg_get_viewdef(c.oid) FROM pg_class c WHERE c.oid::int = ANY($1)",
    )
    .bind(&oids)
    .fetch_all(pool)
    .await;
    if let Ok(defs) = batch {
        return defs.into_iter().filter(|(_, d)| d.is_some()).collect();
    }
    let mut out = Vec::with_capacity(oids.len());
    for oid in oids {
        match sqlx::query_scalar::<_, Option<String>>(ONE).bind(oid).fetch_optional(pool).await {
            Ok(Some(Some(def))) => out.push((oid, Some(def))),
            Ok(_) => {}
            Err(_) => out.push((oid, None)),
        }
    }
    out
}

/// After a write that stores query output (`CREATE TABLE … AS`, `SELECT …
/// INTO`, `INSERT … SELECT`, `UPDATE … SET`), classify the target columns that
/// now hold classified values, so a later read of the copy is redacted. A
/// target column the human marked Safe goes back to Pending. Runs on both
/// paths: a copy the human makes is just as readable by an agent later.
///
/// Not covered: a temporary table, which only the pooled connection that
/// created it can see, so the target can't be resolved here.
pub(super) async fn inherit_from_write(
    core: &Core,
    conn: &str,
    pool: &PgPool,
    sql: &str,
) -> Result<()> {
    let lower = sql.to_ascii_lowercase();
    if !["insert", "update", "create", "into"].iter().any(|k| lower.contains(k)) {
        return Ok(());
    }
    let connection = connections::get(&core.meta, conn).await?;
    let Some(view) = core
        .redactor_cache
        .view_for(&core.meta, pool, conn, &connection.id)
        .await?
    else {
        return Ok(());
    };
    let Some(write) = lineage::stored_write(sql, &view) else {
        return Ok(());
    };
    if write.lineage == StoredLineage::Clean {
        return Ok(());
    }
    let rows = sqlx::query(
        r#"SELECT n.nspname AS schema, c.relname AS table, a.attname AS column
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
           WHERE c.oid = to_regclass($1)
           ORDER BY a.attnum"#,
    )
    .bind(&write.target)
    .fetch_all(pool)
    .await
    .with_context(|| "resolve write target")?;
    let Some(first) = rows.first() else {
        return Ok(());
    };
    let (schema, table): (String, String) = (first.get("schema"), first.get("table"));
    let columns = match write.columns {
        Some(c) => c,
        None => rows.iter().map(|r| r.get("column")).collect(),
    };
    let flags = match write.lineage {
        StoredLineage::Columns(v) if v.len() == columns.len() => v,
        _ => vec![StoredColumn::Derived; columns.len()],
    };

    let existing = connections::list_classifications(&core.meta, &connection.id).await?;
    let mut changed = false;
    for (column, flag) in columns.into_iter().zip(flags) {
        let (category, reason) = match flag {
            StoredColumn::Clean => continue,
            StoredColumn::Copy(src) => (
                existing
                    .iter()
                    .find(|c| {
                        c.status != ClassificationStatus::Safe
                            && c.column.eq_ignore_ascii_case(&src)
                    })
                    .map_or(Category::Pii, |c| c.category),
                format!("a write copied classified column \"{src}\" into it"),
            ),
            StoredColumn::Derived => {
                (Category::Pii, "a write copied classified data into it".to_string())
            }
        };
        let k = (schema.clone(), table.clone(), column);
        match existing.iter().find(|c| key_of(c) == k).map(|c| c.status) {
            None => {
                connections::insert_classification(
                    &core.meta,
                    &connection.id,
                    &k.0,
                    &k.1,
                    &k.2,
                    category,
                    ClassificationStatus::Pending,
                    &reason,
                )
                .await?
            }
            Some(ClassificationStatus::Safe) => {
                connections::set_classification_pending(
                    &core.meta,
                    &connection.id,
                    &k.0,
                    &k.1,
                    &k.2,
                    &reason,
                )
                .await?
            }
            Some(_) => continue,
        }
        changed = true;
    }
    if changed {
        core.redactor_cache.invalidate(conn).await;
    }
    Ok(())
}

// ── Schema drift on the agent path ──────────────────────────────────

/// The current columns of the relations named in an agent's SQL.
const DRIFT_SQL: &str = r#"
    SELECT n.nspname AS schema, c.relname AS table, a.attname AS column,
           c.oid::int AS table_oid, a.attnum AS attnum, a.atttypid::int AS type_oid
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    WHERE lower(c.relname) = ANY($1)
      AND c.relkind IN ('r','p','v','m','f')
      AND n.nspname NOT IN ('information_schema','pg_catalog','pg_toast')
      AND n.nspname NOT LIKE 'pg_temp_%'
      AND n.nspname NOT LIKE 'pg_toast_temp_%'
"#;

/// Before an agent's SQL runs, rescan if it names a relation whose columns
/// changed since the last scan: a new table or view, a new column, a rename,
/// a type change. Otherwise the agent could read a column the classifier has
/// never seen. Covers changes made outside the workbench too (a deploy's
/// migration, psql). The human path skips it. SQL that doesn't parse names no
/// relations here; lineage's text fallbacks handle it.
pub(super) async fn ensure_scan_current(
    core: &Core,
    conn: &str,
    pool: &PgPool,
    sql: &str,
) -> Result<()> {
    if !matches!(core.pool_access, PoolAccess::Agent) {
        return Ok(());
    }
    let names: Vec<String> = lineage::relation_names(sql).into_iter().collect();
    if names.is_empty() {
        return Ok(());
    }
    let rows = sqlx::query(DRIFT_SQL)
        .bind(&names)
        .fetch_all(pool)
        .await
        .with_context(|| "check for schema changes")?;
    let seen = core.scans.seen.lock().await.get(conn).cloned();
    let drifted = rows.iter().any(|r| {
        let id: ColumnIdentity = (
            r.get("table_oid"),
            r.get("attnum"),
            r.get("type_oid"),
            r.get("schema"),
            r.get("table"),
            r.get("column"),
        );
        seen.as_ref().is_none_or(|s| !s.contains(&id))
    });
    if drifted {
        classify_schema(core, conn)
            .await
            .with_context(|| "the schema changed since the last sensitivity scan, and the rescan failed")?;
    }
    Ok(())
}

// ── Value sampling ──────────────────────────────────────────────────

/// Detector hits over one column's sampled values.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
struct Tally {
    non_null: u32,
    card: u32,
    ssn: u32,
    email: u32,
    phone: u32,
}

impl Tally {
    fn add(&mut self, value: &str) {
        self.non_null += 1;
        // Long free text: the first 4 KiB is plenty to spot an identifier.
        let v = match value.char_indices().nth(4096) {
            Some((i, _)) => &value[..i],
            None => value,
        }
        .trim();
        if is_card_number(v) {
            self.card += 1;
        } else if contains_ssn(v) {
            self.ssn += 1;
        } else if contains_email(v) {
            self.email += 1;
        } else if is_phone(v) {
            self.phone += 1;
        }
    }
}

/// A sharper suggestion for a text column the type rule caught, from what its
/// values hold. Any hit counts: the column redacts either way.
fn text_suggestion(t: &Tally) -> Option<(Category, String)> {
    let (category, what, n) = if t.card > 0 {
        (Category::Pci, "card numbers", t.card)
    } else if t.ssn > 0 {
        (Category::Pii, "SSNs", t.ssn)
    } else if t.email > 0 {
        (Category::Pii, "email addresses", t.email)
    } else if t.phone > 0 {
        (Category::Pii, "phone numbers", t.phone)
    } else {
        return None;
    };
    Some((category, format!("sampled values include {what} ({n} of {})", t.non_null)))
}

/// A number column is classified only when most sampled values are
/// Luhn-valid card numbers: one random 16-digit id in ten passes Luhn.
fn number_suggestion(t: &Tally) -> Option<(Category, String)> {
    (t.non_null > 0 && t.card * 5 >= t.non_null * 4).then(|| {
        (
            Category::Pci,
            format!("sampled values look like card numbers ({} of {})", t.card, t.non_null),
        )
    })
}

/// Sample the catalog columns at `targets`, one read per relation. Returns a
/// tally per column whose relation was read. A relation that errors, times
/// out, or isn't reached within [`SAMPLE_BUDGET`] is left out.
async fn sample_columns(
    pool: &PgPool,
    current: &[CatalogColumn],
    targets: &[usize],
) -> HashMap<usize, Tally> {
    let mut by_relation: BTreeMap<i32, Vec<usize>> = BTreeMap::new();
    for &i in targets {
        by_relation.entry(current[i].table_oid).or_default().push(i);
    }
    let mut out = HashMap::new();
    let reads = stream::iter(by_relation.into_values())
        .map(|idxs| async move {
            let rel = &current[idxs[0]];
            let cols: Vec<&str> = idxs.iter().map(|&i| current[i].column.as_str()).collect();
            let r = sample_relation(pool, &rel.schema, &rel.table, &cols).await;
            (idxs, r)
        })
        .buffer_unordered(SAMPLE_CONCURRENCY);
    let collect = async {
        let mut reads = std::pin::pin!(reads);
        while let Some((idxs, r)) = reads.next().await {
            match r {
                Ok(tallies) => out.extend(idxs.into_iter().zip(tallies)),
                Err(e) => {
                    let rel = &current[idxs[0]];
                    tracing::warn!(relation = %format!("{}.{}", rel.schema, rel.table), error = %e,
                        "sensitivity sample failed; retrying next scan");
                }
            }
        }
    };
    if tokio::time::timeout(SAMPLE_BUDGET, collect).await.is_err() {
        tracing::warn!("sensitivity sampling ran out of time; the rest is sampled next scan");
    }
    out
}

/// Read up to [`SAMPLE_ROWS`] rows of `columns` from one relation, in a
/// read-only transaction under a short statement timeout. The values never
/// leave this function: only detector tallies do.
async fn sample_relation(
    pool: &PgPool,
    schema: &str,
    table: &str,
    columns: &[&str],
) -> Result<Vec<Tally>> {
    let list: Vec<String> = columns.iter().map(|c| format!("{}::text", quote_ident(c))).collect();
    let sql = format!(
        "SELECT {} FROM {}.{} LIMIT {SAMPLE_ROWS}",
        list.join(", "),
        quote_ident(schema),
        quote_ident(table)
    );
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION READ ONLY").execute(&mut *tx).await?;
    sqlx::query(&format!("SET LOCAL statement_timeout = {SAMPLE_TIMEOUT_MS}"))
        .execute(&mut *tx)
        .await?;
    let rows = sqlx::query(&sql).persistent(false).fetch_all(&mut *tx).await?;
    tx.rollback().await?;
    let mut tallies = vec![Tally::default(); columns.len()];
    for row in &rows {
        for (i, t) in tallies.iter_mut().enumerate() {
            if let Some(v) = row.try_get::<Option<String>, _>(i)? {
                t.add(&v);
            }
        }
    }
    Ok(tallies)
}

/// 13–19 digits, optionally grouped by spaces or dashes, passing Luhn.
fn is_card_number(v: &str) -> bool {
    if v.len() > 23 {
        return false;
    }
    let mut digits = Vec::with_capacity(19);
    for ch in v.chars() {
        match ch {
            '0'..='9' => digits.push(ch as u32 - '0' as u32),
            ' ' | '-' => {}
            _ => return false,
        }
    }
    if !(13..=19).contains(&digits.len()) {
        return false;
    }
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, &d)| match (i % 2, d * 2) {
            (1, x) if x > 9 => x - 9,
            (1, x) => x,
            _ => d,
        })
        .sum();
    sum % 10 == 0
}

/// `ddd-dd-dddd` anywhere, not inside a longer run of digits and dashes.
fn contains_ssn(v: &str) -> bool {
    let b = v.as_bytes();
    let edge = |c: u8| c.is_ascii_digit() || c == b'-';
    b.len() >= 11
        && (0..=b.len() - 11).any(|i| {
            let shape = b[i..i + 11].iter().enumerate().all(|(j, &c)| {
                if j == 3 || j == 6 {
                    c == b'-'
                } else {
                    c.is_ascii_digit()
                }
            });
            shape && (i == 0 || !edge(b[i - 1])) && (i + 11 == b.len() || !edge(b[i + 11]))
        })
}

/// `local@domain.tld` anywhere.
fn contains_email(v: &str) -> bool {
    let b = v.as_bytes();
    let local = |c: u8| c.is_ascii_alphanumeric() || b"._%+-".contains(&c);
    b.iter().enumerate().any(|(i, &c)| {
        if c != b'@' || i == 0 || !local(b[i - 1]) {
            return false;
        }
        let domain: Vec<u8> = b[i + 1..]
            .iter()
            .take_while(|&&c| c.is_ascii_alphanumeric() || c == b'.' || c == b'-')
            .copied()
            .collect();
        let domain = domain.strip_suffix(b".").unwrap_or(&domain);
        let tld = domain.rsplit(|&c| c == b'.').next().unwrap_or_default();
        domain.contains(&b'.') && tld.len() >= 2 && tld.iter().all(u8::is_ascii_alphabetic)
    })
}

/// A whole value shaped like a phone number: 10–15 digits with separators or
/// a leading `+`, so a bare id or a date doesn't count.
fn is_phone(v: &str) -> bool {
    if v.len() > 24 {
        return false;
    }
    let mut digits = 0;
    let mut separated = v.starts_with('+');
    for ch in v.chars() {
        match ch {
            '0'..='9' => digits += 1,
            ' ' | '(' | ')' | '-' | '.' => separated = true,
            '+' => {}
            _ => return false,
        }
    }
    (10..=15).contains(&digits) && separated
}

pub async fn list_classifications(core: &Core, conn: &str) -> Result<Vec<Classification>> {
    let started = Instant::now();
    let r = async {
        let connection = connections::get(&core.meta, conn).await?;
        connections::list_classifications(&core.meta, &connection.id).await
    }
    .await;
    core.record_ok("list_classifications", conn, started, &r);
    r
}

pub async fn update_classification(
    core: &Core,
    conn: &str,
    schema: &str,
    table: &str,
    column: &str,
    action: ClassificationAction,
) -> Result<()> {
    let started = Instant::now();
    let detail = format!("{conn}/{schema}.{table}.{column}");
    let r = async {
        let connection = connections::get(&core.meta, conn).await?;
        match action {
            ClassificationAction::Confirm => {
                connections::set_classification_status(
                    &core.meta,
                    &connection.id,
                    schema,
                    table,
                    column,
                    ClassificationStatus::Confirmed,
                )
                .await?;
            }
            ClassificationAction::MarkSafe => {
                connections::set_classification_status(
                    &core.meta,
                    &connection.id,
                    schema,
                    table,
                    column,
                    ClassificationStatus::Safe,
                )
                .await?;
            }
            ClassificationAction::SetCategory { category } => {
                connections::set_classification_category(
                    &core.meta,
                    &connection.id,
                    schema,
                    table,
                    column,
                    category,
                )
                .await?;
            }
            ClassificationAction::AddManual { category } => {
                connections::insert_classification(
                    &core.meta,
                    &connection.id,
                    schema,
                    table,
                    column,
                    category,
                    ClassificationStatus::Confirmed,
                    "manual",
                )
                .await
                .with_context(|| "manual classification insert")?;
                connections::ensure_redaction_secret(&connection.name)?;
            }
        }
        // Drop the redactor cache for this connection so the next query
        // picks up the change.
        core.redactor_cache.invalidate(&connection.name).await;
        Ok::<_, anyhow::Error>(())
    }
    .await;
    core.record_ok("update_classification", detail, started, &r);
    r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_pattern_matches() {
        assert_eq!(
            classify_column("email", None).map(|x| x.0),
            Some(Category::Pii)
        );
        assert_eq!(
            classify_column("user_email_address", None).map(|x| x.0),
            Some(Category::Pii)
        );
        assert_eq!(
            classify_column("card_number", None).map(|x| x.0),
            Some(Category::Pci)
        );
        assert_eq!(
            classify_column("patient_diagnosis", None).map(|x| x.0),
            Some(Category::Phi)
        );
    }

    #[test]
    fn name_pattern_case_insensitive() {
        assert_eq!(
            classify_column("FIRST_NAME", None).map(|x| x.0),
            Some(Category::Pii)
        );
    }

    #[test]
    fn no_match_returns_none() {
        assert!(classify_column("id", None).is_none());
        assert!(classify_column("created_at", None).is_none());
        assert!(classify_column("status", None).is_none());
    }

    #[test]
    fn comment_overrides_name() {
        let (cat, reason) = classify_column("notes", Some("contains PHI per legal")).unwrap();
        assert_eq!(cat, Category::Phi);
        assert!(reason.contains("COMMENT"));
    }

    #[test]
    fn comment_sensitive_keyword_maps_to_pii() {
        let (cat, _) = classify_column("freeform", Some("sensitive customer data")).unwrap();
        assert_eq!(cat, Category::Pii);
    }

    const TEXT: i32 = 25;
    const INT8: i32 = 20;

    fn col(table: &str, column: &str, oid: i32, attnum: i16, type_oid: i32) -> CatalogColumn {
        CatalogColumn {
            schema: "public".into(),
            table: table.into(),
            column: column.into(),
            table_oid: oid,
            attnum,
            type_oid,
            relkind: 'r',
            comment: None,
            text_like: type_oid == TEXT,
            number_like: type_oid == INT8,
            generated_key: false,
            readable: true,
        }
    }

    fn k(table: &str, column: &str) -> Key {
        ("public".into(), table.into(), column.into())
    }

    fn scanned(c: &CatalogColumn, sampled: bool) -> (Key, ScannedColumn) {
        (
            c.key(),
            ScannedColumn {
                schema: c.schema.clone(),
                table: c.table.clone(),
                column: c.column.clone(),
                table_oid: c.table_oid,
                attnum: c.attnum,
                type_oid: c.type_oid,
                sampled,
            },
        )
    }

    #[test]
    fn unreviewed_text_redacts_and_is_sampled() {
        let mut view_col = col("v_notes", "body", 20, 1, TEXT);
        view_col.relkind = 'v';
        let mut hidden = col("appointments", "private", 10, 4, TEXT);
        hidden.readable = false;
        let mut serial = col("appointments", "seq", 10, 5, INT8);
        serial.generated_key = true;
        let current = vec![
            col("appointments", "id", 10, 1, 23),
            col("appointments", "notes", 10, 2, TEXT),
            col("appointments", "email", 10, 3, TEXT),
            hidden,
            serial,
            col("appointments", "amount", 10, 6, INT8),
            view_col,
        ];
        let plan = plan_scan(&current, &HashMap::new(), &HashMap::new());

        assert_eq!(plan.suggestions[&k("appointments", "notes")].1, UNREVIEWED_REASON);
        assert_eq!(plan.suggestions[&k("appointments", "email")].1, "matched \"email\"");
        assert_eq!(plan.suggestions[&k("appointments", "private")].1, UNREVIEWED_REASON);
        assert_eq!(plan.suggestions[&k("v_notes", "body")].1, UNREVIEWED_REASON);
        assert!(!plan.suggestions.contains_key(&k("appointments", "id")));
        assert!(!plan.suggestions.contains_key(&k("appointments", "amount")));

        // Sampled: the type-rule text column and the wide number. Not the name
        // match, the unreadable column, the serial, or the view.
        let sampled: Vec<&str> = plan.sample.iter().map(|&i| current[i].column.as_str()).collect();
        assert_eq!(sampled, vec!["notes", "amount"]);
    }

    #[test]
    fn sampled_columns_are_not_sampled_again() {
        let current = vec![col("orders", "amount", 10, 2, INT8)];
        let prev: HashMap<Key, ScannedColumn> = [scanned(&current[0], true)].into();
        assert!(plan_scan(&current, &prev, &HashMap::new()).sample.is_empty());
        // Unless the column changed identity.
        let retyped = vec![col("orders", "amount", 10, 2, 1700)];
        let mut retyped_num = retyped.clone();
        retyped_num[0].number_like = true;
        assert_eq!(plan_scan(&retyped_num, &prev, &HashMap::new()).sample, vec![0]);
    }

    #[test]
    fn renames_carry_classifications_and_drops_go_stale() {
        let before = col("patients", "ssn", 10, 2, TEXT);
        let gone = col("patients", "old_phone", 10, 3, TEXT);
        let prev: HashMap<Key, ScannedColumn> =
            [scanned(&before, true), scanned(&gone, true)].into();
        let existing: HashMap<Key, ClassificationStatus> = [
            (k("patients", "ssn"), ClassificationStatus::Confirmed),
            (k("patients", "old_phone"), ClassificationStatus::Pending),
        ]
        .into();
        // `ssn` renamed to `tax_id` (same oid/attnum); `old_phone` dropped.
        let current = vec![col("patients", "tax_id", 10, 2, TEXT)];
        let plan = plan_scan(&current, &prev, &existing);
        assert_eq!(plan.moves, vec![(k("patients", "ssn"), k("patients", "tax_id"))]);
        assert_eq!(plan.stale, vec![k("patients", "old_phone")]);
        // The moved classification covers it; no new suggestion or sample.
        assert!(plan.suggestions.is_empty());
        assert!(plan.sample.is_empty());
    }

    #[test]
    fn safe_columns_stay_safe_until_recreated() {
        let notes = col("leads", "notes", 10, 2, TEXT);
        let prev: HashMap<Key, ScannedColumn> = [scanned(&notes, true)].into();
        let existing: HashMap<Key, ClassificationStatus> =
            [(k("leads", "notes"), ClassificationStatus::Safe)].into();

        let plan = plan_scan(std::slice::from_ref(&notes), &prev, &existing);
        assert!(plan.resets.is_empty() && plan.suggestions.is_empty());

        // Table dropped and recreated: new oid, same names.
        let recreated = col("leads", "notes", 11, 2, TEXT);
        let plan = plan_scan(&[recreated], &prev, &existing);
        assert_eq!(plan.resets, vec![k("leads", "notes")]);
    }

    #[test]
    fn detectors_spot_identifiers() {
        assert!(is_card_number("4111 1111 1111 1111"));
        assert!(is_card_number("4242424242424242"));
        assert!(!is_card_number("4111111111111112"));
        assert!(!is_card_number("1234"));

        assert!(contains_ssn("SSN 123-45-6789 on file"));
        assert!(contains_ssn("123-45-6789"));
        assert!(!contains_ssn("1123-45-67890"));
        assert!(!contains_ssn("123-45-678"));

        assert!(contains_email("reach me at jane.doe+x@mail.example.org."));
        assert!(!contains_email("a@b"));
        assert!(!contains_email("@example.com"));

        assert!(is_phone("(555) 123-4567"));
        assert!(is_phone("+15551234567"));
        assert!(!is_phone("5551234567"));
        assert!(!is_phone("2024-01-15"));
        assert!(!is_phone("123-45-6789"));
    }

    #[test]
    fn suggestions_from_tallies() {
        let mut t = Tally::default();
        for v in ["see notes", "called 555-123-4567", "jane@example.com", "SSN 123-45-6789"] {
            t.add(v);
        }
        // Phone needs the whole value, so only SSN and email hit; SSN wins.
        let (cat, reason) = text_suggestion(&t).unwrap();
        assert_eq!(cat, Category::Pii);
        assert_eq!(reason, "sampled values include SSNs (1 of 4)");
        assert_eq!(text_suggestion(&Tally { non_null: 3, ..Tally::default() }), None);

        let mut cards = Tally::default();
        for v in ["4111111111111111", "4242424242424242", "5555555555554444", "1000000000000001"] {
            cards.add(v);
        }
        assert_eq!(number_suggestion(&cards).map(|s| s.0), None, "3 of 4 is under 80%");
        cards.add("378282246310005");
        assert_eq!(number_suggestion(&cards).map(|s| s.0), Some(Category::Pci));
    }
}
