//! Deterministic Faker for sensitivity-aware redaction.
//!
//! See design/redaction.md §"Determinism: same real → same fake".
//!
//! Mapping:  fake = Faker(HMAC_SHA256(secret, "<table>.<column>|<real>")).<gen_for_type>()
//!
//! `secret` is per-connection (32 random bytes in the keychain), so the same
//! real value across two different connections produces different fakes.
//! Same connection across sessions → stable mapping (joinability preserved).
//!
//! Cache: `RedactorView` holds `(table_oid, attnum) → (Category, column_name)`
//! so the result-row pass at query time is a hot O(N rows × N cols) lookup
//! with no SQLite or Postgres I/O.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use anyhow::{Context, Result};
use hmac::{Hmac, Mac};
use rand::{Rng, SeedableRng};
use rand::rngs::StdRng;
use sha2::Sha256;
use sqlx::postgres::PgPool;
use sqlx::Row;
use tokio::sync::Mutex;

use crate::connections;
use crate::types::{Category, Classification};

type HmacSha256 = Hmac<Sha256>;

/// Compiled lookup keyed by `(table_oid, attribute_no)`. Built once per
/// connection on demand; invalidated on classification change or disconnect.
#[derive(Clone)]
pub struct RedactorView {
    pub by_oid: Arc<HashMap<(i32, i16), ClassifiedColumn>>,
    /// Classified columns keyed by lowercased table name → set of lowercased
    /// column names. Unlike `by_oid` (which needs a live Postgres OID), this is
    /// built directly from the stored classifications, so it exists even for
    /// columns whose OID didn't resolve. Drives `core::lineage`'s analysis of
    /// derived/expression result columns that Postgres doesn't tag.
    pub by_name: Arc<HashMap<String, HashSet<String>>>,
    pub secret: Arc<[u8; 32]>,
}

#[derive(Debug, Clone)]
pub struct ClassifiedColumn {
    pub category: Category,
    pub column_name: String,
}

/// Per-process cache. Lives on `Core`. Lazy-built on first `view_for`.
#[derive(Default, Clone)]
pub struct RedactorCache {
    inner: Arc<Mutex<HashMap<String, Arc<RedactorView>>>>,
}

impl RedactorCache {
    pub async fn invalidate(&self, conn_name: &str) {
        self.inner.lock().await.remove(conn_name);
    }

    /// Look up or build the view for `conn_name`. Returns `None` if the
    /// connection has no classifications at all (no redaction needed).
    pub async fn view_for(
        &self,
        meta: &sqlx::SqlitePool,
        pool: &PgPool,
        conn_name: &str,
        connection_id: &str,
    ) -> Result<Option<Arc<RedactorView>>> {
        {
            let guard = self.inner.lock().await;
            if let Some(v) = guard.get(conn_name) {
                return Ok(if v.by_name.is_empty() { None } else { Some(v.clone()) });
            }
        }
        let view = build_view(meta, pool, conn_name, connection_id).await?;
        let arc = Arc::new(view);
        self.inner.lock().await.insert(conn_name.to_string(), arc.clone());
        // Presence of *any* classification (not just OID-resolved ones) means
        // the connection is redacted: `by_name` powers the lineage pass even
        // when a classified column's OID didn't resolve.
        Ok(if arc.by_name.is_empty() { None } else { Some(arc) })
    }
}

/// Build the OID-keyed view by joining classifications against
/// `pg_class`/`pg_attribute`/`pg_namespace`.
async fn build_view(
    meta: &sqlx::SqlitePool,
    pool: &PgPool,
    conn_name: &str,
    connection_id: &str,
) -> Result<RedactorView> {
    let classifications = connections::list_classifications(meta, connection_id).await?;
    let secret = connections::get_redaction_secret(conn_name)
        .with_context(|| format!("redaction secret for {conn_name}"))?
        .unwrap_or([0u8; 32]); // see note below

    if classifications.is_empty() {
        return Ok(RedactorView {
            by_oid: Arc::new(HashMap::new()),
            by_name: Arc::new(HashMap::new()),
            secret: Arc::new(secret),
        });
    }

    // Name-keyed view for lineage analysis, built straight from the stored
    // classifications (independent of OID resolution below).
    let mut by_name: HashMap<String, HashSet<String>> = HashMap::new();
    for c in &classifications {
        by_name
            .entry(c.table.to_ascii_lowercase())
            .or_default()
            .insert(c.column.to_ascii_lowercase());
    }

    // Group classifications by (schema, table) for the OID resolution query.
    let mut by_table: HashMap<(String, String), Vec<&Classification>> = HashMap::new();
    for c in &classifications {
        by_table
            .entry((c.schema.clone(), c.table.clone()))
            .or_default()
            .push(c);
    }

    // Single query: resolve all classified (schema.table.column) → (oid, attnum).
    // Use unnest() over two parallel arrays to avoid per-row binding gymnastics.
    let mut schemas: Vec<String> = Vec::new();
    let mut tables: Vec<String> = Vec::new();
    for (schema, table) in by_table.keys() {
        schemas.push(schema.clone());
        tables.push(table.clone());
    }

    let rows = sqlx::query(
        r#"
        SELECT
            n.nspname     AS schema,
            c.relname     AS table,
            a.attname     AS column,
            c.oid::int    AS oid,
            a.attnum::int2 AS attnum
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid
        WHERE a.attnum > 0
          AND NOT a.attisdropped
          AND (n.nspname, c.relname) IN (
              SELECT * FROM unnest($1::text[], $2::text[])
          )
        "#,
    )
    .bind(&schemas)
    .bind(&tables)
    .fetch_all(pool)
    .await
    .with_context(|| "resolve classified column oids")?;

    let mut by_oid: HashMap<(i32, i16), ClassifiedColumn> = HashMap::new();
    let mut by_qualified: HashMap<(String, String, String), (i32, i16)> = HashMap::new();
    for row in rows {
        let schema: String = row.get("schema");
        let table: String = row.get("table");
        let column: String = row.get("column");
        let oid: i32 = row.get("oid");
        let attnum: i16 = row.get("attnum");
        by_qualified.insert((schema, table, column), (oid, attnum));
    }
    for c in &classifications {
        if let Some((oid, attnum)) = by_qualified
            .get(&(c.schema.clone(), c.table.clone(), c.column.clone()))
            .cloned()
        {
            by_oid.insert(
                (oid, attnum),
                ClassifiedColumn {
                    category: c.category,
                    column_name: c.column.clone(),
                },
            );
        }
        // Else: classification references a column that no longer exists in
        // pg_attribute (dropped/renamed). Skip silently; a follow-up
        // classify_schema can sweep stale entries.
    }

    Ok(RedactorView {
        by_oid: Arc::new(by_oid),
        by_name: Arc::new(by_name),
        secret: Arc::new(secret),
    })
}

// ── Faker ────────────────────────────────────────────────────────────

/// Compute the deterministic fake for `(table_oid, attnum, real_value)` under
/// `secret`. `pg_type_name` is the Postgres type as reported by sqlx (e.g.
/// "TEXT", "INT4"). `column_name` is the classified column name, used as a
/// hint to pick TEXT sub-generators (email/phone/address/name).
pub fn fake_for(
    secret: &[u8; 32],
    table_oid: i32,
    attnum: i16,
    column_name: &str,
    pg_type_name: &str,
    real_value: &str,
) -> String {
    let seed = derive_seed(secret, table_oid, attnum, real_value);
    let mut rng = StdRng::from_seed(seed);

    match pg_type_name {
        // Numeric types — keep magnitude bucket. Treat NUMERIC like INT8.
        "INT2" => rng.gen_range(0i32..1000).to_string(),
        "INT4" => rng.gen_range(0i32..100_000).to_string(),
        "INT8" | "NUMERIC" => rng.gen_range(0i64..1_000_000_000i64).to_string(),
        "FLOAT4" | "FLOAT8" => format!("{:.4}", rng.gen::<f64>() * 1000.0),

        // Booleans — flip with the seed.
        "BOOL" => {
            let b: bool = rng.gen();
            (if b { "true" } else { "false" }).to_string()
        }

        // Dates / timestamps — random within ±2 years of the real value if we
        // can parse it; otherwise an absolute random in the last 5 years.
        "DATE" => fake_date(real_value, &mut rng).to_string(),
        "TIMESTAMP" => fake_timestamp(real_value, &mut rng, false),
        "TIMESTAMPTZ" => fake_timestamp(real_value, &mut rng, true),

        // UUIDs stay UUIDs.
        "UUID" => uuid_from_seed(&mut rng).to_string(),

        // JSON/JSONB — wholesale opaque.
        "JSON" | "JSONB" => "{\"redacted\":true}".to_string(),

        // Bytea — opaque hex.
        "BYTEA" => "\\xredacted".to_string(),

        // Text-shaped types: pick a sub-generator from the column name.
        "TEXT" | "VARCHAR" | "BPCHAR" | "NAME" | "CHAR" | "CITEXT" => {
            fake_text(column_name, &mut rng)
        }

        // Anything else (enums, domains, arrays, ranges, etc.): opaque label.
        _ => "<redacted>".to_string(),
    }
}

fn derive_seed(
    secret: &[u8; 32],
    table_oid: i32,
    attnum: i16,
    real_value: &str,
) -> [u8; 32] {
    // domain-separated input: oid/attnum prefix means the same real value
    // produces different fakes when classified under different columns.
    let mut mac = HmacSha256::new_from_slice(secret).expect("hmac key");
    mac.update(&table_oid.to_le_bytes());
    mac.update(&attnum.to_le_bytes());
    mac.update(b"|");
    mac.update(real_value.as_bytes());
    let mut out = [0u8; 32];
    out.copy_from_slice(&mac.finalize().into_bytes());
    out
}

// ── Sub-generators ──────────────────────────────────────────────────

const FIRST_NAMES: &[&str] = &[
    "Maya", "Hugo", "Sade", "Lena", "Ravi", "Ines", "Yusuf", "Bea",
    "Theo", "Anya", "Kofi", "Lina", "Aris", "Niko", "Esme", "Jin",
    "Tova", "Ezra", "Sol", "Mira", "Cyrus", "Liv", "Otis", "Nia",
    "Owen", "Cleo", "Aki", "Pia", "Asa", "Brio", "Cass", "Drey",
];
const LAST_NAMES: &[&str] = &[
    "Okonkwo", "Patel", "Brennan", "Brückner", "Sundaram", "el-Hassan",
    "Halloran", "Okafor", "Tanaka", "Nakamura", "Chen", "Park", "Lee",
    "Kowalski", "Novak", "Andersen", "Hoffmann", "Ferreira", "Castillo",
    "Ng", "Quinn", "Wallis", "Mårtensson", "Bauer", "Romero", "Singh",
];
const STREET_NAMES: &[&str] = &[
    "Maple", "Oak", "Pine", "Cedar", "Birch", "Linden", "Holly",
    "Larkspur", "Magnolia", "Ash", "Spruce", "Sycamore", "Hawthorn",
];
const CITIES: &[&str] = &[
    "Avoca", "Brindleton", "Cobalt", "Dryden", "Estancia", "Fairvale",
    "Glenmara", "Halden", "Inisfree", "Junipero", "Kestrel", "Lockwood",
];

fn pick<'a, T: ?Sized>(rng: &mut StdRng, options: &'a [&'a T]) -> &'a T {
    let i = rng.gen_range(0..options.len());
    options[i]
}

fn fake_text(column_name: &str, rng: &mut StdRng) -> String {
    let lower = column_name.to_ascii_lowercase();
    if lower.contains("email") {
        let first = pick(rng, FIRST_NAMES).to_ascii_lowercase();
        let last = pick(rng, LAST_NAMES).to_ascii_lowercase();
        let last = last.replace(|c: char| !c.is_ascii_alphanumeric(), "");
        let n: u16 = rng.gen_range(10..999);
        format!("{first}.{last}{n}@example.com")
    } else if lower.contains("phone") || lower.contains("mobile") {
        let area: u16 = rng.gen_range(200..999);
        let prefix: u16 = rng.gen_range(200..999);
        let line: u16 = rng.gen_range(0..9999);
        format!("+1 {area:03} {prefix:03} {line:04}")
    } else if lower.contains("first_name") || lower.contains("given_name") {
        pick(rng, FIRST_NAMES).to_string()
    } else if lower.contains("last_name") || lower.contains("surname") {
        pick(rng, LAST_NAMES).to_string()
    } else if lower.contains("full_name") || lower == "name" {
        format!("{} {}", pick(rng, FIRST_NAMES), pick(rng, LAST_NAMES))
    } else if lower.contains("street") || lower.contains("address") {
        let number: u16 = rng.gen_range(100..9999);
        format!("{} {} St", number, pick(rng, STREET_NAMES))
    } else if lower.contains("city") {
        pick(rng, CITIES).to_string()
    } else if lower.contains("zip") || lower.contains("postal") {
        format!("{:05}", rng.gen_range(10000u32..99999))
    } else if lower.contains("ssn") || lower.contains("social_security") {
        format!(
            "{:03}-{:02}-{:04}",
            rng.gen_range(100u16..999),
            rng.gen_range(10u16..99),
            rng.gen_range(1000u16..9999)
        )
    } else if lower.contains("card_number") || lower.contains("credit_card") {
        // Looks-like-a-card but obviously fake (4242 prefix, no Luhn validity)
        format!(
            "4242 {:04} {:04} {:04}",
            rng.gen_range(1000u16..9999),
            rng.gen_range(1000u16..9999),
            rng.gen_range(1000u16..9999),
        )
    } else if lower.contains("cvv") || lower.contains("cvc") {
        format!("{:03}", rng.gen_range(100u16..999))
    } else {
        // Generic opaque string — preserves length bucket loosely.
        let len = rng.gen_range(6..14);
        let mut s = String::with_capacity(len);
        for _ in 0..len {
            let c = (b'a' + rng.gen_range(0u8..26)) as char;
            s.push(c);
        }
        s
    }
}

fn fake_date(real: &str, rng: &mut StdRng) -> chrono::NaiveDate {
    use chrono::NaiveDate;
    let parsed = NaiveDate::parse_from_str(real, "%Y-%m-%d").ok();
    let base = parsed.unwrap_or_else(|| {
        NaiveDate::from_ymd_opt(2020, 1, 1).expect("valid base date")
    });
    let offset_days: i64 = rng.gen_range(-365 * 2..365 * 2);
    base.checked_add_signed(chrono::Duration::days(offset_days))
        .unwrap_or(base)
}

fn fake_timestamp(real: &str, rng: &mut StdRng, tz: bool) -> String {
    use chrono::{DateTime, NaiveDateTime, Utc};
    let base_utc: DateTime<Utc> = real
        .parse::<DateTime<Utc>>()
        .ok()
        .or_else(|| {
            NaiveDateTime::parse_from_str(real, "%Y-%m-%d %H:%M:%S")
                .ok()
                .map(|n| n.and_utc())
        })
        .unwrap_or_else(|| Utc::now());
    let offset_secs: i64 = rng.gen_range(-365 * 86400i64 * 2..365 * 86400i64 * 2);
    let shifted = base_utc + chrono::Duration::seconds(offset_secs);
    if tz {
        shifted.to_rfc3339()
    } else {
        shifted.format("%Y-%m-%d %H:%M:%S").to_string()
    }
}

fn uuid_from_seed(rng: &mut StdRng) -> uuid::Uuid {
    let mut bytes = [0u8; 16];
    rng.fill(&mut bytes);
    // Set version (4) and variant (RFC 4122) bits so it looks like a v4 UUID.
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    uuid::Uuid::from_bytes(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key() -> [u8; 32] {
        [7u8; 32]
    }

    #[test]
    fn deterministic_for_same_input() {
        let a = fake_for(&key(), 16384, 2, "email", "TEXT", "real@example.com");
        let b = fake_for(&key(), 16384, 2, "email", "TEXT", "real@example.com");
        assert_eq!(a, b);
    }

    #[test]
    fn different_real_values_produce_different_fakes() {
        let a = fake_for(&key(), 16384, 2, "email", "TEXT", "alice@example.com");
        let b = fake_for(&key(), 16384, 2, "email", "TEXT", "bob@example.com");
        assert_ne!(a, b);
    }

    #[test]
    fn different_oids_produce_different_fakes() {
        // Same real value, different (table, column) classifications →
        // different fakes (domain separation in the HMAC input).
        let a = fake_for(&key(), 16384, 2, "email", "TEXT", "same@example.com");
        let b = fake_for(&key(), 99999, 2, "email", "TEXT", "same@example.com");
        assert_ne!(a, b);
    }

    #[test]
    fn email_column_produces_email_shape() {
        let v = fake_for(&key(), 1, 1, "email", "TEXT", "real@x.com");
        assert!(v.contains('@'), "expected email shape, got {v}");
        assert!(v.ends_with("@example.com"));
    }

    #[test]
    fn integer_column_produces_integer_string() {
        let v = fake_for(&key(), 1, 1, "id", "INT4", "12345");
        assert!(v.parse::<i64>().is_ok(), "expected integer, got {v}");
    }

    #[test]
    fn uuid_column_produces_uuid() {
        let v = fake_for(&key(), 1, 1, "id", "UUID", "abc");
        assert!(uuid::Uuid::parse_str(&v).is_ok(), "expected uuid, got {v}");
    }

    #[test]
    fn json_column_produces_redacted_object() {
        let v = fake_for(&key(), 1, 1, "data", "JSONB", "{\"real\":true}");
        assert_eq!(v, "{\"redacted\":true}");
    }

    #[test]
    fn date_column_produces_parseable_date() {
        let v = fake_for(&key(), 1, 1, "dob", "DATE", "1990-04-12");
        assert!(
            chrono::NaiveDate::parse_from_str(&v, "%Y-%m-%d").is_ok(),
            "expected date, got {v}"
        );
    }

    #[test]
    fn ssn_column_produces_ssn_shape() {
        let v = fake_for(&key(), 1, 1, "ssn", "TEXT", "111-22-3333");
        let parts: Vec<&str> = v.split('-').collect();
        assert_eq!(parts.len(), 3);
        assert_eq!(parts[0].len(), 3);
        assert_eq!(parts[1].len(), 2);
        assert_eq!(parts[2].len(), 4);
    }
}
