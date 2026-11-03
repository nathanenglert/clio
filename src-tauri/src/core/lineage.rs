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
    Expr, FunctionArg, FunctionArgExpr, FunctionArguments, ObjectName, ObjectNamePart, Query,
    SelectItem, SetExpr, Statement, TableFactor, TableObject, TableWithJoins, Visit, Visitor,
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

    // A column-alias list (`FROM patients AS p(a, b, …)`) renames classified
    // columns, so the name matching below can't see them — fail closed.
    if classified_table_renames_columns(stmt, view) {
        return true;
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

/// Functions that run SQL handed to them as a string (or over another
/// connection), so the relations they read never appear in the AST that
/// lineage analyzes.
const SQL_EXECUTING_FUNCTIONS: &[&str] = &[
    "query_to_xml",
    "query_to_xmlschema",
    "query_to_xml_and_xmlschema",
    "cursor_to_xml",
    "cursor_to_xmlschema",
    "table_to_xml",
    "table_to_xmlschema",
    "table_to_xml_and_xmlschema",
    "schema_to_xml",
    "schema_to_xmlschema",
    "schema_to_xml_and_xmlschema",
    "database_to_xml",
    "database_to_xmlschema",
    "database_to_xml_and_xmlschema",
    "ts_stat",
    "dblink",
    "dblink_exec",
    "dblink_open",
    "dblink_fetch",
    "dblink_send_query",
    "dblink_get_result",
];

/// Catalogs that store sampled column values (most-common values, histogram
/// bounds) for every column, classified or not.
const VALUE_SAMPLING_CATALOGS: &[&str] = &[
    "pg_stats",
    "pg_stats_ext",
    "pg_stats_ext_exprs",
    "pg_statistic",
    "pg_statistic_ext_data",
];

/// The first function or relation in `sql` whose output lineage can't trace —
/// a SQL-executing function or a value-sampling catalog — if any. Matches
/// parsed names, not raw text; unparseable SQL falls back to a text match so
/// it only ever over-reports. This is a blocklist: it closes the known
/// channels, not every possible one.
pub(super) fn untraceable_reference(sql: &str) -> Option<&'static str> {
    struct Finder(Option<&'static str>);
    impl Finder {
        fn check(&mut self, name: &ObjectName) -> ControlFlow<()> {
            let Some(n) = last_ident(name) else {
                return ControlFlow::Continue(());
            };
            match SQL_EXECUTING_FUNCTIONS
                .iter()
                .chain(VALUE_SAMPLING_CATALOGS)
                .find(|b| **b == n)
            {
                Some(hit) => {
                    self.0 = Some(hit);
                    ControlFlow::Break(())
                }
                None => ControlFlow::Continue(()),
            }
        }
    }
    impl Visitor for Finder {
        type Break = ();
        fn pre_visit_relation(&mut self, relation: &ObjectName) -> ControlFlow<()> {
            self.check(relation)
        }
        fn pre_visit_table_factor(&mut self, tf: &TableFactor) -> ControlFlow<()> {
            match tf {
                TableFactor::Function { name, .. } => self.check(name),
                _ => ControlFlow::Continue(()),
            }
        }
        fn pre_visit_expr(&mut self, expr: &Expr) -> ControlFlow<()> {
            match expr {
                Expr::Function(f) => self.check(&f.name),
                _ => ControlFlow::Continue(()),
            }
        }
    }

    let dialect = PostgreSqlDialect {};
    match Parser::parse_sql(&dialect, sql) {
        Ok(stmts) => {
            let mut f = Finder(None);
            let _ = stmts.visit(&mut f);
            f.0
        }
        Err(_) => {
            let lower = sql.to_ascii_lowercase();
            SQL_EXECUTING_FUNCTIONS
                .iter()
                .chain(VALUE_SAMPLING_CATALOGS)
                .find(|b| lower.contains(**b))
                .copied()
        }
    }
}

/// Whether a write *reads* classified data: a classified column or row in any
/// expression (SET values, WHERE, ON CONFLICT, RETURNING), a classified table
/// as a read source (INSERT … SELECT, UPDATE … FROM, DELETE … USING), or a
/// subquery (lineage-opaque). Writing literals into a classified table doesn't
/// count. Unparseable SQL falls back to a text match, and write shapes not
/// analyzed here count whenever they touch a classified table, so this only
/// ever over-reports. Used to keep a write that could copy classified values
/// somewhere unredacted (`INSERT INTO public.t SELECT ssn …`) from riding a
/// row-bounded allow rule.
pub(super) fn write_reads_classified(sql: &str, view: &RedactorView) -> bool {
    let dialect = PostgreSqlDialect {};
    let stmts = match Parser::parse_sql(&dialect, sql) {
        Ok(s) => s,
        Err(_) => return sql_mentions_classified_table(sql, view),
    };
    let [stmt] = stmts.as_slice() else {
        return any_classified_relation(&stmts, view);
    };
    let tables = statement_tables(stmt);
    if !tables.iter().any(|t| view.by_name.contains_key(t)) {
        return false;
    }
    if classified_table_renames_columns(stmt, view) {
        return true;
    }
    let sources = write_sources(stmt);
    let (cols, refs) = build_scope(&tables, &sources, view);
    let mut probe = SensitiveExprVisitor {
        sensitive_cols: &cols,
        sensitive_table_refs: &refs,
    };
    match stmt {
        Statement::Insert(i) => {
            i.source
                .as_ref()
                .is_some_and(|q| any_classified_relation(q, view) || q.visit(&mut probe).is_break())
                || i.on.visit(&mut probe).is_break()
                || i.returning.visit(&mut probe).is_break()
        }
        Statement::Update(u) => {
            update_from_tables(u).is_some_and(|f| f.iter().any(|t| any_classified_relation(*t, view)))
                || u.assignments.visit(&mut probe).is_break()
                || u.selection.visit(&mut probe).is_break()
                || u.returning.visit(&mut probe).is_break()
        }
        Statement::Delete(d) => {
            d.using
                .as_ref()
                .is_some_and(|u| u.iter().any(|t| any_classified_relation(t, view)))
                || d.selection.visit(&mut probe).is_break()
                || d.returning.visit(&mut probe).is_break()
        }
        _ => true,
    }
}

/// Lowercased names of every relation `sql` references (see
/// [`statement_tables`]). Empty when the SQL doesn't parse.
pub(super) fn relation_names(sql: &str) -> HashSet<String> {
    match Parser::parse_sql(&PostgreSqlDialect {}, sql) {
        Ok(stmts) => stmts.iter().flat_map(statement_tables).collect(),
        Err(_) => HashSet::new(),
    }
}

/// What one output column of a stored query (a view, `CREATE TABLE AS`,
/// `SELECT INTO`, `INSERT … SELECT`, an UPDATE's SET value) carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum StoredColumn {
    /// Nothing classified.
    Clean,
    /// A bare copy of the classified column with this (lowercased) name.
    Copy(String),
    /// An expression over classified columns or rows.
    Derived,
}

/// Per-column lineage of a stored query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum StoredLineage {
    /// No classified table is referenced.
    Clean,
    /// One entry per output column, in order.
    Columns(Vec<StoredColumn>),
    /// A classified table is in scope but the shape can't be traced column by
    /// column (CTE, set operation, derived table, wildcard): treat every
    /// output column as classified.
    Opaque,
}

/// Per-column lineage of `q`'s output. Name-based like the rest of this module.
pub(super) fn query_lineage(q: &Query, view: &RedactorView) -> StoredLineage {
    if !any_classified_relation(q, view) {
        return StoredLineage::Clean;
    }
    let SetExpr::Select(select) = q.body.as_ref() else {
        return StoredLineage::Opaque;
    };
    let plain = select.from.iter().all(|twj| {
        is_plain_table(&twj.relation) && twj.joins.iter().all(|j| is_plain_table(&j.relation))
    });
    if q.with.is_some() || !plain || classified_table_renames_columns(q, view) {
        return StoredLineage::Opaque;
    }
    let mut tables = HashSet::new();
    let _ = sqlparser::ast::visit_relations(q, |name| {
        if let Some(t) = last_ident(name) {
            tables.insert(t);
        }
        ControlFlow::<()>::Continue(())
    });
    let sources: Vec<&TableWithJoins> = select.from.iter().collect();
    let (cols, refs) = build_scope(&tables, &sources, view);
    let mut out = Vec::with_capacity(select.projection.len());
    for item in &select.projection {
        let e = match item {
            SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } => e,
            _ => return StoredLineage::Opaque,
        };
        out.push(expr_lineage(unwrap_nested(e), &cols, &refs));
    }
    StoredLineage::Columns(out)
}

fn expr_lineage(e: &Expr, cols: &HashSet<String>, refs: &HashSet<String>) -> StoredColumn {
    let bare = match e {
        Expr::Identifier(i) => Some(i.value.to_ascii_lowercase()),
        Expr::CompoundIdentifier(parts) => parts.last().map(|p| p.value.to_ascii_lowercase()),
        _ => None,
    };
    match bare {
        // `SELECT p` is a whole classified row.
        Some(n) if matches!(e, Expr::Identifier(_)) && refs.contains(&n) => StoredColumn::Derived,
        Some(n) if cols.contains(&n) => StoredColumn::Copy(n),
        Some(_) => StoredColumn::Clean,
        None if expr_is_sensitive(e, cols, refs) => StoredColumn::Derived,
        None => StoredColumn::Clean,
    }
}

/// Lineage of a view's stored definition (`pg_get_viewdef`). A definition the
/// parser rejects is opaque if it mentions a classified table.
pub(super) fn definition_lineage(def: &str, view: &RedactorView) -> StoredLineage {
    match Parser::parse_sql(&PostgreSqlDialect {}, def).as_deref() {
        Ok([Statement::Query(q)]) => query_lineage(q, view),
        _ if sql_mentions_classified_table(def, view) => StoredLineage::Opaque,
        _ => StoredLineage::Clean,
    }
}

/// A write that stores query output in a table.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct StoredWrite {
    /// The target table as written (quotes kept), for `to_regclass`.
    pub target: String,
    /// The target columns named in the statement, folded the way Postgres
    /// folds identifiers. `None` means every column, in table order.
    pub columns: Option<Vec<String>>,
    pub lineage: StoredLineage,
}

/// The stored write `sql` performs, if it is one: `CREATE TABLE … AS`,
/// `SELECT … INTO`, `INSERT … SELECT/VALUES` or `UPDATE … SET`.
pub(super) fn stored_write(sql: &str, view: &RedactorView) -> Option<StoredWrite> {
    let stmts = Parser::parse_sql(&PostgreSqlDialect {}, sql).ok()?;
    let [stmt] = stmts.as_slice() else {
        return None;
    };
    match stmt {
        Statement::CreateTable(ct) => Some(StoredWrite {
            target: ct.name.to_string(),
            columns: None,
            lineage: query_lineage(ct.query.as_ref()?, view),
        }),
        Statement::Query(q) => match q.body.as_ref() {
            SetExpr::Select(s) => Some(StoredWrite {
                target: s.into.as_ref()?.name.to_string(),
                columns: None,
                lineage: query_lineage(q, view),
            }),
            _ => None,
        },
        Statement::Insert(i) => {
            let TableObject::TableName(name) = &i.table else {
                return None;
            };
            let columns = (!i.columns.is_empty())
                .then(|| i.columns.iter().filter_map(folded_last).collect());
            Some(StoredWrite {
                target: name.to_string(),
                columns,
                lineage: query_lineage(i.source.as_ref()?, view),
            })
        }
        Statement::Update(u) => {
            let TableFactor::Table { name, .. } = &u.table.relation else {
                return None;
            };
            let tables = statement_tables(stmt);
            let (cols, refs) = build_scope(&tables, &write_sources(stmt), view);
            let classified = tables.iter().any(|t| view.by_name.contains_key(t));
            let mut columns = Vec::new();
            let mut lineage = Vec::new();
            for a in &u.assignments {
                let targets = match &a.target {
                    sqlparser::ast::AssignmentTarget::ColumnName(n) => vec![n],
                    sqlparser::ast::AssignmentTarget::Tuple(ns) => ns.iter().collect(),
                };
                let value = match expr_lineage(unwrap_nested(&a.value), &cols, &refs) {
                    // A tuple target takes its columns from one opaque value.
                    StoredColumn::Copy(_) if targets.len() > 1 => StoredColumn::Derived,
                    v => v,
                };
                for t in targets {
                    columns.extend(folded_last(t));
                    lineage.push(value.clone());
                }
            }
            Some(StoredWrite {
                target: name.to_string(),
                columns: Some(columns),
                lineage: if classified {
                    StoredLineage::Columns(lineage)
                } else {
                    StoredLineage::Clean
                },
            })
        }
        _ => None,
    }
}

/// The last part of `name`, folded the way Postgres folds an identifier:
/// lowercased unless quoted.
fn folded_last(name: &ObjectName) -> Option<String> {
    name.0.last().and_then(|p| match p {
        ObjectNamePart::Identifier(i) if i.quote_style.is_some() => Some(i.value.clone()),
        ObjectNamePart::Identifier(i) => Some(i.value.to_ascii_lowercase()),
        _ => None,
    })
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
    // `SELECT p FROM patients p` projects the whole row as one untagged record
    // column — bare in syntax, but derived in effect.
    let whole_row = select
        .projection
        .iter()
        .any(|item| bare_ident(item).is_some_and(|n| sensitive_table_refs.contains(&n)));
    whole_row
        || select
            .projection
            .iter()
            .filter_map(derived_expr)
            .any(|e| expr_is_sensitive(e, &sensitive_cols, &sensitive_table_refs))
}

/// The lowercased name of a projection item that is a lone unqualified
/// identifier (`SELECT p`), if it is one.
fn bare_ident(item: &SelectItem) -> Option<String> {
    let e = match item {
        SelectItem::UnnamedExpr(e) | SelectItem::ExprWithAlias { expr: e, .. } => e,
        _ => return None,
    };
    match unwrap_nested(e) {
        Expr::Identifier(i) => Some(i.value.to_ascii_lowercase()),
        _ => None,
    }
}

/// Whether any classified table in `stmt` carries a column-alias list.
fn classified_table_renames_columns<V: Visit>(stmt: &V, view: &RedactorView) -> bool {
    struct Finder<'a>(&'a RedactorView);
    impl Visitor for Finder<'_> {
        type Break = ();
        fn pre_visit_table_factor(&mut self, tf: &TableFactor) -> ControlFlow<()> {
            if let TableFactor::Table { name, alias: Some(alias), .. } = tf {
                let classified = last_ident(name).is_some_and(|t| self.0.by_name.contains_key(&t));
                if classified && !alias.columns.is_empty() {
                    return ControlFlow::Break(());
                }
            }
            ControlFlow::Continue(())
        }
    }
    stmt.visit(&mut Finder(view)).is_break()
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

impl SensitiveExprVisitor<'_> {
    /// `name.*` where `name` is a classified table or its alias.
    fn is_sensitive_row(&self, name: &ObjectName) -> bool {
        last_ident(name).is_some_and(|n| self.sensitive_table_refs.contains(&n))
    }
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
            // `p.*` as an expression (`(p.*)::text`) is the whole row.
            Expr::QualifiedWildcard(name, _) => {
                if self.is_sensitive_row(name) {
                    return ControlFlow::Break(());
                }
            }
            // `to_jsonb(p.*)`: a wildcard argument is a `FunctionArgExpr`, not
            // an `Expr`, so the walk never reaches it on its own.
            Expr::Function(f) => {
                if let FunctionArguments::List(list) = &f.args {
                    let row_arg = list.args.iter().any(|a| match a {
                        FunctionArg::Unnamed(FunctionArgExpr::QualifiedWildcard(n))
                        | FunctionArg::Named { arg: FunctionArgExpr::QualifiedWildcard(n), .. }
                        | FunctionArg::ExprNamed { arg: FunctionArgExpr::QualifiedWildcard(n), .. } => {
                            self.is_sensitive_row(n)
                        }
                        _ => false,
                    });
                    if row_arg {
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
    fn redacts_through_column_alias_lists() {
        // `p(x1, x2, x3)` renames ssn/email out from under name matching.
        assert!(redacts(
            "SELECT x2||'' FROM clinical.patients AS p(x1, x2, x3)",
            PATIENTS
        ));
        assert!(redacts(
            "SELECT lower(e) FROM orders o JOIN patients p(i, s, e) ON true",
            PATIENTS
        ));
        // An alias list on an unclassified table changes nothing.
        assert!(!redacts("SELECT upper(c) FROM warehouses w(c)", PATIENTS));
    }

    #[test]
    fn redacts_qualified_wildcard_row_references() {
        assert!(redacts("SELECT to_jsonb(p.*) FROM clinical.patients p", PATIENTS));
        assert!(redacts("SELECT row_to_json(patients.*) FROM patients", PATIENTS));
        assert!(redacts("SELECT (p.*)::text FROM patients p", PATIENTS));
        assert!(redacts("SELECT p FROM patients p", PATIENTS));
        // `count(*)` is a plain wildcard argument, not a row.
        assert!(!redacts("SELECT count(*) FROM patients p", PATIENTS));
        assert!(!redacts("SELECT to_jsonb(w.*) FROM warehouses w", PATIENTS));
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
    fn detects_writes_that_read_classified_data() {
        let v = view(PATIENTS);
        for sql in [
            "INSERT INTO public.audit_log (target_id) SELECT ssn FROM clinical.patients RETURNING target_id",
            "INSERT INTO public.t SELECT count(*) FROM patients",
            "UPDATE public.leads SET note = (SELECT email FROM patients LIMIT 1)",
            "UPDATE patients SET notes = ssn",
            "UPDATE patients p SET notes = to_jsonb(p)::text",
            "UPDATE public.leads l SET note = p.id FROM patients p WHERE p.id = l.id",
            "UPDATE patients SET notes = 'x' WHERE email LIKE 'a%'",
            "DELETE FROM patients WHERE ssn LIKE '1%'",
            "DELETE FROM public.leads l USING patients p WHERE p.id = l.id",
            "INSERT INTO patients (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET notes = patients.ssn",
            "WITH c AS (SELECT ssn FROM patients) INSERT INTO public.t SELECT * FROM c",
            "INSERT INTO patients AS p (id, ssn) VALUES (1, 'x') RETURNING lower(email)",
        ] {
            assert!(write_reads_classified(sql, &v), "{sql}");
        }
        for sql in [
            "UPDATE public.leads SET status = 'x'",
            "INSERT INTO public.t VALUES (1)",
            "INSERT INTO patients (id, ssn) VALUES (1, '111-22-3333')",
            "UPDATE patients SET notes = 'x' WHERE id = 1",
            "DELETE FROM patients WHERE id = 1",
        ] {
            assert!(!write_reads_classified(sql, &v), "{sql}");
        }
    }

    fn stored(sql: &str) -> Option<StoredWrite> {
        stored_write(sql, &view(PATIENTS))
    }

    #[test]
    fn stored_writes_trace_each_target_column() {
        use StoredColumn::*;
        let w = stored("CREATE TABLE scratch AS SELECT p.id, p.ssn AS x, upper(email) FROM patients p")
            .unwrap();
        assert_eq!(w.target, "scratch");
        assert_eq!(w.columns, None);
        assert_eq!(
            w.lineage,
            StoredLineage::Columns(vec![Clean, Copy("ssn".into()), Derived])
        );

        let w = stored("SELECT id, ssn INTO TABLE public.copy FROM patients").unwrap();
        assert_eq!(w.target, "public.copy");
        assert_eq!(w.lineage, StoredLineage::Columns(vec![Clean, Copy("ssn".into())]));

        let w = stored(r#"INSERT INTO audit (a, "B") SELECT id, ssn FROM patients"#).unwrap();
        assert_eq!(w.columns, Some(vec!["a".to_string(), "B".to_string()]));
        assert_eq!(w.lineage, StoredLineage::Columns(vec![Clean, Copy("ssn".into())]));

        let w = stored("UPDATE leads SET note = p.email, status = 'x' FROM patients p").unwrap();
        assert_eq!(w.columns, Some(vec!["note".to_string(), "status".to_string()]));
        assert_eq!(w.lineage, StoredLineage::Columns(vec![Copy("email".into()), Clean]));
    }

    #[test]
    fn stored_writes_fail_closed_or_stay_clean() {
        // Wildcards and CTEs over a classified table can't be traced per column.
        assert_eq!(stored("CREATE TABLE t AS SELECT * FROM patients").unwrap().lineage, StoredLineage::Opaque);
        assert_eq!(
            stored("CREATE TABLE t AS WITH c AS (SELECT ssn FROM patients) SELECT ssn FROM c")
                .unwrap()
                .lineage,
            StoredLineage::Opaque
        );
        // Literals and unclassified sources carry nothing.
        assert_eq!(stored("INSERT INTO patients (ssn) VALUES ('x')").unwrap().lineage, StoredLineage::Clean);
        assert_eq!(stored("CREATE TABLE t AS SELECT * FROM orders").unwrap().lineage, StoredLineage::Clean);
        assert!(stored("SELECT ssn FROM patients").is_none());
        assert!(stored("DELETE FROM patients").is_none());
    }

    #[test]
    fn view_definitions_trace_each_column() {
        use StoredColumn::*;
        let v = view(PATIENTS);
        // pg_get_viewdef output: expanded, qualified, newline-separated.
        let def = " SELECT p.id,\n    p.ssn AS ident,\n    (p.email)::text AS contact\n   FROM clinical.patients p;";
        assert_eq!(
            definition_lineage(def, &v),
            StoredLineage::Columns(vec![Clean, Copy("ssn".into()), Derived])
        );
        assert_eq!(definition_lineage(" SELECT o.id FROM orders o;", &v), StoredLineage::Clean);
        assert_eq!(
            definition_lineage(" SELECT p.id FROM patients p UNION SELECT 1;", &v),
            StoredLineage::Opaque
        );
        // A definition the parser rejects is opaque when it names a classified table.
        assert_eq!(definition_lineage("SELECT FROM patients WHERE (", &v), StoredLineage::Opaque);
    }

    #[test]
    fn finds_sql_executing_functions_and_sampling_catalogs() {
        for (sql, hit) in [
            ("SELECT query_to_xml('select ssn from patients', true, false, '')", "query_to_xml"),
            ("SELECT pg_catalog.table_to_xml('patients'::regclass, true, false, '')", "table_to_xml"),
            ("SELECT * FROM ts_stat('select tsv from notes')", "ts_stat"),
            ("SELECT most_common_vals FROM pg_stats WHERE attname = 'ssn'", "pg_stats"),
            ("SELECT n FROM (SELECT 1 n) x JOIN pg_catalog.pg_statistic s ON true", "pg_statistic"),
            ("INSERT INTO t SELECT schema_to_xml('clinical', true, false, '')", "schema_to_xml"),
            // Unparseable SQL still gets caught by the text fallback.
            ("SELECT query_to_xml('x' FROM", "query_to_xml"),
        ] {
            assert_eq!(untraceable_reference(sql), Some(hit), "{sql}");
        }
        assert_eq!(untraceable_reference("SELECT xmlelement(name a, 'b')"), None);
        assert_eq!(untraceable_reference("SELECT * FROM pg_stat_user_tables"), None);
        assert_eq!(untraceable_reference("SELECT count(*) FROM patients"), None);
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
