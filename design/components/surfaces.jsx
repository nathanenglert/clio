/* Main app surfaces: SchemaBrowser, TabBar, QueryEditor, ResultsGrid, StatusBar */

// ── Schema browser (left rail) ──────────────────────────────────────
const SchemaTree = ({ activeTable = 'patients', annotated = false, showAgentTouched = true }) => {
  const conn = SCHEMA.connections.find(c => c.active) || SCHEMA.connections[1];
  return (
    <div style={{ padding: '8px 0', fontSize: 12 }}>
      {/* connection header */}
      <div style={{
        padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 8,
        borderBottom: '1px solid var(--line-faint)',
      }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%',
          background: 'var(--status-ok)', boxShadow: '0 0 6px var(--status-ok)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontWeight: 500, color: 'var(--text-primary)' }}>{conn.name}</span>
            {!conn.readOnly && (
              <span className="mono" style={{
                fontSize: 9, padding: '1px 5px', borderRadius: 3, letterSpacing: '0.05em',
                background: 'rgba(212, 161, 85, 0.14)', color: 'var(--op-write)',
              }}>RW</span>
            )}
          </div>
          <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            {conn.host}
          </div>
        </div>
        <button style={iconBtn}>{Icons.refresh}</button>
      </div>

      {/* search */}
      <div style={{ padding: '8px 10px' }}>
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px',
          height: 26, borderRadius: 6,
          background: 'var(--bg-input)', border: '1px solid var(--line-soft)',
        }}>
          <span style={{ color: 'var(--text-muted)' }}>{Icons.search}</span>
          <span style={{ color: 'var(--text-muted)', flex: 1 }}>Filter schema…</span>
          <Kbd>⌘P</Kbd>
        </div>
      </div>

      {/* schemas */}
      {conn.schemas.map((s, i) => (
        <div key={s.name} style={{ marginTop: i === 0 ? 0 : 4 }}>
          <div style={{
            padding: '4px 12px', display: 'flex', alignItems: 'center', gap: 6,
            color: 'var(--text-secondary)', fontSize: 11, fontWeight: 500,
            letterSpacing: '0.02em', textTransform: 'uppercase',
          }}>
            <span style={{ transform: 'rotate(90deg)', display: 'inline-flex',
              color: 'var(--text-muted)' }}>{Icons.chevron}</span>
            <span>{s.name}</span>
            <span className="mono" style={{ marginLeft: 'auto', color: 'var(--text-muted)',
              fontSize: 10, textTransform: 'none', letterSpacing: 0 }}>{s.tables.length}</span>
          </div>
          {s.tables.map(t => {
            const isActive = s.name === 'public' && t.name === activeTable;
            const Glyph = t.isView || t.isMatView ? Icons.view : Icons.table;
            return (
              <div key={t.name} style={{
                position: 'relative',
                padding: '3px 12px 3px 28px',
                display: 'flex', alignItems: 'center', gap: 8,
                color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
                background: isActive ? 'var(--bg-elevated)' : 'transparent',
                cursor: 'default',
              }}>
                {isActive && (
                  <div style={{
                    position: 'absolute', left: 0, top: 2, bottom: 2, width: 2,
                    background: 'var(--text-secondary)', borderRadius: 1,
                  }} />
                )}
                <span style={{ color: t.isView || t.isMatView
                  ? 'var(--op-ddl)' : 'var(--text-muted)' }}>{Glyph}</span>
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden',
                  textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  fontFamily: 'var(--font-mono)', fontSize: 12,
                }}>{t.name}</span>
                {t.agentTouched && showAgentTouched && (
                  <span title="Agent inspected this table recently" style={{
                    width: 5, height: 5, borderRadius: '50%',
                    background: 'var(--agent)',
                    boxShadow: '0 0 4px rgba(212, 145, 90, 0.6)',
                  }} />
                )}
                {t.pinned && (
                  <span style={{ color: 'var(--agent)', display: 'inline-flex' }}>{Icons.pin}</span>
                )}
                <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  {t.rows}
                </span>
              </div>
            );
          })}
        </div>
      ))}

      {annotated && (
        /* Agent's pinned annotation appearing inside the tree (v0.3 preview) */
        <div style={{
          margin: '12px 10px', padding: 10, position: 'relative',
          background: 'var(--agent-wash)', border: '1px solid var(--agent-line)',
          borderRadius: 6, fontSize: 11, color: 'var(--text-primary)',
        }}>
          <AgentEdge />
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
            <span style={{ color: 'var(--agent)', display: 'inline-flex' }}>
              {Icons.agentDot}
            </span>
            <span style={{ fontWeight: 500, color: 'var(--agent)' }}>Note · patients</span>
            <span className="mono" style={{ marginLeft: 'auto', fontSize: 10,
              color: 'var(--text-muted)' }}>2m ago</span>
          </div>
          <div style={{ color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            <span className="mono" style={{ color: 'var(--text-primary)' }}>consent_flags</span>
            {' '}is bit(8) not enum. Bit 3 = SMS, bit 5 = email. Don't filter by integer
            equality.
          </div>
        </div>
      )}
    </div>
  );
};

// ── Tab bar ─────────────────────────────────────────────────────────
const TabBar = ({ tabs, active = 0, agentTab = null, dense }) => (
  <div style={{
    display: 'flex', alignItems: 'stretch', height: dense ? 32 : 36, flex: '0 0 auto',
    background: 'var(--bg-panel)', borderBottom: '1px solid var(--line-soft)',
    paddingLeft: 4,
  }}>
    {tabs.map((tab, i) => {
      const isActive = i === active;
      const isAgent = i === agentTab;
      return (
        <div key={i} style={{
          position: 'relative',
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '0 10px 0 12px',
          background: isActive ? 'var(--bg-app)' : 'transparent',
          color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
          borderRight: '1px solid var(--line-soft)',
          fontSize: 12,
          maxWidth: 220,
        }}>
          {isAgent && <AgentEdge />}
          {tab.glyph && <span style={{
            color: isAgent ? 'var(--agent)' : 'var(--text-muted)' }}>{tab.glyph}</span>}
          <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis',
            whiteSpace: 'nowrap', fontFamily: tab.mono ? 'var(--font-mono)' : 'inherit',
            fontSize: tab.mono ? 11 : 12,
          }}>
            {tab.label}
          </span>
          {tab.dirty && <span style={{ width: 5, height: 5, borderRadius: '50%',
            background: 'var(--text-secondary)' }} />}
          <button style={{
            ...iconBtn, width: 16, height: 16, opacity: 0.5,
          }}>{Icons.close}</button>
        </div>
      );
    })}
    <button style={{
      ...iconBtn, padding: '0 10px', borderRadius: 0,
    }}>{Icons.plus}</button>
  </div>
);

// ── Query editor ────────────────────────────────────────────────────
const QueryEditor = ({ lines, runLabel = 'Run', destructive, agent, lineNos = true, height }) => (
  <div style={{
    background: 'var(--bg-input)', position: 'relative', flex: height ? '0 0 auto' : '1 1 auto',
    minHeight: 0, display: 'flex', flexDirection: 'column',
    height,
  }}>
    {/* editor toolbar */}
    <div style={{
      height: 32, flex: '0 0 auto', display: 'flex', alignItems: 'center',
      padding: '0 8px 0 12px', borderBottom: '1px solid var(--line-soft)',
      gap: 10, background: 'var(--bg-app)',
    }}>
      <button style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, height: 22, padding: '0 10px',
        background: destructive ? 'var(--op-destruct-soft)' : 'var(--op-read-soft)',
        color: destructive ? 'var(--op-destruct)' : 'var(--op-read)',
        border: '1px solid ' + (destructive ? 'rgba(217,108,84,0.3)' : 'rgba(127,168,134,0.3)'),
        borderRadius: 5, fontSize: 11, fontWeight: 500, fontFamily: 'var(--font-ui)',
      }}>
        {Icons.play}
        <span>{runLabel}</span>
        <Kbd>⌘↵</Kbd>
      </button>
      <button style={editorBtn}>Format <Kbd>⌥⇧F</Kbd></button>
      <button style={editorBtn}>EXPLAIN</button>
      <div style={{ flex: 1 }} />
      {agent && <AgentBadge label="written by agent" />}
      <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
        SQL · UTF-8 · LF
      </span>
    </div>

    {/* code area */}
    <div style={{
      flex: '1 1 auto', minHeight: 0, padding: '10px 0', display: 'flex',
      fontFamily: 'var(--font-mono)', fontSize: 12.5, lineHeight: '1.65',
      overflow: 'hidden',
    }}>
      {lineNos && (
        <div style={{
          padding: '0 12px', textAlign: 'right', color: 'var(--text-faint)',
          userSelect: 'none', flex: '0 0 auto',
        }}>
          {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
        </div>
      )}
      <div style={{ flex: 1, paddingRight: 16 }}>
        {lines.map((ln, i) => (
          <div key={i} dangerouslySetInnerHTML={{ __html: ln || '&nbsp;' }} />
        ))}
      </div>
    </div>
  </div>
);

// ── Results grid (virtualized look) ─────────────────────────────────
const ResultsGrid = ({ cols = PATIENT_COLS, rows = PATIENT_ROWS, meta, jsonOpen, activeCell }) => {
  const totalW = cols.reduce((a, c) => a + c.w, 0);
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      background: 'var(--bg-app)', overflow: 'hidden',
    }}>
      {/* result toolbar */}
      <div style={{
        height: 30, flex: '0 0 auto', display: 'flex', alignItems: 'center',
        padding: '0 10px', gap: 12,
        background: 'var(--bg-panel)', borderBottom: '1px solid var(--line-soft)',
        fontSize: 11, color: 'var(--text-secondary)',
      }}>
        <StatusPill tone="ok" mono>
          {meta?.rows || '12,840'} rows · {meta?.ms || '86'} ms
        </StatusPill>
        <span style={{ color: 'var(--line-strong)' }}>│</span>
        <span className="mono" style={{ color: 'var(--text-muted)' }}>
          {meta?.query || 'select * from patients order by created_at desc limit 200'}
        </span>
        <div style={{ flex: 1 }} />
        <button style={editorBtn}>{Icons.filter} Filter</button>
        <button style={editorBtn}>{Icons.export} Export</button>
        <button style={editorBtn}>{Icons.refresh}</button>
      </div>

      <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
        {/* the grid */}
        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {/* header */}
          <div style={{
            display: 'flex', height: 28, background: 'var(--bg-panel)',
            borderBottom: '1px solid var(--line-default)',
            fontSize: 11, color: 'var(--text-secondary)',
            fontFamily: 'var(--font-mono)',
            position: 'sticky', top: 0,
          }}>
            <div style={{ width: 40, flex: '0 0 auto', textAlign: 'right',
              padding: '7px 8px', color: 'var(--text-faint)' }}>#</div>
            {cols.map((c, i) => (
              <div key={i} style={{
                width: c.w, flex: '0 0 auto', padding: '6px 10px',
                borderRight: '1px solid var(--line-faint)',
                display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <span style={{ color: 'var(--text-primary)' }}>{c.name}</span>
                {c.idx && <span title="indexed"
                  style={{ color: 'var(--text-muted)', fontSize: 9 }}>{Icons.index}</span>}
                <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', fontSize: 10 }}>
                  {c.type}
                </span>
              </div>
            ))}
          </div>
          {/* rows */}
          <div>
            {rows.map((row, ri) => (
              <div key={ri} style={{
                display: 'flex', height: 28,
                borderBottom: '1px solid var(--line-faint)',
                background: ri % 2 ? 'transparent' : 'rgba(255,240,220,0.012)',
                fontFamily: 'var(--font-mono)', fontSize: 11.5,
                color: 'var(--text-primary)',
              }}>
                <div style={{ width: 40, flex: '0 0 auto', textAlign: 'right',
                  padding: '7px 8px', color: 'var(--text-faint)' }}>{ri + 1}</div>
                {row.map((cell, ci) => {
                  const isActive = activeCell && activeCell[0] === ri && activeCell[1] === ci;
                  const col = cols[ci];
                  const isNull = cell === null;
                  const isJson = col?.type === 'jsonb';
                  return (
                    <div key={ci} style={{
                      width: col.w, flex: '0 0 auto', padding: '7px 10px',
                      borderRight: '1px solid var(--line-faint)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      color: isNull ? 'var(--text-faint)' : isJson ? 'var(--op-ddl)' : 'inherit',
                      fontStyle: isNull ? 'italic' : 'normal',
                      background: isActive ? 'rgba(212, 145, 90, 0.14)' : 'transparent',
                      boxShadow: isActive ? 'inset 0 0 0 1px var(--agent-line)' : 'none',
                    }}>
                      {isNull ? 'null' : cell}
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/* JSON sidebar (jsonb cell viewer) */}
        {jsonOpen && (
          <div style={{
            width: 320, flex: '0 0 auto',
            borderLeft: '1px solid var(--line-default)',
            background: 'var(--bg-panel)',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{
              height: 30, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8,
              borderBottom: '1px solid var(--line-soft)', flex: '0 0 auto',
              fontSize: 11, color: 'var(--text-secondary)',
            }}>
              <span style={{ color: 'var(--op-ddl)' }}>{Icons.json}</span>
              <span className="mono">address_jsonb</span>
              <span style={{ color: 'var(--text-faint)' }}>· row 1</span>
              <div style={{ flex: 1 }} />
              <button style={iconBtn}>{Icons.close}</button>
            </div>
            <div style={{ padding: 12, fontFamily: 'var(--font-mono)', fontSize: 11.5,
              lineHeight: 1.6, color: 'var(--text-primary)', flex: 1, overflow: 'auto' }}>
              <div>{'{'}</div>
              <div style={{ paddingLeft: 16 }}>
                <span className="sql-str">"street"</span>: <span className="sql-str">"1842 Webster St"</span>,
              </div>
              <div style={{ paddingLeft: 16 }}>
                <span className="sql-str">"city"</span>: <span className="sql-str">"Oakland"</span>,
              </div>
              <div style={{ paddingLeft: 16 }}>
                <span className="sql-str">"state"</span>: <span className="sql-str">"CA"</span>,
              </div>
              <div style={{ paddingLeft: 16 }}>
                <span className="sql-str">"zip"</span>: <span className="sql-str">"94612"</span>,
              </div>
              <div style={{ paddingLeft: 16 }}>
                <span className="sql-str">"verified_at"</span>: <span className="sql-str">"2025-11-04T09:12:00Z"</span>,
              </div>
              <div style={{ paddingLeft: 16 }}>
                <span className="sql-str">"geo"</span>: {'{'}
              </div>
              <div style={{ paddingLeft: 32 }}>
                <span className="sql-str">"lat"</span>: <span className="sql-num">37.8095</span>,
              </div>
              <div style={{ paddingLeft: 32 }}>
                <span className="sql-str">"lng"</span>: <span className="sql-num">-122.2696</span>
              </div>
              <div style={{ paddingLeft: 16 }}>{'}'}</div>
              <div>{'}'}</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

// ── Status bar ──────────────────────────────────────────────────────
const StatusBar = ({ agentActive, queued }) => (
  <div style={{
    height: 24, flex: '0 0 auto', display: 'flex', alignItems: 'center',
    padding: '0 12px', gap: 14,
    background: 'var(--bg-panel)', borderTop: '1px solid var(--line-soft)',
    fontSize: 10, color: 'var(--text-muted)',
  }}>
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%',
        background: 'var(--status-ok)' }} />
      <span className="mono">lassomd-staging</span>
      <span>·</span>
      <span>postgres 16.4</span>
    </span>
    <span style={{ color: 'var(--line-strong)' }}>│</span>
    <span className="mono">14 conn · idle 12 · active 2</span>
    <span style={{ color: 'var(--line-strong)' }}>│</span>
    <span className="mono">tx: none</span>
    <div style={{ flex: 1 }} />
    {agentActive && (
      <>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          color: 'var(--agent)',
        }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%',
            background: 'var(--agent)',
            boxShadow: '0 0 6px 1px rgba(212, 145, 90, 0.55)' }} />
          <span>agent active</span>
          {queued != null && <span className="mono">· {queued} queued</span>}
        </span>
        <span style={{ color: 'var(--line-strong)' }}>│</span>
      </>
    )}
    <span className="mono">UTC −08:00</span>
    <span style={{ color: 'var(--line-strong)' }}>│</span>
    <span>policy: <span style={{ color: 'var(--text-secondary)' }}>read-any · write-public</span></span>
  </div>
);

// ── shared button styles ────────────────────────────────────────────
const iconBtn = {
  width: 22, height: 22, display: 'inline-flex', alignItems: 'center',
  justifyContent: 'center', borderRadius: 4, background: 'transparent',
  border: 0, color: 'var(--text-muted)', cursor: 'pointer', padding: 0,
};
const editorBtn = {
  display: 'inline-flex', alignItems: 'center', gap: 6, height: 22, padding: '0 8px',
  background: 'transparent', color: 'var(--text-secondary)',
  border: '1px solid var(--line-soft)',
  borderRadius: 5, fontSize: 11, fontFamily: 'var(--font-ui)',
};

Object.assign(window, {
  SchemaTree, TabBar, QueryEditor, ResultsGrid, StatusBar,
  iconBtn, editorBtn,
});
