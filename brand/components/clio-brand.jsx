/* Clio — brand exploration canvas.
   Lives alongside the product design canvas. Same tokens, same vocabulary.
   The thesis: Clio doesn't make history; she keeps it. The motif: the
   lunate C (ϲ) — an open half-circle — paired with a single copper dot.
*/

// ─── helpers (named to avoid global collisions) ─────────────────────
const cbShell = (pad = 56, bg = 'var(--bg-app)') => ({
  width: '100%', height: '100%', background: bg, padding: pad,
  fontFamily: 'var(--font-ui)', color: 'var(--text-primary)',
  overflow: 'hidden', display: 'flex', flexDirection: 'column',
  position: 'relative', boxSizing: 'border-box',
});

const Eyebrow = ({ children, color = 'var(--text-muted)', style }) => (
  <div style={{
    fontSize: 10, letterSpacing: '0.14em', textTransform: 'uppercase',
    color, fontWeight: 600, ...style,
  }}>{children}</div>
);

const Serif = ({ size = 28, weight = 500, lh = 1.2, color = 'var(--text-primary)', children, style }) => (
  <div className="serif" style={{
    fontSize: size, fontWeight: weight, lineHeight: lh, color,
    letterSpacing: '-0.018em', ...style,
  }}>{children}</div>
);

const HRule = ({ tone = 'soft', style }) => (
  <div style={{ height: 1, background: `var(--line-${tone})`, ...style }} />
);

// ─── The Lunate — Clio's primary mark ──────────────────────────────
// Half-circle, opening right. A clay-tablet curve, an open parenthesis, a
// watching crescent. The single dot is the "moment" being witnessed.
//
// THE KEY IDEA: viewBox is fixed at 80×80, and the construction values
// (stroke 20, dot radius 9) are constants — not derived from `size`. That
// means every visual ratio is preserved at every render size:
//
//   stroke / mark width  = 25%      (20 / 80)
//   dot diameter / width = 22.5%    (18 / 80)
//   dot diameter / stroke = 0.9     (the dot reads as one stroke-weight)
//
// Pass just `size` — never override stroke/dotSize unless you intentionally
// want a different weight (e.g. an outline-only marketing variant).
const Lunate = ({
  size = 80,
  stroke = 20,             // viewBox units — the construction value
  color = 'var(--text-primary)',
  dot = true,
  dotColor = 'var(--agent)',
  dotSize = 9,             // viewBox units (radius) — the construction value
  opening = 'right',
}) => {
  const r = 28;
  const cx = 40, cy = 40;
  // Half-circle opening to the right: start at top-right, sweep counter-
  // clockwise around to bottom-right.
  const x1 = opening === 'right' ? cx + r * Math.cos(-Math.PI / 3) : cx - r * Math.cos(-Math.PI / 3);
  const y1 = cy + r * Math.sin(-Math.PI / 3);
  const x2 = opening === 'right' ? cx + r * Math.cos(Math.PI / 3) : cx - r * Math.cos(Math.PI / 3);
  const y2 = cy + r * Math.sin(Math.PI / 3);
  const sweep = opening === 'right' ? 0 : 1;
  const dotX = opening === 'right' ? cx + r - 1 : cx - r + 1;
  return (
    <svg width={size} height={size} viewBox="0 0 80 80" style={{ display: 'block' }}>
      <path d={`M ${x1} ${y1} A ${r} ${r} 0 1 ${sweep} ${x2} ${y2}`}
        fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
      {dot && <circle cx={dotX} cy={cy} r={dotSize} fill={dotColor} />}
    </svg>
  );
};

// ─── Section 1 · WHY CLIO ─────────────────────────────────────────
const ThesisCard = () => (
  <div style={cbShell(64, 'var(--bg-app)')}>
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 20, marginBottom: 28 }}>
      <Lunate size={56} />
      <div>
        <Eyebrow>Brand thesis</Eyebrow>
        <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 4 }}>
          clio · v0.1
        </div>
      </div>
    </div>

    <Serif size={44} lh={1.12} style={{ maxWidth: 720, marginBottom: 24 }}>
      Clio doesn't make history.<br/>
      <span style={{ color: 'var(--text-secondary)' }}>She keeps it.</span>
    </Serif>

    <div style={{ fontSize: 15, color: 'var(--text-secondary)', maxWidth: 640,
      lineHeight: 1.6, marginBottom: 36 }}>
      In the myth she's the muse with the scroll — the witness, the record-keeper,
      the one you turn to when you want to know what actually happened. That's
      the whole job of this app. The agent writes the queries. You review and
      gate the writes. Clio holds the record so neither of you have to guess.
    </div>

    <div style={{ flex: 1 }} />

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1,
      background: 'var(--line-soft)', border: '1px solid var(--line-soft)' }}>
      {[
        { word: 'Witness',   sub: 'See every query the agent runs — read, write, schema, destruct.' },
        { word: 'Keep',      sub: 'Every action becomes an entry in the record. Nothing is lost.' },
        { word: 'Look back', sub: 'Scrub the record. Replay any moment. Re-read what was said.' },
      ].map((p) => (
        <div key={p.word} style={{ background: 'var(--bg-app)', padding: '20px 22px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <Lunate size={16} color="var(--text-secondary)" />
            <Serif size={18} weight={500}>{p.word}</Serif>
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
            {p.sub}
          </div>
        </div>
      ))}
    </div>
  </div>
);

const EtymologyCard = () => (
  <div style={cbShell(48, 'var(--bg-panel)')}>
    <Eyebrow style={{ marginBottom: 20 }}>Where the name comes from</Eyebrow>

    <div className="serif" style={{ fontSize: 64, lineHeight: 1, fontWeight: 400,
      letterSpacing: '-0.025em', marginBottom: 12 }}>
      Κλειώ
    </div>
    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 28,
      maxWidth: 380, lineHeight: 1.55 }}>
      <em className="serif">Kleiō</em> — "<span className="serif">the proclaimer</span>" /
      "<span className="serif">she who recounts</span>". One of the nine Muses.
      Her domain is history. Her attribute is the scroll.
    </div>

    <HRule style={{ margin: '4px 0 24px' }} />

    <Eyebrow style={{ marginBottom: 14 }}>Why it fits the product</Eyebrow>

    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {[
        { l: 'A scroll',          r: 'is the activity stream' },
        { l: 'A muse of recall',  r: 'is the session scrubber' },
        { l: 'A witness',         r: 'is the permission gate' },
        { l: 'A historian',       r: 'is the audit log' },
        { l: 'Recounting clearly', r: 'is the agent\u2019s natural language' },
      ].map((row, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
          <div className="serif" style={{ fontSize: 14, color: 'var(--text-primary)',
            minWidth: 168, fontStyle: 'italic' }}>{row.l}</div>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)' }}>→</div>
          <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-secondary)' }}>
            {row.r}
          </div>
        </div>
      ))}
    </div>

    <div style={{ flex: 1 }} />

    <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 24,
      paddingTop: 16, borderTop: '1px solid var(--line-soft)' }}>
      <div style={{ width: 6, height: 6, borderRadius: '50%', background: 'var(--agent)' }} />
      <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-muted)' }}>
        the agent acts · clio keeps · you decide
      </div>
    </div>
  </div>
);

// ─── Section 2 · THE WORDMARK ────────────────────────────────────
// Decision: Geist Mono lowercase "clio" followed by a true round copper dot.
// The wordmark wears the engineering register the rest of the app already
// speaks. The mark wears the archival register. They share the copper dot
// and nothing else — that's the seam.

const ClioWord = ({ size = 56, weight = 500, color = 'var(--text-primary)', dot = true, dotColor = 'var(--agent)' }) => (
  <span className="mono" style={{
    fontSize: size, fontWeight: weight, lineHeight: 1,
    letterSpacing: '-0.02em', color, display: 'inline-flex',
    alignItems: 'baseline',
  }}>
    clio{dot && (
      <span style={{
        display: 'inline-block',
        width: '0.18em', height: '0.18em',
        borderRadius: '50%',
        background: dotColor,
        marginLeft: '0.08em',
        verticalAlign: 'baseline',
      }} />
    )}
  </span>
);

const SpecRow = ({ label, value, mono = true }) => (
  <div style={{ display: 'flex', alignItems: 'baseline', gap: 12,
    padding: '8px 0', borderBottom: '1px solid var(--line-faint)' }}>
    <div style={{ flex: '0 0 120px', fontSize: 10.5,
      color: 'var(--text-muted)', textTransform: 'uppercase',
      letterSpacing: '0.1em', fontWeight: 600 }}>
      {label}
    </div>
    <div className={mono ? 'mono' : ''} style={{ fontSize: 11.5,
      color: 'var(--text-primary)' }}>
      {value}
    </div>
  </div>
);

const WordmarkHero = () => (
  <div style={cbShell(48, 'var(--bg-app)')}>
    <Eyebrow style={{ marginBottom: 36 }}>The wordmark</Eyebrow>

    {/* Hero */}
    <div style={{ marginBottom: 48 }}>
      <ClioWord size={96} />
    </div>

    {/* Scale */}
    <Eyebrow style={{ marginBottom: 16 }}>Scale</Eyebrow>
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 32,
      marginBottom: 36, paddingBottom: 16,
      borderBottom: '1px solid var(--line-soft)' }}>
      {[48, 28, 18, 13].map((s) => (
        <div key={s} style={{ display: 'flex', flexDirection: 'column',
          alignItems: 'flex-start', gap: 8 }}>
          <ClioWord size={s} />
          <div className="mono" style={{ fontSize: 9.5,
            color: 'var(--text-faint)' }}>
            {s}px
          </div>
        </div>
      ))}
    </div>

    {/* Spec sheet */}
    <Eyebrow style={{ marginBottom: 8 }}>Spec</Eyebrow>
    <div>
      <SpecRow label="Family"    value="Geist Mono" />
      <SpecRow label="Weight"    value="500" />
      <SpecRow label="Tracking"  value="−0.02em" />
      <SpecRow label="Dot ø"     value="0.18em" />
      <SpecRow label="Dot color" value="var(--agent) · #d4915a" />
      <SpecRow label="Dot gap"   value="0.08em from final letter" />
    </div>
  </div>
);

const WordmarkRulesCard = () => (
  <div style={cbShell(48, 'var(--bg-panel)')}>
    <Eyebrow style={{ marginBottom: 8 }}>How to wear it</Eyebrow>
    <div style={{ fontSize: 12, color: 'var(--text-secondary)',
      lineHeight: 1.55, marginBottom: 28, maxWidth: 480 }}>
      The dot is a typographic period — it appears when the wordmark stands
      alone. Drop it when "clio" is followed by another mono token, where
      a separator-dot already lives.
    </div>

    {/* With dot — standalone */}
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <Glyph kind="entry" size={12} color="var(--op-read)" />
        <div className="mono" style={{ fontSize: 10.5,
          color: 'var(--text-muted)', textTransform: 'uppercase',
          letterSpacing: '0.08em', fontWeight: 600 }}>
          With dot — standalone
        </div>
      </div>
      <div style={{ padding: '20px 24px', background: 'var(--bg-app)',
        border: '1px solid var(--line-soft)', borderRadius: 6 }}>
        <ClioWord size={44} />
      </div>
      <div className="mono" style={{ fontSize: 10,
        color: 'var(--text-faint)', marginTop: 8 }}>
        app icon · marketing · cover · about
      </div>
    </div>

    {/* Without dot — inline */}
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 8 }}>
        <Glyph kind="entry" size={12} color="var(--op-read)" />
        <div className="mono" style={{ fontSize: 10.5,
          color: 'var(--text-muted)', textTransform: 'uppercase',
          letterSpacing: '0.08em', fontWeight: 600 }}>
          Without dot — inline with separator
        </div>
      </div>
      <div style={{ padding: '20px 24px', background: 'var(--bg-app)',
        border: '1px solid var(--line-soft)', borderRadius: 6 }}>
        <span className="mono" style={{ fontSize: 18,
          color: 'var(--text-secondary)', letterSpacing: '0.005em' }}>
          <ClioWord size={18} dot={false} />
          <span style={{ margin: '0 8px', color: 'var(--text-muted)' }}>·</span>
          lassomd-staging
          <span style={{ margin: '0 8px', color: 'var(--text-muted)' }}>·</span>
          public
        </span>
      </div>
      <div className="mono" style={{ fontSize: 10,
        color: 'var(--text-faint)', marginTop: 8 }}>
        title bar · status bar · breadcrumbs · CLI prompt
      </div>
    </div>
  </div>
);

// ─── Section 3 · THE MARK ─────────────────────────────────────────
const MarkConstructionCard = () => (
  <div style={cbShell(48, 'var(--bg-app)')}>
    <Eyebrow style={{ marginBottom: 24 }}>The mark</Eyebrow>

    {/* Big mark with construction overlay */}
    <div style={{ position: 'relative', alignSelf: 'center', marginBottom: 28 }}>
      {/* Construction lines */}
      <svg width={240} height={240} viewBox="0 0 80 80"
        style={{ position: 'absolute', inset: 0 }}>
        <circle cx="40" cy="40" r="28" fill="none"
          stroke="var(--line-faint)" strokeWidth="0.3" strokeDasharray="0.6 0.6" />
        <line x1="0" y1="40" x2="80" y2="40"
          stroke="var(--line-faint)" strokeWidth="0.3" strokeDasharray="0.6 0.6" />
        <line x1="40" y1="0" x2="40" y2="80"
          stroke="var(--line-faint)" strokeWidth="0.3" strokeDasharray="0.6 0.6" />
      </svg>
      <Lunate size={240} />
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16,
      marginTop: 'auto' }}>
      <div>
        <Eyebrow style={{ marginBottom: 8 }}>Anatomy</Eyebrow>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          A half-circle opening right — the lunate <span className="serif">ϲ</span>,
          how C was drawn in ancient inscriptions. The single copper dot is
          the moment the record is open to.
        </div>
      </div>
      <div>
        <Eyebrow style={{ marginBottom: 8 }}>What it reads as</Eyebrow>
        <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
          The C of Clio · an open parenthesis · a clay-tablet curve · a
          crescent watching · a record left unclosed.
        </div>
      </div>
    </div>
  </div>
);

// Mark sizes — favicon to large. Every size uses identical Lunate props
// EXCEPT size — the viewBox-constant stroke and dot are what hold the
// proportions steady. This card is also the proof of that.
const MarkSizesCard = () => (
  <div style={cbShell(40, 'var(--bg-panel)')}>
    <Eyebrow style={{ marginBottom: 8 }}>Sizes & sit</Eyebrow>
    <div style={{ fontSize: 11.5, color: 'var(--text-secondary)',
      maxWidth: 460, lineHeight: 1.55, marginBottom: 28 }}>
      One construction, every size. The viewBox is fixed at 80, the stroke
      is 20 of those units, the dot radius is 9. Render at any size and the
      proportions hold — this is the same trick a typeface uses.
    </div>

    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 36,
      justifyContent: 'center', flex: 1, paddingBottom: 8 }}>
      {[14, 24, 40, 72, 128].map((px) => (
        <div key={px} style={{ display: 'flex', flexDirection: 'column',
          alignItems: 'center', gap: 14 }}>
          <Lunate size={px} />
          <div style={{ textAlign: 'center' }}>
            <div className="mono" style={{ fontSize: 11,
              color: 'var(--text-primary)' }}>{px}px</div>
            <div className="mono" style={{ fontSize: 9.5,
              color: 'var(--text-faint)', marginTop: 2 }}>
              stroke {Math.round(px * 0.25 * 10) / 10}px
            </div>
          </div>
        </div>
      ))}
    </div>

    <HRule style={{ margin: '20px 0 16px' }} />

    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
      gap: 16, marginBottom: 16 }}>
      {[
        { ratio: '25%',   label: 'stroke / mark',     sub: '20 of 80 viewBox units' },
        { ratio: '22.5%', label: 'dot ø / mark',       sub: '18 of 80 viewBox units' },
        { ratio: '0.9',   label: 'dot ø / stroke',     sub: 'reads as one stroke-weight' },
      ].map((r) => (
        <div key={r.label}>
          <div className="serif" style={{ fontSize: 22, fontWeight: 500,
            color: 'var(--text-primary)', lineHeight: 1, marginBottom: 6 }}>
            {r.ratio}
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
            {r.label}
          </div>
          <div className="mono" style={{ fontSize: 9.5,
            color: 'var(--text-faint)', marginTop: 2 }}>
            {r.sub}
          </div>
        </div>
      ))}
    </div>

    <div style={{ fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.6,
      fontStyle: 'italic' }} className="serif">
      Below 12px the dot starts to fuse with the curve and the mark reads as
      a single bead — that's the favicon. Don't hand-tune the values at any
      size above that; the construction is the answer.
    </div>
  </div>
);

// Lockup variations
const LockupsCard = () => (
  <div style={cbShell(48, 'var(--bg-app)')}>
    <Eyebrow style={{ marginBottom: 36 }}>Lockups</Eyebrow>

    <div style={{ display: 'grid', gridTemplateRows: 'repeat(3, 1fr)', gap: 28,
      flex: 1, minHeight: 0 }}>

      {/* Horizontal: mark + wordmark */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
        <div style={{ minWidth: 120, fontSize: 10.5, color: 'var(--text-muted)' }}>
          <Eyebrow>Horizontal</Eyebrow>
          <div className="mono" style={{ fontSize: 10, marginTop: 4 }}>app icon · header</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <Lunate size={36} />
          <ClioWord size={32} />
        </div>
      </div>

      <HRule />

      {/* With tagline */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
        <div style={{ minWidth: 120, fontSize: 10.5, color: 'var(--text-muted)' }}>
          <Eyebrow>With tagline</Eyebrow>
          <div className="mono" style={{ fontSize: 10, marginTop: 4 }}>marketing · about</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <Lunate size={44} />
          <div>
            <ClioWord size={32} />
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)',
              marginTop: 6, letterSpacing: '0.04em' }}>
              the record · keeper for ai-assisted databases
            </div>
          </div>
        </div>
      </div>

      <HRule />

      {/* Stamp: tiny mark inline with mono name — chrome */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 32 }}>
        <div style={{ minWidth: 120, fontSize: 10.5, color: 'var(--text-muted)' }}>
          <Eyebrow>Stamp</Eyebrow>
          <div className="mono" style={{ fontSize: 10, marginTop: 4 }}>chrome · status</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Lunate size={14} />
          <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)',
            letterSpacing: '0.02em' }}>
            clio · lassomd-staging · public
          </div>
        </div>
      </div>
    </div>
  </div>
);

// ─── Section 4 · GLYPH SYSTEM ─────────────────────────────────────
// The motif extends: half-circle = "open record"; line-with-dot = "entry";
// stacked lines = "chronicle"; arc closing back = "look back"
const Glyph = ({ kind, size = 24, color = 'var(--text-primary)' }) => {
  const stroke = Math.max(1.6, size / 14);
  const dot = Math.max(1.4, size / 18);
  if (kind === 'open') {
    return <Lunate size={size} color={color} />;
  }
  if (kind === 'entry') {
    // a single line with a dot — one entry in the record
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <line x1="3" y1="12" x2="21" y2="12" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
        <circle cx="6" cy="12" r={dot * 1.2} fill="var(--agent)" />
      </svg>
    );
  }
  if (kind === 'chronicle') {
    // stacked lines with one accented — the record
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <line x1="3" y1="7"  x2="21" y2="7"  stroke={color} strokeWidth={stroke} strokeLinecap="round" opacity="0.55" />
        <line x1="3" y1="12" x2="21" y2="12" stroke={color} strokeWidth={stroke} strokeLinecap="round" />
        <line x1="3" y1="17" x2="14" y2="17" stroke={color} strokeWidth={stroke} strokeLinecap="round" opacity="0.55" />
        <circle cx="6" cy="12" r={dot * 1.2} fill="var(--agent)" />
      </svg>
    );
  }
  if (kind === 'lookback') {
    // a backwards arc with a dot — go back to this moment
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none"
        stroke={color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
        <path d="M 20 12 A 8 8 0 1 0 12 20" />
        <polyline points="12 16 12 20 16 20" />
        <circle cx="20" cy="12" r={dot * 1.2} fill="var(--agent)" stroke="none" />
      </svg>
    );
  }
  if (kind === 'witness') {
    // an eye-like crescent — a watching half-circle
    return (
      <svg width={size} height={size} viewBox="0 0 24 24">
        <path d="M 16 5 A 9 9 0 1 0 16 19" fill="none" stroke={color}
          strokeWidth={stroke} strokeLinecap="round" />
        <circle cx="16" cy="12" r={dot * 1.4} fill="var(--agent)" />
      </svg>
    );
  }
  if (kind === 'kept') {
    // a closed mark — a small square with a dot, the kept record
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <rect x="4" y="4" width="16" height="16" rx="1.5"
          stroke={color} strokeWidth={stroke} />
        <circle cx="8" cy="8" r={dot * 1.2} fill="var(--agent)" />
        <line x1="11" y1="8" x2="17" y2="8"  stroke={color} strokeWidth={stroke * 0.7} strokeLinecap="round" opacity="0.5" />
        <line x1="7"  y1="13" x2="17" y2="13" stroke={color} strokeWidth={stroke * 0.7} strokeLinecap="round" opacity="0.5" />
        <line x1="7"  y1="17" x2="14" y2="17" stroke={color} strokeWidth={stroke * 0.7} strokeLinecap="round" opacity="0.5" />
      </svg>
    );
  }
  return null;
};

const GlyphSystemCard = () => {
  const glyphs = [
    { k: 'open',       n: 'Open',       d: 'The brand mark. The record is open.' },
    { k: 'entry',      n: 'Entry',      d: 'One event in the record. One line.' },
    { k: 'chronicle',  n: 'Chronicle',  d: 'The session. Many entries kept in order.' },
    { k: 'witness',    n: 'Witness',    d: 'Something the agent did, observed.' },
    { k: 'lookback',   n: 'Look back',  d: 'Scrub to an earlier moment. (v0.2)' },
    { k: 'kept',       n: 'Kept',       d: 'Persisted. Saved into the record.' },
  ];
  return (
    <div style={cbShell(48, 'var(--bg-app)')}>
      <Eyebrow style={{ marginBottom: 8 }}>Glyph system</Eyebrow>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 560,
        lineHeight: 1.55, marginBottom: 28 }}>
        One motif, six expressions. A half-circle (the record opens), a line
        (an entry), stacked lines (a chronicle), a backward arc (look back).
        The agent's copper dot threads through them all — the moment a thing
        was witnessed.
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 1, background: 'var(--line-soft)',
        border: '1px solid var(--line-soft)', flex: 1, minHeight: 0 }}>
        {glyphs.map((g) => (
          <div key={g.k} style={{ background: 'var(--bg-panel)', padding: '22px 20px',
            display: 'flex', flexDirection: 'column', gap: 12 }}>
            <Glyph kind={g.k} size={36} color="var(--text-primary)" />
            <div>
              <div style={{ fontSize: 12.5, fontWeight: 500, marginBottom: 2 }}>{g.n}</div>
              <div style={{ fontSize: 10.5, color: 'var(--text-muted)', lineHeight: 1.5 }}>
                {g.d}
              </div>
            </div>
          </div>
        ))}
      </div>

      <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)',
        marginTop: 16 }}>
        These extend the existing OpGlyph system. They never compete with it —
        op glyphs ({"\u25CF \u25A0 \u25C6 \u25B2"}) keep their job. Brand glyphs
        appear in chrome and empty states.
      </div>
    </div>
  );
};

// ─── Section 5 · IN THE PRODUCT ───────────────────────────────────

// Window chrome with the new title treatment
const ChromeApplied = () => (
  <div style={cbShell(0, 'var(--bg-canvas)')}>
    {/* Mock window */}
    <div style={{ margin: 24, background: 'var(--bg-app)',
      borderRadius: 8, overflow: 'hidden',
      boxShadow: '0 24px 64px rgba(0,0,0,0.45), 0 1px 0 rgba(255,240,220,0.04) inset',
      border: '1px solid var(--line-soft)' }}>

      {/* Top chrome bar */}
      <div style={{ height: 36, display: 'flex', alignItems: 'center',
        padding: '0 12px', background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--line-soft)', position: 'relative' }}>
        <TrafficLights />
        <div style={{ position: 'absolute', left: '50%', top: '50%',
          transform: 'translate(-50%, -50%)', display: 'flex',
          alignItems: 'center', gap: 10, pointerEvents: 'none' }}>
          <Lunate size={13} color="var(--text-secondary)" />
          <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)',
            letterSpacing: '0.005em' }}>
            clio  ·  lassomd-staging  ·  public
          </div>
        </div>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 16, height: 16, opacity: 0.5 }}>{Icons.search}</div>
          <div style={{ width: 16, height: 16, opacity: 0.5 }}>{Icons.shield}</div>
          <AgentBadge label="Claude Code" />
        </div>
      </div>

      {/* Body sliver */}
      <div style={{ height: 180, background: 'var(--bg-app)', padding: 20,
        display: 'flex', alignItems: 'flex-start', gap: 24 }}>
        <div style={{ width: 200, paddingTop: 4 }}>
          <Eyebrow>Schema</Eyebrow>
          <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)',
            marginTop: 12, lineHeight: 1.9 }}>
            ▾ public<br/>
            <span style={{ paddingLeft: 12 }}>patients</span><br/>
            <span style={{ paddingLeft: 12 }}>appointments</span><br/>
            <span style={{ paddingLeft: 12 }}>leads</span>
          </div>
        </div>
        <div style={{ flex: 1, paddingTop: 4 }}>
          <div className="mono" style={{ fontSize: 12, color: 'var(--text-primary)',
            lineHeight: 1.7 }}>
            <span className="sql-kw">select</span> id, mrn, last_name<br/>
            <span className="sql-kw">from</span> <span className="sql-id">patients</span> <span className="sql-kw">where</span> <span className="sql-id">deleted_at</span> <span className="sql-kw">is null</span>;
          </div>
        </div>
      </div>

      {/* Status bar */}
      <div style={{ height: 24, padding: '0 12px',
        borderTop: '1px solid var(--line-soft)', background: 'var(--bg-panel)',
        display: 'flex', alignItems: 'center', gap: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <Lunate size={9} color="var(--text-muted)" />
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            record · 06:42 · 14 entries
          </span>
        </div>
        <div style={{ width: 1, height: 12, background: 'var(--line-soft)' }} />
        <StatusPill tone="ok" mono>lassomd-staging · postgres 16.4</StatusPill>
        <div style={{ marginLeft: 'auto' }}>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
            policy: read-any · write-public
          </span>
        </div>
      </div>
    </div>

    <div style={{ padding: '4px 24px 16px' }}>
      <Eyebrow style={{ marginBottom: 8 }}>What changed</Eyebrow>
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', lineHeight: 1.6 }}>
        Title bar leads with the lunate stamp. The status bar gains a
        <span className="mono"> record · 06:42 · 14 entries</span> chip on the
        left — Clio's quiet presence on the chrome. Nothing else moves.
      </div>
    </div>
  </div>
);

// Empty / first-run
const EmptyApplied = () => (
  <div style={cbShell(0, 'var(--bg-app)')}>
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', padding: 48,
      textAlign: 'center' }}>

      <Lunate size={88} />

      <div style={{ height: 28 }} />

      <Serif size={32} lh={1.2} style={{ marginBottom: 14, maxWidth: 460 }}>
        A workbench you watch from.
      </Serif>

      <div style={{ fontSize: 13.5, color: 'var(--text-secondary)',
        lineHeight: 1.65, maxWidth: 440, marginBottom: 32 }}>
        Connect a Postgres database, then point your coding agent at it.
        Clio keeps the record of every query it runs and lets you gate any
        write before it touches the database.
      </div>

      <div style={{ display: 'flex', gap: 10 }}>
        <button style={{
          height: 36, padding: '0 16px', background: 'var(--bg-elevated)',
          border: '1px solid var(--line-default)', borderRadius: 6,
          color: 'var(--text-primary)', fontSize: 12.5, fontWeight: 500,
          display: 'inline-flex', alignItems: 'center', gap: 10,
          fontFamily: 'inherit', cursor: 'pointer' }}>
          {Icons.plus} Connect a database <Kbd>⌘N</Kbd>
        </button>
        <button style={{
          height: 36, padding: '0 16px', background: 'transparent',
          border: '1px solid var(--line-soft)', borderRadius: 6,
          color: 'var(--text-secondary)', fontSize: 12.5,
          display: 'inline-flex', alignItems: 'center', gap: 10,
          fontFamily: 'inherit', cursor: 'pointer' }}>
          <Glyph kind="lookback" size={14} color="var(--text-secondary)" />
          Open a past record
        </button>
      </div>

      <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)',
        marginTop: 36, letterSpacing: '0.04em' }}>
        ⌘K open palette · ? shortcuts
      </div>
    </div>
  </div>
);

// Loading — "Opening the record…"
const LoadingApplied = () => (
  <div style={cbShell(0, 'var(--bg-app)')}>
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
      alignItems: 'center', justifyContent: 'center', gap: 28 }}>

      <div style={{ position: 'relative' }}>
        <Lunate size={56} />
        {/* a faint ghost behind it — past records */}
        <div style={{ position: 'absolute', inset: 0, opacity: 0.18 }}>
          <Lunate size={56} dot={false} color="var(--text-secondary)" />
        </div>
      </div>

      <div className="serif" style={{ fontSize: 18, color: 'var(--text-primary)',
        fontStyle: 'italic', fontWeight: 400 }}>
        Opening the record…
      </div>

      {/* A three-dot indicator inscribed as a row of entries */}
      <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
        {[0.35, 1, 0.35].map((o, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <div style={{ width: 24, height: 1, background: 'var(--text-muted)', opacity: o }} />
            <div style={{ width: 4, height: 4, borderRadius: 2,
              background: i === 1 ? 'var(--agent)' : 'var(--text-muted)',
              opacity: i === 1 ? 1 : 0.4 }} />
          </div>
        ))}
      </div>

      <div className="mono" style={{ fontSize: 10.5, color: 'var(--text-faint)',
        marginTop: 8, letterSpacing: '0.04em' }}>
        negotiating tls · verify-full · 192.168.0.42:5432
      </div>
    </div>
  </div>
);

// Activity dock header re-imagined with the Clio framing
const DockApplied = () => (
  <div style={cbShell(0, 'var(--bg-app)')}>
    <div style={{ margin: 24, background: 'var(--bg-panel)', flex: 1,
      borderRadius: 8, overflow: 'hidden',
      border: '1px solid var(--line-default)' }}>

      {/* dock header */}
      <div style={{ height: 36, padding: '0 14px', display: 'flex',
        alignItems: 'center', gap: 10, borderBottom: '1px solid var(--line-soft)' }}>
        <Lunate size={14} />
        <div style={{ fontSize: 12, fontWeight: 500 }}>Today&rsquo;s record</div>
        <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)',
          marginLeft: 'auto' }}>
          06:42 · 14 entries
        </div>
      </div>

      {/* Focus zone */}
      <div style={{ padding: '16px 16px 14px',
        background: 'var(--agent-wash)',
        borderBottom: '1px solid var(--agent-line)', position: 'relative' }}>
        <AgentEdge />
        <div style={{ display: 'flex', alignItems: 'center', gap: 8,
          marginBottom: 10 }}>
          <AgentBadge label="Claude Code" pulse />
          <span className="mono" style={{ fontSize: 10,
            color: 'var(--text-muted)', marginLeft: 'auto' }}>
            06:42 elapsed
          </span>
        </div>
        <div className="serif" style={{ fontSize: 14, fontWeight: 500,
          lineHeight: 1.35, marginBottom: 6 }}>
          Reconciling lead → patient conversion
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-secondary)',
          lineHeight: 1.55 }}>
          Looking at <span className="mono">leads</span> and{' '}
          <span className="mono">patients</span> joined on{' '}
          <span className="mono">phone_e164</span>…
        </div>
      </div>

      {/* Stream rows — each row leads with the entry glyph */}
      <div style={{ padding: '10px 0' }}>
        {[
          { kind: 'read',  verb: 'SELECT', sql: 'appointments WHERE patient_id…', meta: '412 rows · 124 ms', t: '14:22:34' },
          { kind: 'write', verb: 'UPDATE', sql: 'leads SET status = \u2018qualified\u2019', meta: '1 row · 8 ms', t: '14:23:02' },
          { kind: 'destruct', verb: 'DELETE', sql: 'leads WHERE created_at < now()…', meta: 'awaiting your approval', t: '14:23:18', warn: true },
        ].map((r, i) => (
          <div key={i} style={{ padding: '8px 14px',
            background: r.warn ? 'rgba(217, 108, 84, 0.06)' : 'transparent',
            display: 'flex', gap: 10, fontSize: 11 }}>
            <div style={{ display: 'flex', alignItems: 'center', paddingTop: 1 }}>
              <OpGlyph kind={r.kind} size={9} />
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span className="mono" style={{ fontWeight: 500,
                  color: `var(--op-${r.kind === 'destruct' ? 'destruct' : r.kind})` }}>
                  {r.verb}
                </span>
                <span className="mono" style={{ fontSize: 10,
                  color: 'var(--text-muted)', marginLeft: 'auto' }}>{r.t}</span>
              </div>
              <div className="mono" style={{ fontSize: 10.5,
                color: 'var(--text-secondary)', marginTop: 3,
                overflow: 'hidden', textOverflow: 'ellipsis',
                whiteSpace: 'nowrap' }}>
                {r.sql}
              </div>
              <div className="mono" style={{ fontSize: 10,
                color: r.warn ? 'var(--op-destruct)' : 'var(--text-muted)',
                marginTop: 2 }}>
                {r.warn && '⚠ '}{r.meta}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

// ─── Section 6 · VOICE ────────────────────────────────────────────
const VoiceCard = () => (
  <div style={cbShell(48, 'var(--bg-app)')}>
    <Eyebrow style={{ marginBottom: 8 }}>Voice</Eyebrow>
    <div style={{ fontSize: 12, color: 'var(--text-secondary)', maxWidth: 560,
      lineHeight: 1.55, marginBottom: 28 }}>
      Quiet, observant, archival. Most product text stays engineer-clean —
      <span className="mono"> 412 rows · 124 ms</span>. One literary touch per
      surface, never two. The serif appears for the agent's voice and for
      Clio's own framing words: <em className="serif">the record</em>,
      <em className="serif"> kept</em>, <em className="serif">witnessed</em>,
      <em className="serif"> look back</em>.
    </div>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr',
      gap: 0, flex: 1, minHeight: 0,
      border: '1px solid var(--line-soft)' }}>
      <div style={{ padding: '12px 16px', background: 'var(--bg-panel)',
        borderRight: '1px solid var(--line-soft)',
        borderBottom: '1px solid var(--line-soft)' }}>
        <Eyebrow>Generic</Eyebrow>
      </div>
      <div style={{ padding: '12px 16px', background: 'var(--bg-panel)',
        borderBottom: '1px solid var(--line-soft)' }}>
        <Eyebrow color="var(--agent)">Clio</Eyebrow>
      </div>

      {[
        ['Activity log',                'Today\u2019s record'],
        ['Session',                     'Chronicle'],
        ['No events yet',               'The record is empty.'],
        ['Connect a database',          'Open a database to begin a record.'],
        ['Replay session',              'Look back \u2192'],
        ['Audit',                       'Kept'],
        ['Agent activity here',         'Witnessed here'],
        ['Connecting\u2026',            'Opening the record\u2026'],
        ['Saved',                       'Entered into the record'],
        ['Past session',                'Past record · 14:22, two days ago'],
      ].map((row, i, all) => (
        <React.Fragment key={i}>
          <div className="mono" style={{ padding: '12px 16px', fontSize: 11.5,
            color: 'var(--text-muted)',
            borderRight: '1px solid var(--line-soft)',
            borderBottom: i === all.length - 1 ? 'none' : '1px solid var(--line-faint)' }}>
            {row[0]}
          </div>
          <div className="serif" style={{ padding: '12px 16px', fontSize: 13,
            color: 'var(--text-primary)', fontWeight: 400,
            borderBottom: i === all.length - 1 ? 'none' : '1px solid var(--line-faint)' }}>
            {row[1]}
          </div>
        </React.Fragment>
      ))}
    </div>
  </div>
);

// ─── Section 7 · DO / DON'T ───────────────────────────────────────
const DoDontCard = () => (
  <div style={cbShell(48, 'var(--bg-app)')}>
    <Eyebrow style={{ marginBottom: 28 }}>Do · Don&rsquo;t</Eyebrow>

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0,
      flex: 1, minHeight: 0, border: '1px solid var(--line-soft)' }}>

      {/* Do */}
      <div style={{ padding: '20px 22px',
        borderRight: '1px solid var(--line-soft)',
        display: 'flex', flexDirection: 'column' }}>
        <Eyebrow color="var(--op-read)" style={{ marginBottom: 14 }}>Do</Eyebrow>
        {[
          'Lean on the lunate and the dot. They\u2019re the whole identity.',
          'Use serif sparingly — agent\u2019s voice, modal titles, Clio\u2019s framing words.',
          'Keep the agent\u2019s copper sacred. Brand chrome borrows it only as a dot.',
          'Talk about \u201Cthe record\u201D where you used to say \u201Cactivity log\u201D.',
          'Stay engineer-clean by default. Earn each literary touch.',
        ].map((t, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 10,
            fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            <span style={{ color: 'var(--op-read)', marginTop: 4, flex: '0 0 auto' }}>
              <Glyph kind="entry" size={12} color="var(--op-read)" />
            </span>
            <span>{t}</span>
          </div>
        ))}
      </div>

      {/* Don't */}
      <div style={{ padding: '20px 22px',
        display: 'flex', flexDirection: 'column' }}>
        <Eyebrow color="var(--op-destruct)" style={{ marginBottom: 14 }}>Don&rsquo;t</Eyebrow>
        {[
          'No laurel wreaths, columns, togas, or Greek key patterns.',
          'No Trajan, no museum-poster typography. The brand isn\u2019t classical — it\u2019s archival.',
          'Don\u2019t personify Clio. She is the app, not a chatbot persona.',
          'Don\u2019t put Clio\u2019s mark on user-authored UI. Chrome only.',
          'Don\u2019t use the lunate as decoration. It\u2019s the mark, not a flourish.',
        ].map((t, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, marginBottom: 10,
            fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
            <span style={{ color: 'var(--op-destruct)', marginTop: 3, flex: '0 0 auto',
              fontSize: 13, lineHeight: 1, fontWeight: 600 }}>×</span>
            <span>{t}</span>
          </div>
        ))}
      </div>
    </div>
  </div>
);

// ─── Title artboard (decorative cover) ────────────────────────────
const CoverCard = () => (
  <div style={{ ...cbShell(0, 'var(--bg-canvas)'),
    display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    <div style={{ display: 'flex', flexDirection: 'column',
      alignItems: 'center', gap: 28 }}>
      <Lunate size={120} />
      <div style={{ textAlign: 'center' }}>
        <ClioWord size={48} />
        <div className="mono" style={{ fontSize: 11, color: 'var(--text-muted)',
          marginTop: 18, letterSpacing: '0.16em', textTransform: 'uppercase' }}>
          brand · v0.1
        </div>
      </div>
    </div>
  </div>
);

// ─── Canvas composer ──────────────────────────────────────────────
const ClioBrandCanvas = () => (
  <DesignCanvas>
    <DCSection id="why" title="Why Clio" subtitle="The thesis and its mapping to product surfaces.">
      <DCArtboard id="cover"     label="Cover"             width={520} height={680}>
        <CoverCard />
      </DCArtboard>
      <DCArtboard id="thesis"    label="A · Thesis"        width={820} height={680}>
        <ThesisCard />
      </DCArtboard>
      <DCArtboard id="etymology" label="B · Etymology"     width={520} height={680}>
        <EtymologyCard />
      </DCArtboard>
    </DCSection>

    <DCSection id="wordmark" title="Wordmark" subtitle="Geist Mono lowercase, round copper dot. The form the terminal sees, the form the chrome wears.">
      <DCArtboard id="wordmark" label="The wordmark" width={560} height={680}>
        <WordmarkHero />
      </DCArtboard>
      <DCArtboard id="rules"    label="With · without dot" width={560} height={680}>
        <WordmarkRulesCard />
      </DCArtboard>
    </DCSection>

    <DCSection id="mark" title="The mark" subtitle="The lunate with a single copper dot. Anatomy, sizing, lockups.">
      <DCArtboard id="construction" label="A · Construction" width={560} height={600}>
        <MarkConstructionCard />
      </DCArtboard>
      <DCArtboard id="sizes"        label="B · Sizes"        width={560} height={600}>
        <MarkSizesCard />
      </DCArtboard>
      <DCArtboard id="lockups"      label="C · Lockups"      width={600} height={600}>
        <LockupsCard />
      </DCArtboard>
    </DCSection>

    <DCSection id="glyphs" title="Glyph system" subtitle="Six expressions of one motif: half-circle, line, dot.">
      <DCArtboard id="glyphs" label="Glyph set" width={760} height={520}>
        <GlyphSystemCard />
      </DCArtboard>
    </DCSection>

    <DCSection id="surfaces" title="In the product" subtitle="The brand applied to live surfaces. Nothing else moves — Clio is the seam, not a redesign.">
      <DCArtboard id="chrome"  label="A · Window chrome + status" width={920} height={400}>
        <ChromeApplied />
      </DCArtboard>
      <DCArtboard id="empty"   label="B · Empty / first-run"      width={640} height={560}>
        <EmptyApplied />
      </DCArtboard>
      <DCArtboard id="loading" label="C · Connecting"             width={520} height={480}>
        <LoadingApplied />
      </DCArtboard>
      <DCArtboard id="dock"    label="D · Agent dock"             width={400} height={560}>
        <DockApplied />
      </DCArtboard>
    </DCSection>

    <DCSection id="voice" title="Voice" subtitle="Engineer-clean by default. One literary touch per surface — never two.">
      <DCArtboard id="voice"  label="Vocabulary"  width={720} height={620}>
        <VoiceCard />
      </DCArtboard>
      <DCArtboard id="dodont" label="Do · Don\u2019t" width={720} height={620}>
        <DoDontCard />
      </DCArtboard>
    </DCSection>
  </DesignCanvas>
);

Object.assign(window, { ClioBrandCanvas });
