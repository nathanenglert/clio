//! Redaction lineage analysis.
//!
//! The redactor (see `core::redactor` + `core::query::run_decoded`) masks a
//! result column only when sqlx reports a trusted source column for it
//! (`relation_id` + `relation_attribute_no`). Postgres populates those *only*
//! for a bare column reference in the projection — `SELECT ssn FROM patients`.
//! The moment a classified column is wrapped in *any* expression, cast,
//! function, aggregate, or subquery, Postgres reports `0/0` and the redactor
//! never matches it, so the raw value flows out (the R2 bypass logged in
//! `docs/TASKS.md`, e.g. `SELECT ssn||'' FROM patients`, `SELECT to_jsonb(p)
//! FROM patients p`, `SELECT string_agg(ssn,',') FROM patients`).
//!
//! This module closes that gap with a lineage pass: parse the statement and
//! decide whether its *derived* (source-column-less) result columns may expose
//! a classified column. The decision is deliberately coarse — one verdict per
//! query — and **fails closed**: when the shape is beyond precise analysis
//! (subquery in FROM, CTE, set operation, unparseable) and a classified table
//! is in scope, every derived column is redacted. Bare-column and wildcard
//! result columns are unaffected here; they keep the precise per-column faker
//! path in `run_decoded`.
//!
//! Precision goal: an unrelated, non-sensitive derived column stays visible.
//! `SELECT count(*) FROM patients` and `SELECT avg(amount) FROM orders` (where
//! `amount` is not classified) are kept; only expressions that actually touch a
//! classified column/row are redacted.

use std::collections::HashSet;
use std::ops::ControlFlow;

use sqlparser::ast::{
    Expr, ObjectName, ObjectNamePart, Query, SelectItem, SetExpr, Statement, TableFactor,
    TableObject, TableWithJoins, Visit, Visitor,
};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;

use super::redactor::RedactorView;

/// Decide whether the *derived* result columns of `sql` (those Postgres does
/// not tag with a source column) must be redacted for a connection whose
/// classifications are described by `view`.
///
/// Returns `false` when no classified table is referenced, or when every
/// derived projection expression provably avoids classified columns. Returns
/// `true` when a derived expression references a classified column/row, or the
/// statement shape can't be analyzed precisely while a classified table is in
/// scope (fail-closed).
pub(super) fn should_redact_derived(sql: &str, view: &RedactorView) -> bool {
    let dialect = PostgreSqlDialect {};
    let stmts = match Parser::parse_sql(&dialect, sql) {
        Ok(s) => s,
        // Parser disagreement with Postgres shouldn't open a hole: if the raw
        // text mentions a classified table, redact derived columns; otherwise
        // there's nothing sensitive to protect.
        Err(_) => return sql_mentions_classified_table(sql, view),
    };

    // `run_decoded` executes a single statement; be conservative about anything
    // else (a semicolon-joined batch): redact if any classified table appears.
    if stmts.len() != 1 {
        return any_classified_relation(&stmts, view);
    }
    let stmt = &stmts[0];

    // Every table the statement touches (including write targets, which the
    // relation visitor misses for INSERT).
    let tables = statement_tables(stmt);

    // No classified table anywhere in the statement ⇒ derived columns cannot
    // expose sensitive data. This is what keeps redaction off entirely for
    // queries that don't touch a classified table.
    if !tables.iter().any(|t| view.by_name.contains_key(t)) {
        return false;
    }

    match stmt {
        Statement::Query(q) => query_exposes_sensitive(q, &tables, view),
        Statement::Insert(i) => returning_exposes_sensitive(stmt, &i.returning, &tables, view),
        Statement::Update(u) => returning_exposes_sensitive(stmt, &u.returning, &tables, view),
        Statement::Delete(d) => returning_exposes_sensitive(stmt, &d.returning, &tables, view),
        // DDL and other statements return no result rows to redact.
        _ => false,
    }
}

/// SELECT analysis. Fails closed on CTEs, set operations, and non-plain FROM
/// factors (subqueries/derived tables/table functions), because those surface
/// values whose lineage we can't trace to a projection expression.
fn query_exposes_sensitive(q: &Query, tables: &HashSet<String>, view: &RedactorView) -> bool {
    if q.with.is_some() {
        return true; // CTE — a `SELECT * FROM cte` can surface derived-sensitive cols.
    }
    let select = match q.body.as_ref() {
        SetExpr::Select(s) => s,
        // UNION/INTERSECT/EXCEPT, VALUES, wrapped queries, etc.
        _ => return true,
    };
    // A derived table in FROM (`FROM (SELECT ssn||'' …) x`) can expose sensitive
    // data through an outer `*`, which we can't attribute to a projection item.
    let from_has_non_plain_table = select.from.iter().any(|twj| {
        !is_plain_table(&twj.relation) || twj.joins.iter().any(|j| !is_plain_table(&j.relation))
    });
    if from_has_non_plain_table {
        return true;
    }

    let sources: Vec<&TableWithJoins> = select.from.iter().collect();
    let (sensitive_cols, sensitive_table_refs) = build_scope(tables, &sources, view);
    select
        .projection
        .iter()
        .filter_map(derived_expr)
        .any(|e| expr_is_sensitive(e, &sensitive_cols, &sensitive_table_refs))
}

/// `INSERT/UPDATE/DELETE … RETURNING <exprs>` analysis. Same lineage rule as a
/// SELECT projection, applied to the RETURNING list.
fn returning_exposes_sensitive(
    stmt: &Statement,
    returning: &Option<Vec<SelectItem>>,
    tables: &HashSet<String>,
    view: &RedactorView,
) -> bool {
    let Some(items) = returning else {
        return false; // no RETURNING ⇒ no result rows.
    };
    // Aliases resolved from the write's target/using/from tables where available.
    let sources = write_sources(stmt);
    let (sensitive_cols, sensitive_table_refs) = build_scope(tables, &sources, view);
    items
        .iter()
        .filter_map(derived_expr)
        .any(|e| expr_is_sensitive(e, &sensitive_cols, &sensitive_table_refs))
}

/// The projection item's expression, but only when it is a *derived* column —
/// i.e. not a bare column reference (handled precisely by the OID path) and not
/// a wildcard (which expands to bare, OID-tagged columns).
fn derived_expr(item: &SelectItem) -> Option<&Expr> {
    let e = match item {
        SelectItem::UnnamedExpr(e) => e,
        SelectItem::ExprWithAlias { expr, .. } => expr,
        SelectItem::ExprWithAliases { expr, .. } => expr,
        SelectItem::QualifiedWildcard(..) | SelectItem::Wildcard(..) => return None,
    };
    if is_bare_ref(unwrap_nested(e)) {
        None
    } else {
        Some(e)
    }
}

fn unwrap_nested(mut e: &Expr) -> &Expr {
    while let Expr::Nested(inner) = e {
        e = inner.as_ref();
    }
    e
}

fn is_bare_ref(e: &Expr) -> bool {
    matches!(e, Expr::Identifier(_) | Expr::CompoundIdentifier(_))
}

fn is_plain_table(tf: &TableFactor) -> bool {
    matches!(tf, TableFactor::Table { .. })
}

/// Build `(sensitive column names, sensitive table names+aliases)`. Column names
/// come from `tables` (every relation the statement touches); aliases of
/// classified tables are resolved from `alias_sources` (top-level FROM/target
/// factors) so a whole-row reference like `to_jsonb(p)` can be caught.
fn build_scope(
    tables: &HashSet<String>,
    alias_sources: &[&TableWithJoins],
    view: &RedactorView,
) -> (HashSet<String>, HashSet<String>) {
    let mut cols: HashSet<String> = HashSet::new();
    let mut table_refs: HashSet<String> = HashSet::new();

    for table in tables {
        if let Some(classified) = view.by_name.get(table) {
            cols.extend(classified.iter().cloned());
            table_refs.insert(table.clone());
        }
    }
    // Aliases of classified tables (e.g. `patients p` → add `p`).
    for twj in alias_sources {
        add_alias_if_classified(&twj.relation, view, &mut table_refs);
        for join in &twj.joins {
            add_alias_if_classified(&join.relation, view, &mut table_refs);
        }
    }
    (cols, table_refs)
}

fn add_alias_if_classified(tf: &TableFactor, view: &RedactorView, table_refs: &mut HashSet<String>) {
    if let TableFactor::Table { name, alias, .. } = tf {
        if let Some(t) = last_ident(name) {
            if view.by_name.contains_key(&t) {
                if let Some(a) = alias {
                    table_refs.insert(a.name.value.to_ascii_lowercase());
                }
            }
        }
    }
}

/// Every table name the statement references, lowercased. Uses the relation
/// visitor (which covers FROM/JOIN/subquery/CTE relations) plus the write
/// target the visitor misses (INSERT's `TableObject`).
fn statement_tables(stmt: &Statement) -> HashSet<String> {
    let mut tables = HashSet::new();
    let _ = sqlparser::ast::visit_relations(stmt, |name| {
        if let Some(t) = last_ident(name) {
            tables.insert(t);
        }
        ControlFlow::<()>::Continue(())
    });
    if let Statement::Insert(i) = stmt {
        if let TableObject::TableName(name) = &i.table {
            if let Some(t) = last_ident(name) {
                tables.insert(t);
            }
        }
    }
    tables
}

/// True when any table referenced anywhere in `v` is classified in `view`.
fn any_classified_relation<V: Visit>(v: &V, view: &RedactorView) -> bool {
    sqlparser::ast::visit_relations(v, |name| match last_ident(name) {
        Some(t) if view.by_name.contains_key(&t) => ControlFlow::Break(()),
        _ => ControlFlow::Continue(()),
    })
    .is_break()
}

/// Top-level table sources of a write, so aliases can be resolved for RETURNING
/// row-reference detection. Best-effort: INSERT targets have no aliasable FROM.
fn write_sources(stmt: &Statement) -> Vec<&TableWithJoins> {
    match stmt {
        Statement::Update(u) => {
            let mut v = vec![&u.table];
            if let Some(from) = update_from_tables(u) {
                v.extend(from);
            }
            v
        }
        Statement::Delete(d) => match &d.from {
            sqlparser::ast::FromTable::WithFromKeyword(t)
            | sqlparser::ast::FromTable::WithoutKeyword(t) => t.iter().collect(),
        },
        _ => Vec::new(),
    }
}

fn update_from_tables(u: &sqlparser::ast::Update) -> Option<Vec<&TableWithJoins>> {
    use sqlparser::ast::UpdateTableFromKind::*;
    match u.from.as_ref()? {
        BeforeSet(t) | AfterSet(t) => Some(t.iter().collect()),
    }
}

fn last_ident(name: &ObjectName) -> Option<String> {
    name.0.last().and_then(|p| match p {
        ObjectNamePart::Identifier(i) => Some(i.value.to_ascii_lowercase()),
        _ => None,
    })
}

/// Parser-failure fallback: does the raw SQL text contain a classified table
/// name as a substring? Over-matches (safe); only ever adds redaction.
fn sql_mentions_classified_table(sql: &str, view: &RedactorView) -> bool {
    let lower = sql.to_ascii_lowercase();
    view.by_name.keys().any(|t| lower.contains(t.as_str()))
}

fn expr_is_sensitive(
    e: &Expr,
    sensitive_cols: &HashSet<String>,
    sensitive_table_refs: &HashSet<String>,
) -> bool {
    let mut v = SensitiveExprVisitor {
        sensitive_cols,
        sensitive_table_refs,
    };
    e.visit(&mut v).is_break()
}

/// Depth-first expression walk that stops at the first reference to a classified
/// column, a classified table's row, or a subquery (lineage-opaque → redact).
struct SensitiveExprVisitor<'a> {
    sensitive_cols: &'a HashSet<String>,
    sensitive_table_refs: &'a HashSet<String>,
}

impl Visitor for SensitiveExprVisitor<'_> {
    type Break = ();

    fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<()> {
        match expr {
            // Unqualified identifier: either a sensitive column (`ssn`) or a
            // whole-row reference to a classified table (`to_jsonb(p)`).
            Expr::Identifier(ident) => {
                let n = ident.value.to_ascii_lowercase();
                if self.sensitive_cols.contains(&n) || self.sensitive_table_refs.contains(&n) {
                    return ControlFlow::Break(());
                }
            }
            // Qualified column (`p.ssn`, `schema.patients.ssn`): the trailing
            // part is the column.
            Expr::CompoundIdentifier(parts) => {
                if let Some(last) = parts.last() {
                    if self.sensitive_cols.contains(&last.value.to_ascii_lowercase()) {
                        return ControlFlow::Break(());
                    }
                }
            }
            // We can't trace lineage into a subquery — fail closed.
            Expr::Subquery(_) | Expr::InSubquery { .. } | Expr::Exists { .. } => {
                return ControlFlow::Break(());
            }
            _ => {}
        }
        ControlFlow::Continue(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::Arc;

    /// A view classifying the given `table.column` pairs. `by_oid` is left empty
    /// (lineage never consults it); `by_name` drives every decision here.
    fn view(pairs: &[(&str, &str)]) -> RedactorView {
        let mut by_name: HashMap<String, HashSet<String>> = HashMap::new();
        for (t, c) in pairs {
            by_name
                .entry(t.to_ascii_lowercase())
                .or_default()
                .insert(c.to_ascii_lowercase());
        }
        RedactorView {
            by_oid: Arc::new(HashMap::new()),
            by_name: Arc::new(by_name),
            secret: Arc::new([0u8; 32]),
        }
    }

    fn redacts(sql: &str, pairs: &[(&str, &str)]) -> bool {
        should_redact_derived(sql, &view(pairs))
    }

    const PATIENTS: &[(&str, &str)] = &[("patients", "ssn"), ("patients", "email")];

    #[test]
    fn keeps_non_sensitive_aggregates() {
        assert!(!redacts("SELECT count(*) FROM patients", PATIENTS));
        assert!(!redacts("SELECT avg(amount) FROM orders", &[("orders", "card_number")]));
        assert!(!redacts(
            "SELECT date_trunc('month', created_at), count(*) FROM patients GROUP BY 1",
            PATIENTS
        ));
    }

    #[test]
    fn redacts_expression_over_classified_column() {
        assert!(redacts("SELECT ssn||'' FROM patients", PATIENTS));
        assert!(redacts("SELECT lower(email) AS e FROM patients", PATIENTS));
        assert!(redacts("SELECT ssn::text FROM patients", PATIENTS));
        assert!(redacts("SELECT string_agg(ssn, ',') FROM patients", PATIENTS));
        assert!(redacts("SELECT COALESCE(ssn, '') FROM patients", PATIENTS));
        assert!(redacts(
            "SELECT CASE WHEN ssn IS NULL THEN 'a' ELSE ssn END FROM patients",
            PATIENTS
        ));
    }

    #[test]
    fn redacts_whole_row_reference() {
        assert!(redacts("SELECT to_jsonb(p) FROM patients p", PATIENTS));
        assert!(redacts("SELECT row_to_json(patients) FROM patients", PATIENTS));
    }

    #[test]
    fn keeps_bare_and_wildcard_projections() {
        // Bare refs and `*` are OID-tagged and handled by the faker path, so
        // lineage must not force blanket derived redaction for them.
        assert!(!redacts("SELECT ssn FROM patients", PATIENTS));
        assert!(!redacts("SELECT id, ssn, email FROM patients", PATIENTS));
        assert!(!redacts("SELECT * FROM patients", PATIENTS));
        assert!(!redacts("SELECT p.ssn FROM patients p", PATIENTS));
    }

    #[test]
    fn does_not_redact_when_no_classified_table_in_scope() {
        assert!(!redacts("SELECT upper(city) FROM warehouses", PATIENTS));
        assert!(!redacts("SELECT count(*) FROM warehouses", PATIENTS));
    }

    #[test]
    fn where_clause_reference_does_not_redact_output() {
        // `id` doesn't expose `ssn`; a sensitive column used only in WHERE must
        // not force redaction of a non-derived projection.
        assert!(!redacts("SELECT id FROM patients WHERE ssn = '123'", PATIENTS));
    }

    #[test]
    fn fails_closed_on_opaque_shapes() {
        assert!(redacts(
            "SELECT * FROM (SELECT ssn||'' AS s FROM patients) x",
            PATIENTS
        ));
        assert!(redacts("WITH c AS (SELECT ssn FROM patients) SELECT * FROM c", PATIENTS));
        assert!(redacts("SELECT ssn FROM patients UNION SELECT ''", PATIENTS));
        assert!(redacts("SELECT (SELECT ssn FROM patients LIMIT 1) AS x", PATIENTS));
    }

    #[test]
    fn opaque_shape_without_classified_table_is_kept() {
        // Fail-closed only bites when a classified table is actually in scope.
        assert!(!redacts(
            "SELECT * FROM (SELECT n FROM widgets) x",
            PATIENTS
        ));
    }

    #[test]
    fn returning_expression_is_redacted() {
        assert!(redacts(
            "INSERT INTO patients (ssn) VALUES ('x') RETURNING ssn||''",
            PATIENTS
        ));
        assert!(redacts(
            "UPDATE patients SET ssn = 'x' RETURNING lower(email)",
            PATIENTS
        ));
        assert!(!redacts(
            "INSERT INTO patients (ssn) VALUES ('x') RETURNING id",
            PATIENTS
        ));
    }
}
