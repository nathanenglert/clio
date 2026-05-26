/* Shared primitives: icons, window chrome, op glyphs, agent markers.
   No state — pure presentational. */

// ── Icon set (16px, stroked, sharp corners) ───────────────────────
const Icon = ({ d, size = 14, fill = "none", stroke = "currentColor", strokeWidth = 1.5, style }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill={fill} stroke={stroke}
       strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" style={style}>
    {d}
  </svg>
);

const Icons = {
  chevron:   <Icon d={<polyline points="6 4 10 8 6 12" />} />,
  chevronD:  <Icon d={<polyline points="4 6 8 10 12 6" />} />,
  search:    <Icon d={<><circle cx="7" cy="7" r="4.5" /><line x1="10.5" y1="10.5" x2="13.5" y2="13.5" /></>} />,
  database:  <Icon d={<><ellipse cx="8" cy="3.5" rx="5" ry="1.5" /><path d="M3 3.5v9c0 .83 2.24 1.5 5 1.5s5-.67 5-1.5v-9" /><path d="M3 8c0 .83 2.24 1.5 5 1.5s5-.67 5-1.5" /></>} />,
  table:     <Icon d={<><rect x="2" y="3" width="12" height="10" rx="1" /><line x1="2" y1="6.5" x2="14" y2="6.5" /><line x1="2" y1="9.5" x2="14" y2="9.5" /><line x1="8" y1="6.5" x2="8" y2="13" /></>} />,
  view:      <Icon d={<><rect x="2" y="3" width="12" height="10" rx="1" strokeDasharray="2 1.5" /><line x1="2" y1="6.5" x2="14" y2="6.5" strokeDasharray="2 1.5"/></>} />,
  column:    <Icon d={<><rect x="3" y="2" width="2.5" height="12" rx=".5" /><rect x="6.75" y="2" width="2.5" height="12" rx=".5" /><rect x="10.5" y="2" width="2.5" height="12" rx=".5" /></>} />,
  function: <Icon d={<><path d="M5 13c0-3.5 1-9 3.5-9" /><line x1="3.5" y1="8.5" x2="9" y2="8.5" /></>} />,
  key:       <Icon d={<><circle cx="5" cy="11" r="2.5"/><line x1="6.75" y1="9.25" x2="13" y2="3"/><line x1="11" y1="5" x2="13" y2="7"/><line x1="9" y1="7" x2="11" y2="9"/></>} />,
  index:     <Icon d={<><line x1="3" y1="3" x2="3" y2="13"/><line x1="3" y1="3" x2="7" y2="3"/><line x1="3" y1="8" x2="6" y2="8"/><line x1="3" y1="13" x2="7" y2="13"/><circle cx="11" cy="8" r="2.5"/></>} />,
  play:      <Icon d={<polygon points="4 3 13 8 4 13" fill="currentColor" stroke="none" />} />,
  stop:      <Icon d={<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none"/>} />,
  plus:      <Icon d={<><line x1="8" y1="3" x2="8" y2="13"/><line x1="3" y1="8" x2="13" y2="8"/></>} />,
  close:     <Icon d={<><line x1="4" y1="4" x2="12" y2="12"/><line x1="12" y1="4" x2="4" y2="12"/></>} />,
  more:      <Icon d={<><circle cx="3" cy="8" r=".75" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r=".75" fill="currentColor" stroke="none"/><circle cx="13" cy="8" r=".75" fill="currentColor" stroke="none"/></>} />,
  lock:      <Icon d={<><rect x="3.5" y="7" width="9" height="6.5" rx="1"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/></>} />,
  shield:    <Icon d={<path d="M8 2L3 4v4c0 3 2 5 5 6 3-1 5-3 5-6V4z"/>} />,
  bolt:      <Icon d={<polygon points="9 2 4 9 7.5 9 6 14 12 7 8.5 7 10 2" fill="currentColor" stroke="none" strokeLinejoin="round"/>} />,
  eye:       <Icon d={<><path d="M1.5 8C3 5 5.5 3.5 8 3.5S13 5 14.5 8C13 11 10.5 12.5 8 12.5S3 11 1.5 8z"/><circle cx="8" cy="8" r="1.75"/></>} />,
  history:   <Icon d={<><path d="M3 8a5 5 0 1 0 1.4-3.5"/><polyline points="3 2 3 5 6 5"/><polyline points="8 5 8 8 10.5 9.5"/></>} />,
  pin:       <Icon d={<path d="M8 1.5l2 3 3 .5-2 2 .5 3-3-1.5L5.5 10l.5-3-2-2 3-.5z" fill="currentColor" stroke="none"/>} />,
  export:    <Icon d={<><path d="M8 2v8"/><polyline points="5 5 8 2 11 5"/><path d="M3 11v2a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2"/></>} />,
  filter:    <Icon d={<polygon points="2 3 14 3 10 8 10 13 6 13 6 8" />} />,
  refresh:   <Icon d={<><polyline points="14 3 14 7 10 7"/><path d="M13.5 7A5 5 0 1 0 12 12.5"/></>} />,
  warn:      <Icon d={<><polygon points="8 2 14.5 13.5 1.5 13.5" /><line x1="8" y1="6" x2="8" y2="9.5"/><circle cx="8" cy="11.5" r=".75" fill="currentColor" stroke="none"/></>} />,
  check:     <Icon d={<polyline points="3 8 6.5 11.5 13 5"/>} />,
  json:      <Icon d={<><path d="M5.5 3.5h-2v9h2"/><path d="M10.5 3.5h2v9h-2"/></>} />,
  cmd:       <Icon d={<><rect x="2.5" y="6" width="4" height="4" rx=".5"/><rect x="9.5" y="6" width="4" height="4" rx=".5"/><rect x="6" y="2.5" width="4" height="4" rx=".5"/><rect x="6" y="9.5" width="4" height="4" rx=".5"/></>} />,
  agentDot:  ( /* the agent's signature glyph — a filled copper hex */
    <svg width="14" height="14" viewBox="0 0 14 14">
      <polygon points="7 1.5 12 4.25 12 9.75 7 12.5 2 9.75 2 4.25"
               fill="var(--agent)" stroke="none"/>
    </svg>
  ),
  userDot:   ( /* a small ring — calm, no fill */
    <svg width="14" height="14" viewBox="0 0 14 14">
      <circle cx="7" cy="7" r="4" fill="none" stroke="var(--text-muted)" strokeWidth="1.5"/>
    </svg>
  ),
};

// ── Op-type glyph: shape + color (color-blind safe) ───────────────
// read=circle, write=square, ddl=diamond, destruct=triangle
const OpGlyph = ({ kind = 'read', size = 10, style }) => {
  const map = {
    read:     { color: 'var(--op-read)',     shape: 'circle'   },
    write:    { color: 'var(--op-write)',    shape: 'square'   },
    ddl:      { color: 'var(--op-ddl)',      shape: 'diamond'  },
    destruct: { color: 'var(--op-destruct)', shape: 'triangle' },
  };
  const { color, shape } = map[kind] || map.read;
  const s = size;
  return (
    <svg width={s} height={s} viewBox="0 0 10 10" style={{ flex: '0 0 auto', ...style }}>
      {shape === 'circle'   && <circle cx="5" cy="5" r="3.5" fill={color} />}
      {shape === 'square'   && <rect x="1.5" y="1.5" width="7" height="7" rx="1" fill={color} />}
      {shape === 'diamond'  && <polygon points="5 1 9 5 5 9 1 5" fill={color} />}
      {shape === 'triangle' && <polygon points="5 1.25 9 8.5 1 8.5" fill={color} />}
    </svg>
  );
};

const OpLabel = ({ kind, children, mono = true }) => {
  const label = { read: 'READ', write: 'WRITE', ddl: 'SCHEMA', destruct: 'DESTRUCT' }[kind];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <OpGlyph kind={kind} />
      <span className={mono ? 'mono' : ''} style={{
        fontSize: 10, letterSpacing: '0.06em', fontWeight: 600,
        color: `var(--op-${kind === 'destruct' ? 'destruct' : kind})`
      }}>{children || label}</span>
    </span>
  );
};

// ── Window chrome — macOS traffic lights ──────────────────────────
const TrafficLights = ({ inactive }) => (
  <div style={{ display: 'flex', gap: 8, padding: '0 4px', alignItems: 'center' }}>
    {[
      { c: '#ed6a5e', b: '#ce5046' },
      { c: '#f5bf4f', b: '#d59f2c' },
      { c: '#62c554', b: '#3fa129' },
    ].map((d, i) => (
      <div key={i} style={{
        width: 12, height: 12, borderRadius: '50%',
        background: inactive ? '#2c2925' : d.c,
        boxShadow: inactive ? 'none' : `inset 0 0 0 0.5px ${d.b}`,
      }} />
    ))}
  </div>
);

const WindowChrome = ({ title, subtitle, right, inactive, agentActive }) => (
  <div style={{
    height: 36, display: 'flex', alignItems: 'center', flex: '0 0 auto',
    padding: '0 12px', background: 'var(--bg-panel)',
    borderBottom: '1px solid var(--line-soft)',
    position: 'relative',
  }}>
    <TrafficLights inactive={inactive} />
    <div style={{
      position: 'absolute', left: '50%', top: '50%',
      transform: 'translate(-50%, -50%)',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      pointerEvents: 'none',
    }}>
      <div style={{
        fontSize: 12, fontWeight: 500, color: 'var(--text-secondary)',
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        {agentActive && (
          <span style={{
            width: 6, height: 6, borderRadius: '50%',
            background: 'var(--agent)',
            boxShadow: '0 0 8px 1px rgba(212, 145, 90, 0.55)',
          }} />
        )}
        {title}
      </div>
      {subtitle && (
        <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>{subtitle}</div>
      )}
    </div>
    <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
      {right}
    </div>
  </div>
);

// ── Agent presence: badge, line marker, attention pulse ───────────
const AgentBadge = ({ size = 'sm', label = 'Claude Code', pulse }) => (
  <div style={{
    display: 'inline-flex', alignItems: 'center', gap: 6,
    height: size === 'sm' ? 20 : 24,
    padding: size === 'sm' ? '0 8px 0 6px' : '0 10px 0 7px',
    background: 'var(--agent-wash)',
    border: '1px solid var(--agent-line)',
    borderRadius: 999,
    color: 'var(--agent)',
    fontSize: size === 'sm' ? 11 : 12,
    fontWeight: 500,
    letterSpacing: '-0.005em',
  }}>
    <span style={{ position: 'relative', display: 'inline-flex', width: 8, height: 8 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%', background: 'var(--agent)',
        boxShadow: pulse ? '0 0 0 0 var(--agent-line)' : 'none',
      }} />
      {pulse && <span style={{
        position: 'absolute', inset: -2, borderRadius: '50%',
        border: '1.5px solid var(--agent)', opacity: 0.4,
      }} />}
    </span>
    {label}
  </div>
);

// Left-edge marker that runs the height of an agent zone
const AgentEdge = ({ style }) => (
  <div style={{
    position: 'absolute', left: 0, top: 0, bottom: 0, width: 2,
    background: 'linear-gradient(180deg, transparent, var(--agent) 12%, var(--agent) 88%, transparent)',
    ...style
  }} />
);

// ── Status bar pill ───────────────────────────────────────────────
const StatusPill = ({ tone = 'idle', children, mono }) => {
  const c = `var(--status-${tone})`;
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      fontSize: 11, color: 'var(--text-secondary)',
      fontFamily: mono ? 'var(--font-mono)' : 'inherit',
    }}>
      <span style={{ width: 6, height: 6, borderRadius: '50%', background: c,
        boxShadow: tone === 'pending' ? `0 0 6px ${c}` : 'none' }} />
      {children}
    </span>
  );
};

// ── Kbd ───────────────────────────────────────────────────────────
const Kbd = ({ children, dim }) => (
  <kbd className="mono" style={{
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 18, height: 18, padding: '0 5px',
    fontSize: 10, fontWeight: 500,
    color: dim ? 'var(--text-muted)' : 'var(--text-secondary)',
    background: dim ? 'transparent' : 'var(--bg-elevated)',
    border: '1px solid var(--line-default)',
    borderRadius: 4,
    letterSpacing: 0,
  }}>{children}</kbd>
);

// ── Inline callout pin — used by Callout component to anchor a note
const Pin = ({ n, color = 'var(--agent)' }) => (
  <div style={{
    width: 18, height: 18, borderRadius: '50%',
    background: color, color: 'var(--bg-app)',
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
    boxShadow: '0 2px 8px rgba(0,0,0,0.4)',
  }}>{n}</div>
);

Object.assign(window, {
  Icon, Icons, OpGlyph, OpLabel,
  TrafficLights, WindowChrome,
  AgentBadge, AgentEdge, StatusPill, Kbd, Pin,
});
