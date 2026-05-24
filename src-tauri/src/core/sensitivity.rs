//! Sensitivity classifications (PHI / PCI / PII) per connection.
//!
//! See design/redaction.md. This module owns:
//!  - the heuristic classifier (column-name + COMMENT-driven)
//!  - CRUD over classifications stored in the metadata SQLite
//!  - resolution of `(schema, table, column)` → Postgres `(table_oid, attnum)`
//!    so the redactor can match result columns to classifications precisely.
//!
//! The MCP server can call `list_classifications` and `classify_schema`
//! (read-only-ish; classify is idempotent and only adds Pending suggestions
//! — never auto-confirms). The mask toggle does NOT live here — see core::query.

use anyhow::{Context, Result};
use sqlx::Row;
use std::time::Instant;

use crate::connections;
use crate::types::{
    Category, Classification, ClassificationAction, ClassificationStatus, ClassifyOutcome,
};

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

// ── Public entry points ─────────────────────────────────────────────

/// Run the heuristic classifier against `conn`'s live schema. Idempotent:
/// only inserts NEW pending classifications; never touches existing entries.
///
/// Returns counts so the UI can decide whether to show the post-connect toast.
pub async fn classify_schema(core: &Core, conn: &str) -> Result<ClassifyOutcome> {
    let started = Instant::now();
    let r = async {
        let pool = core.pools.ensure(&core.meta, conn).await?;
        // Pull every column + its COMMENT, excluding system schemas.
        let rows = sqlx::query(
            r#"
            SELECT
                c.table_schema AS schema,
                c.table_name   AS table,
                c.column_name  AS column,
                col_description(
                    (quote_ident(c.table_schema) || '.' || quote_ident(c.table_name))::regclass::oid,
                    c.ordinal_position
                ) AS comment
            FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_schema = c.table_schema AND t.table_name = c.table_name
            WHERE c.table_schema NOT IN ('information_schema','pg_catalog','pg_toast')
              AND c.table_schema NOT LIKE 'pg_temp_%'
              AND c.table_schema NOT LIKE 'pg_toast_temp_%'
              AND t.table_type IN ('BASE TABLE','VIEW')
            "#,
        )
        .fetch_all(&pool)
        .await
        .with_context(|| "schema scan failed")?;

        // Connection id is required for the FK in sensitivity_classifications.
        let connection = connections::get(&core.meta, conn).await?;

        let existing = connections::list_classifications(&core.meta, &connection.id).await?;
        let mut existing_keys: std::collections::HashSet<(String, String, String)> =
            existing
                .iter()
                .map(|c| (c.schema.clone(), c.table.clone(), c.column.clone()))
                .collect();
        let already_classified = existing.len() as u32;

        let mut new_pending: u32 = 0;
        for row in rows {
            let schema: String = row.get("schema");
            let table: String = row.get("table");
            let column: String = row.get("column");
            let comment: Option<String> = row.try_get("comment").ok().flatten();
            let key = (schema.clone(), table.clone(), column.clone());
            if existing_keys.contains(&key) {
                continue;
            }
            if let Some((category, reason)) = classify_column(&column, comment.as_deref()) {
                connections::insert_classification(
                    &core.meta,
                    &connection.id,
                    &schema,
                    &table,
                    &column,
                    category,
                    ClassificationStatus::Pending,
                    &reason,
                )
                .await?;
                existing_keys.insert(key);
                new_pending += 1;
            }
        }

        // Ensure the per-connection redaction secret exists. Generated on first
        // classify; reused forever. Same connection across sessions → stable
        // mapping.
        connections::ensure_redaction_secret(&connection.name)?;

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
            ClassificationAction::Remove => {
                connections::delete_classification(
                    &core.meta,
                    &connection.id,
                    schema,
                    table,
                    column,
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
}
