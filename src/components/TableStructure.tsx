// Structure view for a table/view/matview. Mounted inside the Workspace when
// a "table" tab is in Structure mode. Reads from the cached TableDescription
// produced by useEditing's describe_table call.

import { useState } from "react";
import type {
  ConstraintInfo,
  IndexInfo,
  TableDescription,
  TriggerInfo,
} from "../lib/api";

type Facet = "columns" | "indexes" | "constraints" | "triggers" | "activity";

type Props = {
  schema: string;
  table: string;
  /** Null while the describe_table fetch is in flight. */
  description: TableDescription | null;
};

const FACETS: { id: Facet; label: string }[] = [
  { id: "columns", label: "Columns" },
  { id: "indexes", label: "Indexes" },
  { id: "constraints", label: "Constraints" },
  { id: "triggers", label: "Triggers" },
  { id: "activity", label: "Activity" },
];

export function TableStructure({ schema, table, description }: Props) {
  const [facet, setFacet] = useState<Facet>("columns");

  if (!description) {
    return (
      <div className="ts-loading mono">
        loading <span className="ts-loading-target">{schema}.{table}</span>…
      </div>
    );
  }

  const view = description.view_definition;
  const counts: Record<Facet, number> = {
    columns: description.columns.length,
    indexes: description.indexes.length,
    constraints: description.constraints.length,
    triggers: description.triggers.length,
    activity: 0,
  };

  return (
    <div className="table-structure">
      <div className="ts-header">
        <span className="ts-name mono">
          <span className="ts-name-schema">{schema}.</span>
          {table}
        </span>
        <KindBadge kind={description.kind} />
      </div>

      <div className="ts-facets">
        {FACETS.map((f) => (
          <button
            key={f.id}
            className={`ts-facet${facet === f.id ? " on" : ""}`}
            onClick={() => setFacet(f.id)}
          >
            <span>{f.label}</span>
            {f.id !== "activity" && (
              <span className="ts-facet-count mono">{counts[f.id]}</span>
            )}
          </button>
        ))}
      </div>

      <div className="ts-body">
        {view && (facet === "columns" || facet === "indexes") && (
          <ViewBanner view={view} />
        )}
        {facet === "columns" && <ColumnsPane description={description} />}
        {facet === "indexes" && <IndexesPane indexes={description.indexes} />}
        {facet === "constraints" && (
          <ConstraintsPane constraints={description.constraints} />
        )}
        {facet === "triggers" && <TriggersPane triggers={description.triggers} />}
        {facet === "activity" && <ActivityPane />}
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: TableDescription["kind"] }) {
  if (kind === "table") return null; // ordinary tables don't need a badge
  const label = ({
    view: "VIEW",
    matview: "MATVIEW",
    partitioned: "PARTITIONED",
    foreign: "FOREIGN",
  } as const)[kind];
  return <span className="ts-kind-badge mono">{label}</span>;
}

function ViewBanner({ view }: { view: { sql: string; is_materialized: boolean } }) {
  return (
    <div className="ts-view-banner">
      <div className="ts-view-banner-head mono">
        {view.is_materialized ? "MATERIALIZED VIEW · definition" : "VIEW · definition"}
      </div>
      <pre className="ts-view-sql mono">{view.sql}</pre>
    </div>
  );
}

function ColumnsPane({ description }: { description: TableDescription }) {
  const cols = description.columns;
  if (cols.length === 0) {
    return <Empty>No columns reported by the catalog.</Empty>;
  }
  return (
    <div className="ts-list">
      {cols.map((c) => (
        <div key={c.name} className="ts-col-row">
          <span className="ts-col-glyph" aria-hidden>
            {c.is_primary_key ? "◆" : "·"}
          </span>
          <span className="ts-col-name mono">{c.name}</span>
          {!c.is_nullable && <span className="ts-tag mono">NOT NULL</span>}
          {c.is_nullable && <span className="ts-tag ts-tag-faint mono">NULL</span>}
          {c.default && (
            <span className="ts-col-default mono" title={c.default}>
              = {c.default}
            </span>
          )}
          {c.enum_values && c.enum_values.length > 0 && (
            <span className="ts-col-enum mono" title={c.enum_values.join(", ")}>
              {c.enum_values.length} values
            </span>
          )}
          <span className="ts-col-type mono">{c.data_type}</span>
        </div>
      ))}
    </div>
  );
}

function IndexesPane({ indexes }: { indexes: IndexInfo[] }) {
  if (indexes.length === 0) {
    return <Empty>No indexes on this relation.</Empty>;
  }
  return (
    <div className="ts-list">
      {indexes.map((ix) => (
        <div key={ix.name} className="ts-card">
          <div className="ts-card-head">
            <span className="ts-card-name mono">{ix.name}</span>
            {ix.is_primary && <span className="ts-tag ts-tag-pk mono">PRIMARY</span>}
            {ix.is_unique && !ix.is_primary && (
              <span className="ts-tag mono">UNIQUE</span>
            )}
            <span className="ts-card-cols mono">({ix.columns.join(", ")})</span>
          </div>
          <pre className="ts-card-def mono">{ix.definition}</pre>
        </div>
      ))}
    </div>
  );
}

function ConstraintsPane({ constraints }: { constraints: ConstraintInfo[] }) {
  if (constraints.length === 0) {
    return <Empty>No constraints on this relation.</Empty>;
  }
  return (
    <div className="ts-list">
      {constraints.map((c) => (
        <div key={c.name} className="ts-card">
          <div className="ts-card-head">
            <span className={`ts-tag ts-tag-${c.kind} mono`}>
              {kindLabel(c.kind)}
            </span>
            <span className="ts-card-name mono">{c.name}</span>
            {c.columns.length > 0 && (
              <span className="ts-card-cols mono">({c.columns.join(", ")})</span>
            )}
            {c.references && (
              <span className="ts-card-ref mono">
                → {c.references.schema}.{c.references.table}
                ({c.references.columns.join(", ")})
              </span>
            )}
          </div>
          <pre className="ts-card-def mono">{c.definition}</pre>
        </div>
      ))}
    </div>
  );
}

function kindLabel(k: ConstraintInfo["kind"]): string {
  return ({
    primary_key: "PK",
    foreign_key: "FK",
    unique: "UNIQUE",
    check: "CHECK",
    exclusion: "EXCLUDE",
  } as const)[k];
}

function TriggersPane({ triggers }: { triggers: TriggerInfo[] }) {
  if (triggers.length === 0) {
    return <Empty>No triggers on this relation.</Empty>;
  }
  return (
    <div className="ts-list">
      {triggers.map((t) => (
        <div key={t.name} className="ts-card">
          <div className="ts-card-head">
            <span className="ts-card-name mono">{t.name}</span>
            <span className="ts-tag mono">{t.timing}</span>
            <span className="ts-tag mono">{t.events}</span>
            <span className="ts-tag ts-tag-faint mono">{t.level}</span>
          </div>
          <pre className="ts-card-def mono">{t.definition}</pre>
        </div>
      ))}
    </div>
  );
}

function ActivityPane() {
  return (
    <Empty>
      Per-table activity — coming soon. Use the activity strip below for
      session-wide events.
    </Empty>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="ts-empty">{children}</div>;
}
