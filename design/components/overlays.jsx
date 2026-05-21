/* Modal/overlay surfaces: command palette, connection manager,
   shortcuts overlay, policy editor */

// ─── Command Palette ───────────────────────────────────────────────
const CommandPalette = ({ query = '', mode = 'global' }) => {
  const results = {
    global: [
      { group: 'Tables',     items: [
        { glyph: Icons.table, title: 'patients',       sub: 'public · staging · 12,840 rows', kbd: 'staging.public' },
        { glyph: Icons.table, title: 'patient_summary', sub: 'public · staging · view', kbd: 'view' },
      ]},
      { group: 'Columns',    items: [
        { glyph: Icons.column, title: 'patients.consent_flags', sub: 'bit(8) · 1 agent note', agent: true },
        { glyph: Icons.column, title: 'patients.address_jsonb', sub: 'jsonb · indexed' },
      ]},
      { group: 'Recent queries', items: [
        { glyph: Icons.history, title: 'select count(*) from appointments where starts_at::date…',
          sub: 'you · 4m ago', mono: true },
        { glyph: Icons.history, title: 'select id, mrn from patients where last_name ilike …',
          sub: 'agent · 8m ago', agent: true, mono: true },
      ]},
      { group: 'Commands',   items: [
        { glyph: Icons.bolt, title: 'Run query',          kbd: '⌘↵' },
        { glyph: Icons.lock, title: 'Pause agent',        kbd: '⌘.' },
        { glyph: Icons.shield, title: 'Edit policy…',     kbd: '' },
        { glyph: Icons.database, title: 'Connect to…',    kbd: '⌘⇧O' },
      ]},
    ],
    agent: [
      { group: 'Ask the agent', items: [
        { glyph: Icons.agentDot, title: 'Explain this table',     sub: 'patients · 24 cols' },
        { glyph: Icons.agentDot, title: 'Find rows by description', sub: 'natural language → WHERE' },
        { glyph: Icons.agentDot, title: 'Suggest an index',         sub: 'based on recent queries' },
      ]},
      { group: 'Recent agent sessions', items: [
        { glyph: Icons.history, title: 'Reconcile leads → patients', sub: '6m · 6 actions · 1 pending', agent: true },
        { glyph: Icons.history, title: 'Backfill appointment reasons', sub: 'yesterday · 24 actions', agent: true },
      ]},
    ]
  };
  const list = results[mode] || results.global;
  return (
    <div style={{
      width: 640, background: 'var(--bg-elevated)',
      borderRadius: 12, border: '1px solid var(--line-strong)',
      boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
      fontFamily: 'var(--font-ui)',
    }}>
      <div style={{
        padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 12,
        borderBottom: '1px solid var(--line-soft)',
      }}>
        <span style={{ color: 'var(--text-muted)', display: 'inline-flex' }}>
          <Icon d={<><circle cx="7" cy="7" r="4.5" /><line x1="10.5" y1="10.5" x2="13.5" y2="13.5" /></>} size={16} />
        </span>
        <span style={{ fontSize: 15, color: 'var(--text-primary)', flex: 1 }}>
          {query || <span style={{ color: 'var(--text-muted)' }}>
            Search tables, columns, queries, commands…
          </span>}
          {query && <span style={{
            display: 'inline-block', width: 1.5, height: 16, background: 'var(--agent)',
            verticalAlign: 'text-bottom', marginLeft: 1,
            animation: 'caret 1s steps(1) infinite',
          }} />}
        </span>
        <div style={{ display: 'flex', gap: 6 }}>
          <button style={{
            ...editorBtn, height: 22, fontSize: 10.5, padding: '0 8px',
            background: mode === 'global' ? 'var(--bg-elevated-2)' : 'transparent',
            color: mode === 'global' ? 'var(--text-primary)' : 'var(--text-muted)',
          }}>All</button>
          <button style={{
            ...editorBtn, height: 22, fontSize: 10.5, padding: '0 8px',
            color: mode === 'agent' ? 'var(--agent)' : 'var(--text-muted)',
            background: mode === 'agent' ? 'var(--agent-wash-hi)' : 'transparent',
            border: '1px solid ' + (mode === 'agent' ? 'var(--agent-line)' : 'var(--line-soft)'),
          }}>Ask agent</button>
        </div>
      </div>

      <div style={{ maxHeight: 420, overflow: 'hidden', padding: '6px 0' }}>
        {list.map((group, gi) => (
          <div key={gi}>
            <div style={{
              padding: '8px 16px 4px', fontSize: 10, letterSpacing: '0.08em',
              textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600,
            }}>{group.group}</div>
            {group.items.map((item, ii) => {
              const active = gi === 0 && ii === 0;
              return (
                <div key={ii} style={{
                  margin: '0 6px', padding: '8px 10px',
                  borderRadius: 6, display: 'flex', alignItems: 'center', gap: 10,
                  background: active ? 'var(--bg-elevated-2)' : 'transparent',
                  position: 'relative',
                }}>
                  {active && <AgentEdge style={{ borderRadius: '6px 0 0 6px' }} />}
                  <span style={{ color: item.agent ? 'var(--agent)' :
                    'var(--text-muted)', flex: '0 0 auto' }}>
                    {item.glyph}
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 12.5,
                      fontFamily: item.mono ? 'var(--font-mono)' : 'inherit',
                      color: 'var(--text-primary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>{item.title}</div>
                    {item.sub && (
                      <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                        {item.sub}
                      </div>
                    )}
                  </div>
                  {item.kbd && (
                    <span className="mono" style={{
                      fontSize: 10, color: 'var(--text-muted)',
                      padding: '2px 6px', borderRadius: 3,
                      background: active ? 'var(--bg-elevated)' : 'transparent',
                    }}>{item.kbd}</span>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      <div style={{
        padding: '8px 14px', borderTop: '1px solid var(--line-soft)',
        display: 'flex', alignItems: 'center', gap: 14, fontSize: 10.5,
        color: 'var(--text-muted)', background: 'var(--bg-panel)',
      }}>
        <span><Kbd>↑↓</Kbd> navigate</span>
        <span><Kbd>⏎</Kbd> open</span>
        <span><Kbd>⌘⏎</Kbd> run</span>
        <span><Kbd>⌥⏎</Kbd> open agent on</span>
        <div style={{ flex: 1 }} />
        <span>Esc to close</span>
      </div>
    </div>
  );
};

// ─── Connection manager ────────────────────────────────────────────
const ConnectionManager = ({ mode = 'list' }) => (
  <div style={{
    width: 720, background: 'var(--bg-elevated)', borderRadius: 12,
    border: '1px solid var(--line-strong)', boxShadow: 'var(--shadow-lg)',
    overflow: 'hidden', fontFamily: 'var(--font-ui)',
    display: 'flex', flexDirection: 'column',
    maxHeight: 560,
  }}>
    <div style={{
      padding: '14px 18px 12px', borderBottom: '1px solid var(--line-soft)',
      display: 'flex', alignItems: 'baseline', gap: 12,
    }}>
      <h2 className="serif" style={{ margin: 0, fontSize: 18, fontWeight: 500,
        color: 'var(--text-primary)' }}>
        {mode === 'edit' ? 'Edit connection' : 'Connections'}
      </h2>
      <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
        {mode === 'edit' ? 'lassomd-prod' : 'stored locally · OS keychain'}
      </span>
      <div style={{ flex: 1 }} />
      {mode === 'list' && (
        <button style={{
          height: 26, padding: '0 12px 0 8px', borderRadius: 5, border: 0,
          background: 'var(--text-primary)', color: 'var(--bg-app)',
          fontSize: 12, fontWeight: 500, display: 'inline-flex', alignItems: 'center', gap: 6,
        }}>{Icons.plus} New connection</button>
      )}
    </div>

    {mode === 'list' && (
      <div style={{ flex: 1, overflow: 'hidden' }}>
        {SCHEMA.connections.map((c, i) => (
          <div key={c.id} style={{
            padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 16,
            borderBottom: i === SCHEMA.connections.length - 1 ? 'none' : '1px solid var(--line-faint)',
            background: c.active ? 'var(--bg-elevated-2)' : 'transparent',
            position: 'relative',
          }}>
            {c.active && <div style={{
              position: 'absolute', left: 0, top: 8, bottom: 8, width: 2,
              background: 'var(--status-ok)', borderRadius: 1,
            }} />}
            <div style={{
              width: 32, height: 32, borderRadius: 8, flex: '0 0 auto',
              background: c.readOnly ? 'rgba(127, 168, 134, 0.10)' : 'rgba(212, 161, 85, 0.10)',
              border: '1px solid ' + (c.readOnly ? 'rgba(127, 168, 134, 0.3)' : 'rgba(212, 161, 85, 0.3)'),
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: c.readOnly ? 'var(--op-read)' : 'var(--op-write)',
            }}>
              {c.readOnly ? Icons.lock : Icons.database}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' }}>
                  {c.name}
                </span>
                {c.readOnly ? (
                  <span style={{
                    fontSize: 10, padding: '2px 7px', borderRadius: 3,
                    fontFamily: 'var(--font-mono)', letterSpacing: '0.05em', fontWeight: 600,
                    background: 'rgba(127, 168, 134, 0.14)', color: 'var(--op-read)',
                  }}>READ-ONLY</span>
                ) : (
                  <span style={{
                    fontSize: 10, padding: '2px 7px', borderRadius: 3,
                    fontFamily: 'var(--font-mono)', letterSpacing: '0.05em', fontWeight: 600,
                    background: 'rgba(212, 161, 85, 0.14)', color: 'var(--op-write)',
                  }}>READ/WRITE</span>
                )}
                {c.active && (
                  <span style={{
                    fontSize: 10, padding: '2px 7px', borderRadius: 3,
                    fontFamily: 'var(--font-mono)', letterSpacing: '0.05em',
                    color: 'var(--status-ok)',
                  }}>· CONNECTED</span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 2,
                fontSize: 11, color: 'var(--text-muted)',
                fontFamily: 'var(--font-mono)',
              }}>
                <span>{c.host}</span>
                <span>·</span>
                <span>tls</span>
                <span>·</span>
                <span>postgres 16.4</span>
              </div>
            </div>
            <button style={{ ...editorBtn, height: 24 }}>Edit</button>
            <button style={{ ...iconBtn, color: 'var(--text-muted)' }}>{Icons.more}</button>
          </div>
        ))}
      </div>
    )}

    {mode === 'edit' && (
      <div style={{ padding: '16px 20px', display: 'grid',
        gridTemplateColumns: '120px 1fr', gap: '14px 16px', fontSize: 12,
        alignItems: 'center',
      }}>
        {[
          ['Name', <input defaultValue="lassomd-prod" style={fieldStyle} />],
          ['Host',     <input defaultValue="prod.lassomd.internal" style={{...fieldStyle, fontFamily: 'var(--font-mono)'}} />],
          ['Port',     <input defaultValue="5432" style={{...fieldStyle, fontFamily: 'var(--font-mono)', width: 120}} />],
          ['Database', <input defaultValue="lassomd" style={{...fieldStyle, fontFamily: 'var(--font-mono)'}} />],
          ['User',     <input defaultValue="readonly_ops" style={{...fieldStyle, fontFamily: 'var(--font-mono)'}} />],
          ['Password',
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <input defaultValue="••••••••••••••" style={{...fieldStyle, flex: 1, fontFamily: 'var(--font-mono)'}} />
              <span style={{ fontSize: 10.5, color: 'var(--text-muted)',
                display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                <span style={{ color: 'var(--op-read)' }}>{Icons.lock}</span>
                stored in macOS keychain
              </span>
            </div>
          ],
          ['SSL/TLS',
            <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
              <Toggle on label="Require" />
              <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                verify-full · root CA: system
              </span>
            </div>
          ],
        ].map(([label, ctrl], i) => (
          <React.Fragment key={i}>
            <div style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>{label}</div>
            <div>{ctrl}</div>
          </React.Fragment>
        ))}

        <div style={{ gridColumn: '1 / -1', height: 1, background: 'var(--line-soft)',
          margin: '4px 0' }} />

        <div style={{ color: 'var(--text-secondary)', fontSize: 11.5 }}>Mode</div>
        <div>
          <div style={{
            padding: '10px 12px', borderRadius: 8,
            background: 'rgba(127, 168, 134, 0.06)',
            border: '1px solid rgba(127, 168, 134, 0.3)',
            display: 'flex', alignItems: 'flex-start', gap: 10,
          }}>
            <div style={{ paddingTop: 2 }}>
              <input type="radio" checked readOnly
                style={{ accentColor: 'var(--op-read)' }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: 'var(--op-read)' }}>{Icons.lock}</span>
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--op-read)' }}>
                  Read-only
                </span>
                <span style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
                  · recommended for prod
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4,
                lineHeight: 1.5 }}>
                Window chrome will be tinted green. Writes and DDL are rejected
                at the client layer before they reach Postgres. The agent cannot
                escalate without re-authenticating.
              </div>
            </div>
          </div>
          <div style={{
            marginTop: 6, padding: '10px 12px', borderRadius: 8,
            border: '1px solid var(--line-soft)',
            display: 'flex', alignItems: 'flex-start', gap: 10,
          }}>
            <div style={{ paddingTop: 2 }}>
              <input type="radio" readOnly style={{ accentColor: 'var(--op-write)' }} />
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: 'var(--op-write)' }}>{Icons.database}</span>
                <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>
                  Read / write
                </span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
                Writes go through your policy. Destructive ops always prompt.
              </div>
            </div>
          </div>
        </div>

        <div style={{ gridColumn: '1 / -1', display: 'flex', gap: 8, marginTop: 6 }}>
          <div style={{ flex: 1 }} />
          <button style={{ ...editorBtn, height: 30, padding: '0 14px' }}>Test connection</button>
          <button style={{
            height: 30, padding: '0 18px', borderRadius: 6, border: 0,
            background: 'var(--text-primary)', color: 'var(--bg-app)',
            fontSize: 12, fontWeight: 500,
          }}>Save</button>
        </div>
      </div>
    )}
  </div>
);

const Toggle = ({ on, label }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
    <span style={{
      width: 30, height: 18, borderRadius: 9,
      background: on ? 'var(--op-read)' : 'var(--line-strong)',
      position: 'relative', display: 'inline-block', transition: 'background .15s',
    }}>
      <span style={{
        position: 'absolute', top: 2, left: on ? 14 : 2,
        width: 14, height: 14, borderRadius: '50%', background: '#1a1714',
        transition: 'left .15s',
      }} />
    </span>
    <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
  </span>
);

const fieldStyle = {
  height: 28, width: '100%', padding: '0 10px',
  background: 'var(--bg-input)', border: '1px solid var(--line-default)',
  borderRadius: 5, color: 'var(--text-primary)', fontSize: 12,
  fontFamily: 'var(--font-ui)', outline: 'none',
};

// ─── Policy editor (used inline in agent surface) ──────────────────
const PolicyEditor = () => (
  <div style={{
    width: 480, background: 'var(--bg-elevated)', borderRadius: 12,
    border: '1px solid var(--line-strong)', boxShadow: 'var(--shadow-lg)',
    overflow: 'hidden', fontFamily: 'var(--font-ui)',
  }}>
    <div style={{ padding: '14px 18px 10px', borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ color: 'var(--agent)' }}>{Icons.shield}</span>
        <h2 className="serif" style={{ margin: 0, fontSize: 16, fontWeight: 500,
          color: 'var(--text-primary)' }}>
          Agent policy · lassomd-staging
        </h2>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
        Pre-approved patterns. Anything outside these prompts the human.
      </div>
    </div>
    <div style={{ padding: '12px 18px 16px' }}>
      {[
        { glyph: 'read', label: 'Read', target: 'any table in any schema',
          state: 'allow', detail: 'No prompt.' },
        { glyph: 'write', label: 'Write', target: 'public.* only · max 1000 rows / stmt',
          state: 'allow', detail: 'No prompt below threshold.' },
        { glyph: 'write', label: 'Write', target: 'audit.* · reporting.*',
          state: 'prompt', detail: 'Always prompt.' },
        { glyph: 'ddl', label: 'Schema change', target: 'CREATE / ALTER · any',
          state: 'prompt', detail: 'Always prompt. Shows diff.' },
        { glyph: 'destruct', label: 'Destructive', target: 'DELETE · TRUNCATE · DROP',
          state: 'prompt', detail: 'Always prompt + impact estimate.' },
        { glyph: 'destruct', label: 'Destructive', target: 'DROP TABLE · DROP SCHEMA',
          state: 'block', detail: 'Blocked. Requires you to disable this rule.' },
      ].map((r, i) => (
        <div key={i} style={{
          padding: '10px 12px', marginTop: i === 0 ? 0 : 4,
          borderRadius: 6, background: 'var(--bg-elevated-2)',
          display: 'flex', alignItems: 'center', gap: 12,
          border: '1px solid var(--line-faint)',
        }}>
          <OpGlyph kind={r.glyph} size={12} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 12, color: 'var(--text-primary)' }}>
              <span style={{ fontWeight: 500 }}>{r.label}</span>
              <span style={{ color: 'var(--text-muted)' }}> · </span>
              <span className="mono">{r.target}</span>
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>{r.detail}</div>
          </div>
          <span style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 3,
            fontFamily: 'var(--font-mono)', letterSpacing: '0.05em', fontWeight: 600,
            background:
              r.state === 'allow' ? 'rgba(127, 168, 134, 0.14)' :
              r.state === 'block' ? 'rgba(217, 108, 84, 0.14)' :
                                    'rgba(212, 161, 85, 0.14)',
            color:
              r.state === 'allow' ? 'var(--op-read)' :
              r.state === 'block' ? 'var(--op-destruct)' :
                                    'var(--op-write)',
          }}>{r.state.toUpperCase()}</span>
        </div>
      ))}
    </div>
    <div style={{
      padding: '10px 18px', borderTop: '1px solid var(--line-soft)',
      display: 'flex', alignItems: 'center', gap: 10, fontSize: 11,
      color: 'var(--text-muted)', background: 'var(--bg-panel)',
    }}>
      <span>3 session overrides · expire on disconnect</span>
      <div style={{ flex: 1 }} />
      <button style={editorBtn}>Reset</button>
      <button style={{...editorBtn, color: 'var(--text-primary)',
        background: 'var(--bg-elevated)'}}>Add rule</button>
    </div>
  </div>
);

// ─── Shortcuts overlay ─────────────────────────────────────────────
const ShortcutsOverlay = () => {
  const groups = [
    { name: 'Navigation', items: [
      ['⌘K',     'Command palette'],
      ['⌘P',     'Quick open table'],
      ['⌘⇧P',    'Quick open column'],
      ['⌘1–9',   'Jump to tab'],
      ['⌘\\',    'Toggle agent drawer'],
      ['⌘B',     'Toggle schema rail'],
      ['⌘⇧J',    'Toggle JSON viewer'],
    ]},
    { name: 'Editing', items: [
      ['⌘↵',     'Run query / selection'],
      ['⌘⇧↵',    'Run all queries in tab'],
      ['⌥⇧F',    'Format SQL'],
      ['⌘/',     'Toggle comment'],
      ['⌘D',     'Add cursor at next match'],
      ['F2',     'Rename symbol'],
    ]},
    { name: 'Agent', items: [
      ['⌘⇧A',    'Nudge / ask agent'],
      ['⌘.',     'Pause agent'],
      ['⏎',      'Approve pending'],
      ['Esc',    'Deny pending'],
      ['⌘⇧.',    'Open policy editor'],
      ['⌘⇧H',    'Open session timeline'],
    ]},
    { name: 'Results', items: [
      ['⌘F',     'Filter result set'],
      ['⌘E',     'Export…'],
      ['⌘C',     'Copy cell'],
      ['⌘⇧C',    'Copy as JSON'],
      ['⏎',      'Edit cell'],
      ['⌘Z',     'Undo cell edit'],
    ]},
  ];
  return (
    <div style={{
      width: 760, background: 'var(--bg-elevated)', borderRadius: 12,
      border: '1px solid var(--line-strong)', boxShadow: 'var(--shadow-lg)',
      overflow: 'hidden', fontFamily: 'var(--font-ui)',
    }}>
      <div style={{ padding: '14px 20px 8px', borderBottom: '1px solid var(--line-soft)',
        display: 'flex', alignItems: 'baseline', gap: 10 }}>
        <h2 className="serif" style={{ margin: 0, fontSize: 18, fontWeight: 500,
          color: 'var(--text-primary)' }}>Keyboard shortcuts</h2>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>· macOS</span>
        <div style={{ flex: 1 }} />
        <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>?</span>
      </div>
      <div style={{
        padding: '14px 20px 18px',
        display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '20px 32px',
      }}>
        {groups.map((g, gi) => (
          <div key={gi}>
            <div style={{
              fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
              color: g.name === 'Agent' ? 'var(--agent)' : 'var(--text-muted)',
              fontWeight: 600, marginBottom: 8,
              display: 'flex', alignItems: 'center', gap: 6,
            }}>
              {g.name === 'Agent' && <span>{Icons.agentDot}</span>}
              {g.name}
            </div>
            {g.items.map(([k, label]) => (
              <div key={k} style={{
                display: 'flex', alignItems: 'center', gap: 12,
                padding: '5px 0', fontSize: 12, color: 'var(--text-secondary)',
              }}>
                <span style={{ flex: 1 }}>{label}</span>
                {k.split(/\s/).map((part, i) => (
                  <Kbd key={i}>{part}</Kbd>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
};

Object.assign(window, { CommandPalette, ConnectionManager, PolicyEditor, ShortcutsOverlay, Toggle });
