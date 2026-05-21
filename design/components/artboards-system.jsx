/* The full design canvas content — sections + artboards.
   Each artboard composes pre-built components. */

// ─── helpers ───────────────────────────────────────────────────────
const ArtboardShell = ({ children, padded = true, bg = 'var(--bg-app)' }) => (
  <div style={{
    width: '100%', height: '100%', background: bg,
    fontFamily: 'var(--font-ui)', color: 'var(--text-primary)',
    overflow: 'hidden', display: 'flex', flexDirection: 'column',
    padding: padded ? 32 : 0,
  }}>
    {children}
  </div>
);

// ─── Visual system reference ────────────────────────────────────────
const SystemReference = () => (
  <ArtboardShell padded>
    <div className="serif" style={{ fontSize: 28, fontWeight: 500,
      letterSpacing: '-0.015em', color: 'var(--text-primary)', marginBottom: 4 }}>
      Visual system
    </div>
    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 28,
      maxWidth: 640, lineHeight: 1.6 }}>
      Warm dark canvas. One copper accent owns "the agent." User chrome stays
      neutral. Op semantics carry shape AND color, never color alone.
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
      gap: 28, flex: 1, minHeight: 0 }}>
      {/* Surfaces */}
      <div>
        <SystemHeading>Surfaces</SystemHeading>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 8,
          marginBottom: 20 }}>
          {['canvas', 'app', 'panel', 'elevated', 'elevated-2', 'input'].map(k => (
            <div key={k}>
              <div style={{
                height: 56, borderRadius: 6,
                background: `var(--bg-${k})`,
                border: '1px solid var(--line-default)',
              }} />
              <div className="mono" style={{ fontSize: 10, marginTop: 6,
                color: 'var(--text-muted)' }}>
                bg-{k}
              </div>
            </div>
          ))}
        </div>

        <SystemHeading>Identity colors</SystemHeading>
        <div style={{ display: 'flex', gap: 12, marginBottom: 20 }}>
          {[
            { name: 'agent', label: 'Agent', sub: 'copper — owns AI presence', c: 'var(--agent)' },
            { name: 'user', label: 'User', sub: 'cool sage — sparing', c: 'var(--user)' },
            { name: 'text-primary', label: 'Text', sub: 'warm off-white', c: 'var(--text-primary)' },
          ].map(x => (
            <div key={x.name} style={{ flex: 1 }}>
              <div style={{
                height: 56, borderRadius: 6, background: x.c,
              }} />
              <div style={{ marginTop: 6 }}>
                <div style={{ fontSize: 12, fontWeight: 500 }}>{x.label}</div>
                <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
                  --{x.name} · {x.sub}
                </div>
              </div>
            </div>
          ))}
        </div>

        <SystemHeading>Op semantics — shape + color</SystemHeading>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8 }}>
          {[
            { k: 'read',     label: 'Read',       sub: 'SELECT, EXPLAIN'  },
            { k: 'write',    label: 'Write',      sub: 'INSERT, UPDATE'    },
            { k: 'ddl',      label: 'Schema',     sub: 'CREATE, ALTER'     },
            { k: 'destruct', label: 'Destructive', sub: 'DELETE, DROP'     },
          ].map(o => (
            <div key={o.k} style={{
              padding: 12, borderRadius: 6,
              background: 'var(--bg-elevated)',
              border: '1px solid var(--line-soft)',
            }}>
              <OpGlyph kind={o.k} size={18} />
              <div style={{ marginTop: 8, fontSize: 11.5, fontWeight: 500,
                color: `var(--op-${o.k === 'destruct' ? 'destruct' : o.k})` }}>
                {o.label}
              </div>
              <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)',
                marginTop: 2 }}>
                {o.sub}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right column */}
      <div>
        <SystemHeading>Type</SystemHeading>
        <div style={{ marginBottom: 18 }}>
          <div className="serif" style={{ fontSize: 28, fontWeight: 500,
            letterSpacing: '-0.015em', lineHeight: 1.2,
            color: 'var(--text-primary)' }}>
            Reconciling lead → patient
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            <span className="mono">Source Serif 4 · 500</span> — agent's voice, section
            heads, modal titles. Used sparingly.
          </div>
        </div>
        <div style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 16, fontWeight: 500,
            color: 'var(--text-primary)', marginBottom: 2 }}>
            patients · 12,840 rows
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
            Result toolbar, copy, body labels.
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            <span className="mono">Geist · 400–500</span> — UI text.
          </div>
        </div>
        <div>
          <div className="mono" style={{ fontSize: 13, lineHeight: 1.6,
            color: 'var(--text-primary)' }}>
            <span className="sql-kw">select</span> id, mrn, last_name<br/>
            <span className="sql-kw">from</span> <span className="sql-id">patients</span> <span className="sql-kw">where</span> <span className="sql-id">deleted_at</span> <span className="sql-kw">is null</span>;
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
            <span className="mono">Geist Mono · 400</span> — code, SQL, data, identifiers.
          </div>
        </div>

        <div style={{ height: 1, background: 'var(--line-soft)', margin: '20px 0' }} />

        <SystemHeading>User vs. agent</SystemHeading>
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1, padding: 12, borderRadius: 6,
            background: 'var(--bg-elevated)', border: '1px solid var(--line-soft)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              {Icons.userDot}
              <span style={{ fontSize: 12, fontWeight: 500 }}>You</span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              No chrome. Default app appearance. The human is the assumed actor.
            </div>
          </div>
          <div style={{ flex: 1, padding: 12, borderRadius: 6,
            background: 'var(--agent-wash)', border: '1px solid var(--agent-line)',
            position: 'relative',
          }}>
            <AgentEdge style={{ borderRadius: '6px 0 0 6px' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
              {Icons.agentDot}
              <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--agent)' }}>
                Agent
              </span>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
              Copper wash, left-edge stripe, hex glyph. Always identifiable at a glance.
            </div>
          </div>
        </div>
      </div>
    </div>
  </ArtboardShell>
);

const SystemHeading = ({ children }) => (
  <div style={{
    fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
    color: 'var(--text-muted)', fontWeight: 600, marginBottom: 10,
  }}>{children}</div>
);

Object.assign(window, { ArtboardShell, SystemReference, SystemHeading });
