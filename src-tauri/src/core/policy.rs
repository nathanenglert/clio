//! Permission-gate policy evaluator.
//!
//! Pure module: `(rules, parsed_stmt, row_estimate?) → Verdict`. No I/O,
//! no async, no `Core` handle. Designed so the caller can run a fast
//! classification on each statement without touching the database (row
//! estimates come from a separate `EXPLAIN` round).
//!
//! See `design/README.md` §"Permission gates" for the conceptual model.
//! The default ruleset in `default_rules()` is a direct translation of
//! the table in that section.

use sqlparser::ast::{ObjectName, ObjectType, Query, SetExpr, Statement, TableFactor, TableObject};
use sqlparser::dialect::PostgreSqlDialect;
use sqlparser::parser::Parser;

/// Coarse op category, derived from `StmtKind`. Useful for grouping rules
/// like "all writes" without enumerating every statement kind.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpKind {
    Read,
    Write,
    Ddl,
    Destruct,
}

/// Fine-grained statement kind. Rules match on this directly so that
/// `DROP TABLE` can be blocked while `DROP INDEX` only prompts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StmtKind {
    Select,
    Insert,
    Update,
    Delete,
    Truncate,
    DropTable,
    DropSchema,
    DropOther,
    CreateTable,
    CreateSchema,
    CreateIndex,
    CreateView,
    CreateOther,
    AlterTable,
    AlterOther,
    Other,
}

impl StmtKind {
    pub fn op_kind(self) -> OpKind {
        match self {
            StmtKind::Select => OpKind::Read,
            StmtKind::Insert | StmtKind::Update => OpKind::Write,
            StmtKind::Delete
            | StmtKind::Truncate
            | StmtKind::DropTable
            | StmtKind::DropSchema
            | StmtKind::DropOther => OpKind::Destruct,
            StmtKind::CreateTable
            | StmtKind::CreateSchema
            | StmtKind::CreateIndex
            | StmtKind::CreateView
            | StmtKind::CreateOther
            | StmtKind::AlterTable
            | StmtKind::AlterOther
            | StmtKind::Other => OpKind::Ddl,
        }
    }
}

/// A schema-qualified target (e.g. `public.users`). `schema` is `None` when
/// the SQL didn't qualify the name; in that case the rule matcher treats it
/// as matching any schema pattern.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Target {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schema: Option<String>,
    pub name: String,
}

/// Result of parsing a single statement.
#[derive(Debug, Clone)]
pub struct StmtInfo {
    pub kind: StmtKind,
    /// Targets of the statement (table being inserted into, tables being
    /// dropped, etc.). For SELECT we leave this empty — read rules don't
    /// usually care about the target list.
    pub targets: Vec<Target>,
    /// If the outer statement is a Query but a CTE inside it writes, this
    /// promotes the classification to the most restrictive kind found.
    /// E.g. `WITH x AS (DELETE FROM leads ...) SELECT * FROM x` parses as
    /// `Delete` here, not `Select`.
    pub cte_writes: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PatternPart {
    /// Serialized as `{"exact": "..."}` (serde externally-tagged default).
    Exact(String),
    /// Serialized as the string `"any"`.
    Any,
}

impl PatternPart {
    fn matches(&self, value: Option<&str>) -> bool {
        match (self, value) {
            (PatternPart::Any, _) => true,
            (PatternPart::Exact(_), None) => false,
            (PatternPart::Exact(p), Some(v)) => p.eq_ignore_ascii_case(v),
        }
    }
}

/// Schema + name pattern, e.g. `public.*`, `audit.*`, `*.*`.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct TargetPattern {
    pub schema: PatternPart,
    pub name: PatternPart,
}

impl TargetPattern {
    pub fn any() -> Self {
        TargetPattern {
            schema: PatternPart::Any,
            name: PatternPart::Any,
        }
    }

    pub fn schema(schema: impl Into<String>) -> Self {
        TargetPattern {
            schema: PatternPart::Exact(schema.into()),
            name: PatternPart::Any,
        }
    }

    fn matches(&self, target: &Target) -> bool {
        self.schema.matches(target.schema.as_deref()) && self.name.matches(Some(&target.name))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerdictKind {
    Allow,
    Prompt,
    Block,
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct Rule {
    /// Statement kinds this rule applies to. Empty = applies to all.
    pub stmt_kinds: Vec<StmtKind>,
    pub target: TargetPattern,
    /// If set, rule only matches when the row estimate is known *and* ≤ this.
    /// `None` = unconstrained.
    pub max_rows: Option<u64>,
    pub verdict: VerdictKind,
    /// Human-readable label, surfaced in the policy editor and on the
    /// permission card when this rule fires. Should be short.
    pub label: String,
}

/// Decision returned by the evaluator. Carries the matching rule label so
/// the UI can render a meaningful "Outside policy because …" banner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Verdict {
    Allow {
        rule: String,
    },
    Prompt {
        rule: String,
        reason: String,
    },
    Block {
        rule: String,
        reason: String,
    },
}

impl Verdict {
    pub fn kind(&self) -> VerdictKind {
        match self {
            Verdict::Allow { .. } => VerdictKind::Allow,
            Verdict::Prompt { .. } => VerdictKind::Prompt,
            Verdict::Block { .. } => VerdictKind::Block,
        }
    }
}

/// Parse a SQL string into one StmtInfo per top-level statement. Comments
/// and whitespace are stripped by the parser. Returns an error if the SQL
/// is empty or malformed.
pub fn parse_sql(sql: &str) -> Result<Vec<StmtInfo>, String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("empty query".into());
    }
    let dialect = PostgreSqlDialect {};
    let stmts = Parser::parse_sql(&dialect, trimmed).map_err(|e| format!("parse error: {e}"))?;
    if stmts.is_empty() {
        return Err("no statements parsed".into());
    }
    Ok(stmts.iter().map(stmt_info).collect())
}

fn stmt_info(stmt: &Statement) -> StmtInfo {
    match stmt {
        Statement::Query(q) => {
            // Walk the full tree (CTEs and body) for non-SELECT statements.
            // Postgres allows `WITH foo AS (DELETE FROM …) SELECT …`, and the
            // body itself can be a wrapped Insert/Update/Delete/Merge. If
            // anything writing turns up, classify as the most restrictive
            // inner kind so rule matching treats the whole statement that way.
            match query_max_kind(q) {
                Some(k) if k.op_kind() != OpKind::Read => StmtInfo {
                    kind: k,
                    targets: Vec::new(),
                    cte_writes: true,
                },
                _ => StmtInfo {
                    kind: StmtKind::Select,
                    targets: Vec::new(),
                    cte_writes: false,
                },
            }
        }
        Statement::Insert(ins) => {
            let target = match &ins.table {
                TableObject::TableName(name) => object_to_target(name),
                _ => None,
            };
            StmtInfo {
                kind: StmtKind::Insert,
                targets: target.into_iter().collect(),
                cte_writes: false,
            }
        }
        Statement::Update(upd) => StmtInfo {
            kind: StmtKind::Update,
            targets: table_factor_target(&upd.table.relation)
                .into_iter()
                .collect(),
            cte_writes: false,
        },
        Statement::Delete(del) => {
            // `DELETE FROM a, b USING c` — the deletion targets are `from`;
            // USING joins are read-only references.
            let from_tables = match &del.from {
                sqlparser::ast::FromTable::WithFromKeyword(tables)
                | sqlparser::ast::FromTable::WithoutKeyword(tables) => tables,
            };
            let targets = from_tables
                .iter()
                .filter_map(|t| table_factor_target(&t.relation))
                .collect();
            StmtInfo {
                kind: StmtKind::Delete,
                targets,
                cte_writes: false,
            }
        }
        Statement::Truncate(t) => StmtInfo {
            kind: StmtKind::Truncate,
            targets: t
                .table_names
                .iter()
                .filter_map(|tt| object_to_target(&tt.name))
                .collect(),
            cte_writes: false,
        },
        Statement::Drop {
            object_type, names, ..
        } => {
            let kind = match object_type {
                ObjectType::Table => StmtKind::DropTable,
                ObjectType::Schema => StmtKind::DropSchema,
                _ => StmtKind::DropOther,
            };
            StmtInfo {
                kind,
                targets: names.iter().filter_map(object_to_target).collect(),
                cte_writes: false,
            }
        }
        Statement::CreateTable(ct) => StmtInfo {
            kind: StmtKind::CreateTable,
            targets: object_to_target(&ct.name).into_iter().collect(),
            cte_writes: false,
        },
        Statement::CreateSchema { schema_name, .. } => {
            use sqlparser::ast::SchemaName;
            let target = match schema_name {
                SchemaName::Simple(n) => object_to_target(n),
                SchemaName::NamedAuthorization(n, _) => object_to_target(n),
                // AUTHORIZATION-only form names a user, not a schema, so we
                // record no target — the schema-change rule still fires by
                // statement kind alone.
                SchemaName::UnnamedAuthorization(_) => None,
            };
            StmtInfo {
                kind: StmtKind::CreateSchema,
                targets: target.into_iter().collect(),
                cte_writes: false,
            }
        }
        Statement::CreateIndex(ix) => StmtInfo {
            kind: StmtKind::CreateIndex,
            targets: object_to_target(&ix.table_name).into_iter().collect(),
            cte_writes: false,
        },
        Statement::CreateView(cv) => StmtInfo {
            kind: StmtKind::CreateView,
            targets: object_to_target(&cv.name).into_iter().collect(),
            cte_writes: false,
        },
        Statement::AlterTable(at) => StmtInfo {
            kind: StmtKind::AlterTable,
            targets: object_to_target(&at.name).into_iter().collect(),
            cte_writes: false,
        },
        _ => StmtInfo {
            kind: StmtKind::Other,
            targets: Vec::new(),
            cte_writes: false,
        },
    }
}

/// Walks a `Query` (CTEs + body) and returns the most-restrictive statement
/// kind found nested inside. Returns `None` for a pure SELECT tree.
fn query_max_kind(q: &Query) -> Option<StmtKind> {
    let mut out: Option<StmtKind> = None;
    if let Some(with) = &q.with {
        for cte in &with.cte_tables {
            if let Some(k) = query_max_kind(&cte.query) {
                out = Some(most_restrictive(out, k));
            }
        }
    }
    if let Some(k) = set_expr_max_kind(&q.body) {
        out = Some(most_restrictive(out, k));
    }
    out
}

fn set_expr_max_kind(s: &SetExpr) -> Option<StmtKind> {
    match s {
        SetExpr::Insert(stmt)
        | SetExpr::Update(stmt)
        | SetExpr::Delete(stmt)
        | SetExpr::Merge(stmt) => Some(stmt_info(stmt).kind),
        SetExpr::Query(q) => query_max_kind(q),
        SetExpr::SetOperation { left, right, .. } => {
            let l = set_expr_max_kind(left);
            let r = set_expr_max_kind(right);
            match (l, r) {
                (Some(a), Some(b)) => Some(most_restrictive(Some(a), b)),
                (Some(a), None) | (None, Some(a)) => Some(a),
                (None, None) => None,
            }
        }
        SetExpr::Select(_) | SetExpr::Values(_) | SetExpr::Table(_) => None,
    }
}

fn most_restrictive(a: Option<StmtKind>, b: StmtKind) -> StmtKind {
    fn weight(k: StmtKind) -> u8 {
        match k.op_kind() {
            OpKind::Destruct => 4,
            OpKind::Ddl => 3,
            OpKind::Write => 2,
            OpKind::Read => 1,
        }
    }
    match a {
        None => b,
        Some(x) if weight(x) >= weight(b) => x,
        Some(_) => b,
    }
}

fn object_to_target(name: &ObjectName) -> Option<Target> {
    let parts: Vec<String> = name
        .0
        .iter()
        .filter_map(|p| match p {
            sqlparser::ast::ObjectNamePart::Identifier(i) => Some(i.value.clone()),
            _ => None,
        })
        .collect();
    match parts.len() {
        0 => None,
        1 => Some(Target {
            schema: None,
            name: parts.into_iter().next().unwrap(),
        }),
        _ => {
            let mut it = parts.into_iter();
            let schema = it.next();
            let name = it.next().unwrap();
            // Drop catalog prefix if present (3+ parts).
            Some(Target { schema, name })
        }
    }
}

fn table_factor_target(tf: &TableFactor) -> Option<Target> {
    match tf {
        TableFactor::Table { name, .. } => object_to_target(name),
        _ => None,
    }
}

/// Evaluate rules against a parsed statement. First-match wins. If no rule
/// matches, the verdict is `Prompt` with reason "no matching rule" — i.e.
/// we fail safe.
pub fn evaluate(rules: &[Rule], stmt: &StmtInfo, row_estimate: Option<u64>) -> Verdict {
    for rule in rules {
        if !rule.stmt_kinds.is_empty() && !rule.stmt_kinds.contains(&stmt.kind) {
            continue;
        }
        if let Some(cap) = rule.max_rows {
            // Row-bounded rule: needs an estimate, and the estimate must be ≤ cap.
            // If estimate is unknown, this rule cannot fire — fall through.
            match row_estimate {
                Some(est) if est <= cap => {}
                _ => continue,
            }
        }
        // Target match. If the statement has no targets (e.g. SELECT), the
        // rule matches by default — read rules don't filter on targets.
        if !stmt.targets.is_empty() {
            let matches = stmt.targets.iter().all(|t| rule.target.matches(t));
            if !matches {
                continue;
            }
        }
        let label = rule.label.clone();
        return match rule.verdict {
            VerdictKind::Allow => Verdict::Allow { rule: label },
            VerdictKind::Prompt => Verdict::Prompt {
                reason: format!("Matches policy rule: {}", rule.label),
                rule: label,
            },
            VerdictKind::Block => Verdict::Block {
                reason: format!("Blocked by policy rule: {}", rule.label),
                rule: label,
            },
        };
    }
    Verdict::Prompt {
        rule: "no-match".into(),
        reason: "No policy rule matched — defaulting to prompt".into(),
    }
}

/// Default policy from `design/README.md` §"Permission gates":
///
/// 1. `DROP TABLE` / `DROP SCHEMA` → **block**
/// 2. `DELETE`/`TRUNCATE`/other-`DROP` → **prompt** (destructive)
/// 3. `CREATE`/`ALTER` → **prompt** (schema change)
/// 4. `INSERT`/`UPDATE` on `audit.*` / `reporting.*` → **prompt**
/// 5. `INSERT`/`UPDATE` on `public.*` with row estimate ≤ 1000 → **allow**
/// 6. `INSERT`/`UPDATE` (catch-all) → **prompt**
/// 7. `SELECT` → **allow**
pub fn default_rules() -> Vec<Rule> {
    vec![
        Rule {
            stmt_kinds: vec![StmtKind::DropTable, StmtKind::DropSchema],
            target: TargetPattern::any(),
            max_rows: None,
            verdict: VerdictKind::Block,
            label: "DROP TABLE/SCHEMA blocked".into(),
        },
        Rule {
            stmt_kinds: vec![StmtKind::Delete, StmtKind::Truncate, StmtKind::DropOther],
            target: TargetPattern::any(),
            max_rows: None,
            verdict: VerdictKind::Prompt,
            label: "Destructive — prompt with impact".into(),
        },
        Rule {
            stmt_kinds: vec![
                StmtKind::CreateTable,
                StmtKind::CreateSchema,
                StmtKind::CreateIndex,
                StmtKind::CreateView,
                StmtKind::CreateOther,
                StmtKind::AlterTable,
                StmtKind::AlterOther,
                StmtKind::Other,
            ],
            target: TargetPattern::any(),
            max_rows: None,
            verdict: VerdictKind::Prompt,
            label: "Schema change — prompt with diff".into(),
        },
        Rule {
            stmt_kinds: vec![StmtKind::Insert, StmtKind::Update],
            target: TargetPattern::schema("audit"),
            max_rows: None,
            verdict: VerdictKind::Prompt,
            label: "Write to audit.* — prompt".into(),
        },
        Rule {
            stmt_kinds: vec![StmtKind::Insert, StmtKind::Update],
            target: TargetPattern::schema("reporting"),
            max_rows: None,
            verdict: VerdictKind::Prompt,
            label: "Write to reporting.* — prompt".into(),
        },
        Rule {
            stmt_kinds: vec![StmtKind::Insert, StmtKind::Update],
            target: TargetPattern::schema("public"),
            max_rows: Some(1000),
            verdict: VerdictKind::Allow,
            label: "Write to public.* (≤1000 rows)".into(),
        },
        Rule {
            stmt_kinds: vec![StmtKind::Insert, StmtKind::Update],
            target: TargetPattern::any(),
            max_rows: None,
            verdict: VerdictKind::Prompt,
            label: "Write — prompt".into(),
        },
        Rule {
            stmt_kinds: vec![StmtKind::Select],
            target: TargetPattern::any(),
            max_rows: None,
            verdict: VerdictKind::Allow,
            label: "Read".into(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_one(sql: &str) -> StmtInfo {
        let v = parse_sql(sql).expect("parse");
        assert_eq!(v.len(), 1, "expected exactly one statement for: {sql}");
        v.into_iter().next().unwrap()
    }

    fn rules() -> Vec<Rule> {
        default_rules()
    }

    #[test]
    fn select_is_allowed() {
        let s = parse_one("SELECT * FROM users");
        assert_eq!(s.kind, StmtKind::Select);
        match evaluate(&rules(), &s, None) {
            Verdict::Allow { rule } => assert_eq!(rule, "Read"),
            v => panic!("expected Allow, got {v:?}"),
        }
    }

    #[test]
    fn cte_select_is_allowed() {
        let s = parse_one("WITH x AS (SELECT 1 AS n) SELECT * FROM x");
        assert_eq!(s.kind, StmtKind::Select);
        assert!(matches!(evaluate(&rules(), &s, None), Verdict::Allow { .. }));
    }

    #[test]
    fn update_public_small_is_allowed() {
        let s = parse_one("UPDATE public.users SET email = 'x' WHERE id = 1");
        assert_eq!(s.kind, StmtKind::Update);
        assert_eq!(s.targets.len(), 1);
        assert_eq!(s.targets[0].schema.as_deref(), Some("public"));
        assert_eq!(s.targets[0].name, "users");
        match evaluate(&rules(), &s, Some(1)) {
            Verdict::Allow { rule } => assert_eq!(rule, "Write to public.* (≤1000 rows)"),
            v => panic!("expected Allow, got {v:?}"),
        }
    }

    #[test]
    fn update_public_unknown_estimate_falls_through_to_prompt() {
        // Without an estimate, the ≤1000-row rule cannot fire and we fall
        // through to the generic "Write — prompt" catch-all.
        let s = parse_one("UPDATE public.users SET email = 'x'");
        match evaluate(&rules(), &s, None) {
            Verdict::Prompt { rule, .. } => assert_eq!(rule, "Write — prompt"),
            v => panic!("expected Prompt, got {v:?}"),
        }
    }

    #[test]
    fn update_public_large_prompts() {
        let s = parse_one("UPDATE public.users SET email = 'x'");
        match evaluate(&rules(), &s, Some(10_000)) {
            Verdict::Prompt { rule, .. } => assert_eq!(rule, "Write — prompt"),
            v => panic!("expected Prompt, got {v:?}"),
        }
    }

    #[test]
    fn insert_audit_prompts() {
        let s = parse_one("INSERT INTO audit.log (msg) VALUES ('x')");
        assert_eq!(s.kind, StmtKind::Insert);
        match evaluate(&rules(), &s, Some(1)) {
            Verdict::Prompt { rule, .. } => assert_eq!(rule, "Write to audit.* — prompt"),
            v => panic!("expected Prompt, got {v:?}"),
        }
    }

    #[test]
    fn insert_reporting_prompts() {
        let s = parse_one("INSERT INTO reporting.daily VALUES (1)");
        match evaluate(&rules(), &s, Some(1)) {
            Verdict::Prompt { rule, .. } => assert_eq!(rule, "Write to reporting.* — prompt"),
            v => panic!("expected Prompt, got {v:?}"),
        }
    }

    #[test]
    fn delete_prompts() {
        let s = parse_one("DELETE FROM public.leads WHERE created_at < '2025-01-01'");
        assert_eq!(s.kind, StmtKind::Delete);
        match evaluate(&rules(), &s, Some(218)) {
            Verdict::Prompt { rule, .. } => assert_eq!(rule, "Destructive — prompt with impact"),
            v => panic!("expected Prompt, got {v:?}"),
        }
    }

    #[test]
    fn truncate_prompts() {
        let s = parse_one("TRUNCATE TABLE public.users");
        assert_eq!(s.kind, StmtKind::Truncate);
        assert!(matches!(
            evaluate(&rules(), &s, None),
            Verdict::Prompt { .. }
        ));
    }

    #[test]
    fn create_table_prompts() {
        let s = parse_one("CREATE TABLE public.foo (id int)");
        assert_eq!(s.kind, StmtKind::CreateTable);
        match evaluate(&rules(), &s, None) {
            Verdict::Prompt { rule, .. } => assert_eq!(rule, "Schema change — prompt with diff"),
            v => panic!("expected Prompt, got {v:?}"),
        }
    }

    #[test]
    fn alter_table_prompts() {
        let s = parse_one("ALTER TABLE public.users ADD COLUMN x text");
        assert_eq!(s.kind, StmtKind::AlterTable);
        assert!(matches!(
            evaluate(&rules(), &s, None),
            Verdict::Prompt { .. }
        ));
    }

    #[test]
    fn drop_table_is_blocked() {
        let s = parse_one("DROP TABLE public.leads");
        assert_eq!(s.kind, StmtKind::DropTable);
        match evaluate(&rules(), &s, None) {
            Verdict::Block { rule, .. } => assert_eq!(rule, "DROP TABLE/SCHEMA blocked"),
            v => panic!("expected Block, got {v:?}"),
        }
    }

    #[test]
    fn drop_schema_is_blocked() {
        let s = parse_one("DROP SCHEMA public CASCADE");
        assert_eq!(s.kind, StmtKind::DropSchema);
        assert!(matches!(
            evaluate(&rules(), &s, None),
            Verdict::Block { .. }
        ));
    }

    #[test]
    fn drop_index_only_prompts() {
        let s = parse_one("DROP INDEX public.idx_foo");
        assert_eq!(s.kind, StmtKind::DropOther);
        match evaluate(&rules(), &s, None) {
            Verdict::Prompt { rule, .. } => assert_eq!(rule, "Destructive — prompt with impact"),
            v => panic!("expected Prompt, got {v:?}"),
        }
    }

    #[test]
    fn cte_with_delete_is_destruct() {
        // A SELECT statement that uses DELETE inside a CTE must be
        // classified as Delete, not Select.
        let s = parse_one(
            "WITH gone AS (DELETE FROM public.leads WHERE id < 100 RETURNING id) \
             SELECT count(*) FROM gone",
        );
        assert_eq!(s.kind, StmtKind::Delete);
        assert!(s.cte_writes);
        assert!(matches!(
            evaluate(&rules(), &s, None),
            Verdict::Prompt { .. }
        ));
    }

    #[test]
    fn parse_rejects_empty() {
        assert!(parse_sql("").is_err());
        assert!(parse_sql("   \n  -- just a comment\n").is_err());
    }

    #[test]
    fn multi_statement_parses_to_multiple_infos() {
        let v = parse_sql("SELECT 1; UPDATE public.users SET x = 1 WHERE id = 1").unwrap();
        assert_eq!(v.len(), 2);
        assert_eq!(v[0].kind, StmtKind::Select);
        assert_eq!(v[1].kind, StmtKind::Update);
    }

    #[test]
    fn unqualified_update_matches_any_schema_rule() {
        // `UPDATE users` (no schema) — falls through public/audit/reporting
        // rules and hits the generic "Write — prompt".
        let s = parse_one("UPDATE users SET x = 1 WHERE id = 1");
        assert_eq!(s.targets[0].schema, None);
        match evaluate(&rules(), &s, Some(1)) {
            Verdict::Prompt { rule, .. } => assert_eq!(rule, "Write — prompt"),
            v => panic!("expected Prompt, got {v:?}"),
        }
    }

    #[test]
    fn drop_table_with_qualified_name() {
        let s = parse_one("DROP TABLE myschema.foo");
        assert_eq!(s.targets[0].schema.as_deref(), Some("myschema"));
        assert_eq!(s.targets[0].name, "foo");
        assert!(matches!(
            evaluate(&rules(), &s, None),
            Verdict::Block { .. }
        ));
    }

    #[test]
    fn delete_with_using_clause_only_targets_from_table() {
        let s = parse_one(
            "DELETE FROM public.leads l USING public.contacts c WHERE l.id = c.lead_id",
        );
        assert_eq!(s.kind, StmtKind::Delete);
        assert_eq!(s.targets.len(), 1);
        assert_eq!(s.targets[0].name, "leads");
    }

    #[test]
    fn pattern_part_matches() {
        assert!(PatternPart::Any.matches(Some("anything")));
        assert!(PatternPart::Any.matches(None));
        assert!(PatternPart::Exact("public".into()).matches(Some("public")));
        assert!(PatternPart::Exact("PUBLIC".into()).matches(Some("public")));
        assert!(!PatternPart::Exact("public".into()).matches(Some("audit")));
        assert!(!PatternPart::Exact("public".into()).matches(None));
    }
}
