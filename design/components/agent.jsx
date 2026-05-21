/* Agent activity surface — 3 directions
   A · Right Dock — persistent panel, focus + stream split
   B · Bottom Drawer — collapses to status strip when calm
   C · Inline Annotations — decorates the workspace, no separate panel
*/

// ─── Shared sub-components ────────────────────────────────────────

// "Focus card" — what the agent is currently doing, at the top of every variant
const AgentFocus = ({ kind = 'compact' }) => (
  <div style={{
    padding: kind === 'compact' ? '10px 14px 12px' : '14px 16px 16px',
    borderBottom: '1px solid var(--agent-line)',
    background: 'var(--agent-wash)',
    position: 'relative',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
      <AgentBadge pulse />
      <span style={{ color: 'var(--text-muted)', fontSize: 11 }}>focused on</span>
      <span className="mono" style={{ marginLeft: 'auto', fontSize: 10,
        color: 'var(--text-muted)' }}>
        06:42 elapsed
      </span>
    </div>
    <div style={{
      fontSize: kind === 'compact' ? 13 : 15, fontWeight: 500,
      color: 'var(--text-primary)', marginBottom: 4,
      fontFamily: 'var(--font-serif)', letterSpacing: '-0.01em',
    }}>
      Reconciling lead → patient conversion
    </div>
    <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
      Looking at <span className="mono" style={{ color: 'var(--text-primary)' }}>leads</span>
      {' '}and <span className="mono" style={{ color: 'var(--text-primary)' }}>patients</span>
      {' '}joined on <span className="mono" style={{ color: 'var(--text-primary)' }}>phone_e164</span>.
      Found 218 leads marked <span className="mono">expired</span> but still tied to active appointments.
    </div>
    <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center',
      fontSize: 10.5, color: 'var(--text-muted)' }}>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <OpGlyph kind="read" size={7} /> 4 reads
      </span>
      <span style={{ color: 'var(--line-strong)' }}>·</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
        <OpGlyph kind="write" size={7} /> 1 write
      </span>
      <span style={{ color: 'var(--line-strong)' }}>·</span>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5,
        color: 'var(--op-destruct)' }}>
        <OpGlyph kind="destruct" size={7} /> 1 awaiting approval
      </span>
    </div>
  </div>
);

// A single stream row
const StreamRow = ({ entry, last, dense }) => {
  const c = entry.kind === 'destruct' ? 'var(--op-destruct)'
          : entry.kind === 'write'    ? 'var(--op-write)'
          : 'var(--op-read)';
  return (
    <div style={{
      display: 'flex', gap: 10, padding: dense ? '6px 14px' : '8px 14px',
      borderBottom: last ? 'none' : '1px solid var(--line-faint)',
      position: 'relative',
      background: entry.awaiting ? 'rgba(217, 108, 84, 0.06)' : 'transparent',
    }}>
      {/* timeline rail glyph */}
      <div style={{ width: 12, flex: '0 0 auto', display: 'flex', justifyContent: 'center',
        paddingTop: 4 }}>
        <OpGlyph kind={entry.kind} size={10} />
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 3 }}>
          <span style={{ fontSize: 11, fontWeight: 500, color: c,
            fontFamily: 'var(--font-mono)', letterSpacing: '0.02em',
          }}>{entry.verb}</span>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-faint)',
            marginLeft: 'auto' }}>{entry.t}</span>
        </div>
        <div className="mono" style={{
          fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5,
          wordBreak: 'break-word',
        }}>
          {entry.detail}
        </div>
        {(entry.rows != null || entry.ms != null || entry.awaiting) && (
          <div style={{ marginTop: 4, display: 'flex', gap: 10, fontSize: 10,
            color: 'var(--text-muted)', alignItems: 'center' }}>
            {entry.rows != null && <span className="mono">{entry.rows} rows</span>}
            {entry.ms != null && <span className="mono">{entry.ms} ms</span>}
            {entry.awaiting && (
              <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center',
                gap: 6, padding: '2px 7px', background: 'var(--op-destruct-soft)',
                color: 'var(--op-destruct)', borderRadius: 4, fontWeight: 500,
                fontSize: 10, letterSpacing: '0.02em',
              }}>
                {Icons.warn} awaiting your approval
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// Permission-gate inline card (used in stream and as a modal)
const PermissionCard = ({ destructive = true, compact, agentText, sql, est, deviation }) => (
  <div style={{
    margin: compact ? 8 : 12, padding: compact ? 12 : 16,
    background: 'var(--bg-elevated)',
    border: `1px solid ${destructive ? 'var(--op-destruct)' : 'var(--op-write)'}`,
    borderLeftWidth: 3,
    borderRadius: 8, position: 'relative',
  }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
      <OpGlyph kind={destructive ? 'destruct' : 'write'} size={12} />
      <span style={{
        fontSize: 10.5, letterSpacing: '0.08em', fontWeight: 600,
        color: destructive ? 'var(--op-destruct)' : 'var(--op-write)',
        fontFamily: 'var(--font-mono)',
      }}>
        {destructive ? 'PERMISSION REQUIRED · DESTRUCTIVE' : 'PERMISSION REQUIRED · WRITE'}
      </span>
      <span className="mono" style={{ marginLeft: 'auto', fontSize: 10,
        color: 'var(--text-muted)' }}>step 6/6</span>
    </div>

    {deviation && (
      <div style={{
        marginBottom: 12, padding: '7px 10px', borderRadius: 5,
        background: 'rgba(217, 108, 84, 0.08)',
        border: '1px dashed rgba(217, 108, 84, 0.35)',
        fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5,
      }}>
        <span style={{ color: 'var(--op-destruct)', fontWeight: 500 }}>
          Outside policy.
        </span>{' '}
        Policy allows <span className="mono">write</span> to <span className="mono">public.*</span>,
        but disallows <span className="mono">DELETE</span> without a row-count limit.
      </div>
    )}

    <div style={{ fontSize: 12.5, color: 'var(--text-primary)', marginBottom: 12,
      lineHeight: 1.55,
    }}>
      {agentText}
    </div>

    <div style={{
      padding: '10px 12px', background: 'var(--bg-input)',
      border: '1px solid var(--line-default)', borderRadius: 6,
      fontFamily: 'var(--font-mono)', fontSize: 11.5, lineHeight: 1.65,
      color: 'var(--text-primary)', marginBottom: 12, overflow: 'hidden',
    }}>
      {sql}
    </div>

    {est && (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: 11,
        color: 'var(--text-secondary)', marginBottom: 12,
      }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          {Icons.warn}
          <span>Estimated impact:</span>
          <span className="mono" style={{ color: destructive ? 'var(--op-destruct)' :
            'var(--op-write)', fontWeight: 500 }}>{est}</span>
        </span>
      </div>
    )}

    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <button style={{
        flex: 1, height: 32, borderRadius: 6, border: 0,
        background: destructive ? 'var(--op-destruct)' : 'var(--op-write)',
        color: '#1a1714', fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 500,
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      }}>
        {destructive ? 'Allow this one time' : 'Allow'}
        <Kbd>⏎</Kbd>
      </button>
      <button style={{
        height: 32, padding: '0 14px', borderRadius: 6,
        background: 'var(--bg-elevated-2)', color: 'var(--text-primary)',
        border: '1px solid var(--line-default)',
        fontFamily: 'var(--font-ui)', fontSize: 12, fontWeight: 500,
        display: 'inline-flex', alignItems: 'center', gap: 8,
      }}>
        Deny
        <Kbd dim>Esc</Kbd>
      </button>
      <button style={{
        ...editorBtn, height: 32, padding: '0 10px',
        color: 'var(--text-muted)', fontSize: 11,
      }}>
        Modify
      </button>
    </div>

    <div style={{ marginTop: 10, fontSize: 10.5, color: 'var(--text-muted)',
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <input type="checkbox" style={{ accentColor: 'var(--agent)' }} />
      <span>Allow similar <span className="mono">DELETE</span> with{' '}
        <span className="mono">created_at &lt; …</span> filter for this session
      </span>
    </div>
  </div>
);

// ─── Variant A · Right Dock ────────────────────────────────────────
const AgentDockRight = ({ width = 340 }) => (
  <div style={{
    width, flex: '0 0 auto', display: 'flex', flexDirection: 'column',
    background: 'var(--bg-panel)',
    borderLeft: '1px solid var(--line-default)',
    position: 'relative',
  }}>
    {/* dock header */}
    <div style={{
      height: 32, flex: '0 0 auto', display: 'flex', alignItems: 'center',
      padding: '0 12px', gap: 8,
      borderBottom: '1px solid var(--line-soft)',
      background: 'var(--bg-panel)',
    }}>
      <span style={{ display: 'inline-flex' }}>{Icons.agentDot}</span>
      <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text-primary)' }}>Agent</span>
      <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>·
        Claude Code</span>
      <div style={{ flex: 1 }} />
      <button style={iconBtn}>{Icons.history}</button>
      <button style={iconBtn}>{Icons.more}</button>
    </div>

    {/* focus */}
    <AgentFocus />

    {/* activity stream label */}
    <div style={{
      padding: '10px 14px 6px', display: 'flex', alignItems: 'center', gap: 8,
      fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
      color: 'var(--text-muted)', fontWeight: 600,
    }}>
      <span>Activity</span>
      <span style={{ flex: 1, height: 1, background: 'var(--line-faint)' }} />
      <span className="mono" style={{ textTransform: 'none', letterSpacing: 0 }}>6 events</span>
    </div>

    {/* stream */}
    <div style={{ flex: 1, overflow: 'hidden' }}>
      {AGENT_LOG.slice().reverse().map((e, i, arr) => (
        <StreamRow key={i} entry={e} last={i === arr.length - 1} />
      ))}
    </div>

    {/* compose hint */}
    <div style={{
      padding: 10, borderTop: '1px solid var(--line-soft)', flex: '0 0 auto',
      display: 'flex', alignItems: 'center', gap: 8,
      fontSize: 11, color: 'var(--text-muted)',
      background: 'var(--bg-elevated)',
    }}>
      <Kbd>⌘⇧A</Kbd>
      <span>nudge agent</span>
      <div style={{ flex: 1 }} />
      <Kbd>⌘.</Kbd>
      <span>pause</span>
    </div>
  </div>
);

// ─── Variant B · Bottom Drawer ─────────────────────────────────────
// Collapsed state — just a status strip
const AgentStripBottom = ({ awaiting }) => (
  <div style={{
    height: 36, flex: '0 0 auto', display: 'flex', alignItems: 'center',
    padding: '0 12px', gap: 10,
    background: awaiting ? 'rgba(217, 108, 84, 0.10)' : 'var(--agent-wash)',
    borderTop: `1px solid ${awaiting ? 'var(--op-destruct)' : 'var(--agent-line)'}`,
    fontSize: 12, color: 'var(--text-primary)',
    position: 'relative',
  }}>
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      {Icons.agentDot}
      {awaiting && <span style={{
        position: 'absolute', inset: -3, borderRadius: '50%',
        border: '1.5px solid var(--op-destruct)', opacity: 0.6,
      }} />}
    </span>
    <span style={{ color: awaiting ? 'var(--op-destruct)' : 'var(--agent)',
      fontWeight: 500 }}>
      {awaiting ? 'Agent is waiting on you' : 'Agent active'}
    </span>
    <span style={{ color: 'var(--text-muted)' }}>·</span>
    <span style={{ color: 'var(--text-secondary)' }}>
      {awaiting
        ? <>step 6/6 · approve a <span className="mono">DELETE</span> on{' '}
            <span className="mono">leads</span></>
        : <>looking at <span className="mono">appointments</span> · last action 12s ago</>
      }
    </span>
    <div style={{ flex: 1 }} />
    {awaiting && (
      <button style={{
        height: 22, padding: '0 12px', borderRadius: 5, border: 0,
        background: 'var(--op-destruct)', color: '#1a1714',
        fontSize: 11, fontWeight: 500, fontFamily: 'var(--font-ui)',
      }}>
        Review →
      </button>
    )}
    <button style={editorBtn}>
      Expand <Kbd>⌘\</Kbd>
    </button>
  </div>
);

// Expanded state — full drawer
const AgentDrawerBottom = ({ height = 280 }) => (
  <div style={{
    height, flex: '0 0 auto', display: 'flex', flexDirection: 'column',
    background: 'var(--bg-panel)',
    borderTop: '1px solid var(--agent-line)',
    position: 'relative',
  }}>
    {/* resize handle */}
    <div style={{
      position: 'absolute', top: -3, left: '50%', transform: 'translateX(-50%)',
      width: 32, height: 3, borderRadius: 2,
      background: 'var(--line-strong)',
    }} />
    {/* drawer header */}
    <div style={{
      height: 32, flex: '0 0 auto', display: 'flex', alignItems: 'center',
      padding: '0 12px', gap: 10,
      borderBottom: '1px solid var(--line-soft)',
    }}>
      <span style={{ display: 'inline-flex' }}>{Icons.agentDot}</span>
      <span style={{ fontSize: 12, fontWeight: 500 }}>Agent activity</span>
      <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
        · session 04m 18s
      </span>
      <div style={{ marginLeft: 16, display: 'flex', gap: 2 }}>
        {['Stream', 'Focus', 'Session', 'Policy'].map((t, i) => (
          <button key={i} style={{
            ...editorBtn, height: 22, padding: '0 10px', borderRadius: 4,
            border: 0, background: i === 0 ? 'var(--bg-elevated)' : 'transparent',
            color: i === 0 ? 'var(--text-primary)' : 'var(--text-muted)',
          }}>{t}</button>
        ))}
      </div>
      <div style={{ flex: 1 }} />
      <button style={iconBtn}>{Icons.more}</button>
      <button style={iconBtn}>{Icons.close}</button>
    </div>

    {/* dual-pane content */}
    <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
      {/* focus pane */}
      <div style={{
        width: 340, flex: '0 0 auto',
        borderRight: '1px solid var(--line-soft)',
        display: 'flex', flexDirection: 'column',
        background: 'var(--agent-wash)',
      }}>
        <AgentFocus kind="hero" />
      </div>
      {/* stream pane */}
      <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
        <div style={{
          padding: '8px 14px', display: 'flex', alignItems: 'center', gap: 8,
          fontSize: 10, letterSpacing: '0.08em', textTransform: 'uppercase',
          color: 'var(--text-muted)', fontWeight: 600,
          borderBottom: '1px solid var(--line-faint)',
        }}>
          <span>Stream</span>
          <span style={{ flex: 1 }} />
          <span className="mono" style={{ textTransform: 'none', letterSpacing: 0 }}>
            live · 6 events
          </span>
          <span style={{
            width: 6, height: 6, borderRadius: '50%', background: 'var(--agent)',
            boxShadow: '0 0 6px var(--agent)',
          }} />
        </div>
        <div style={{ flex: 1, overflow: 'hidden' }}>
          {AGENT_LOG.slice().reverse().map((e, i, arr) => (
            <StreamRow key={i} entry={e} last={i === arr.length - 1} />
          ))}
        </div>
      </div>
    </div>
  </div>
);

// ─── Variant C · Inline Annotations ────────────────────────────────
// The agent's presence decorates the editor and grid in place.

const AgentInlineMarker = ({ children, style }) => (
  <div style={{
    position: 'absolute', display: 'flex', alignItems: 'center', gap: 6,
    padding: '3px 8px 3px 6px',
    background: 'var(--bg-elevated)',
    border: '1px solid var(--agent-line)',
    borderRadius: 4, fontSize: 10.5,
    color: 'var(--text-secondary)',
    boxShadow: 'var(--shadow-sm)',
    ...style,
  }}>
    <span style={{ display: 'inline-flex' }}>
      <svg width="10" height="10" viewBox="0 0 14 14">
        <polygon points="7 1.5 12 4.25 12 9.75 7 12.5 2 9.75 2 4.25"
          fill="var(--agent)" />
      </svg>
    </span>
    {children}
  </div>
);

// "Floating timeline rail" — vertical strip down the left edge of the workspace
// that condenses the agent's stream into glyphs only. Expands on hover.
const AgentRail = () => (
  <div style={{
    width: 28, flex: '0 0 auto',
    background: 'var(--bg-panel)',
    borderRight: '1px solid var(--line-soft)',
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '8px 0', gap: 0,
  }}>
    <div style={{ padding: '4px 0' }}>{Icons.agentDot}</div>
    <div style={{ width: 1, flex: 1, background: 'var(--agent-line)', margin: '8px 0' }}>
      {AGENT_LOG.map((e, i) => (
        <div key={i} style={{
          width: 9, height: 9, marginLeft: -4,
          marginTop: i === 0 ? 14 : 24,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <OpGlyph kind={e.kind} size={9} />
        </div>
      ))}
    </div>
    <div style={{ padding: '4px 0', color: 'var(--text-faint)' }}>{Icons.history}</div>
  </div>
);

Object.assign(window, {
  AgentFocus, StreamRow, PermissionCard,
  AgentDockRight, AgentStripBottom, AgentDrawerBottom,
  AgentInlineMarker, AgentRail,
});
