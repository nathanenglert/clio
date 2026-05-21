/* Inline annotation callouts that hang off design artboards.
   Used to explain design decisions adjacent to elements. */

// A callout consists of:
// - a Pin placed inside the artboard at relative coords
// - a Note placed adjacent to the artboard with the same pin number
// Pins are numbered per-artboard.

// Anchored pin (positioned within an artboard)
const CalloutPin = ({ n, top, left, right, bottom, color = 'var(--agent)' }) => (
  <div style={{
    position: 'absolute', top, left, right, bottom,
    transform: 'translate(-50%, -50%)',
    zIndex: 5, pointerEvents: 'none',
  }}>
    <div style={{
      width: 22, height: 22, borderRadius: '50%',
      background: color,
      color: '#1a1714',
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 11, fontWeight: 700, fontFamily: 'var(--font-mono)',
      boxShadow: '0 2px 10px rgba(0,0,0,0.5), 0 0 0 3px rgba(212, 145, 90, 0.18)',
    }}>{n}</div>
  </div>
);

// A right-side note panel (sits adjacent to an artboard)
const CalloutNotes = ({ title, notes, width = 280, accent = 'var(--agent)' }) => (
  <div style={{
    width, padding: '4px 0', fontFamily: 'var(--font-ui)',
    color: 'rgba(40,30,20,0.85)',
  }}>
    {title && (
      <div className="serif" style={{
        fontSize: 14, fontWeight: 500, marginBottom: 10,
        color: 'rgba(40,30,20,0.85)',
      }}>{title}</div>
    )}
    {notes.map((note, i) => (
      <div key={i} style={{
        display: 'flex', gap: 10, marginBottom: 14,
        alignItems: 'flex-start',
      }}>
        <div style={{
          width: 20, height: 20, borderRadius: '50%', flex: '0 0 auto',
          background: accent, color: '#1a1714',
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          fontSize: 10, fontWeight: 700, fontFamily: 'var(--font-mono)',
          marginTop: 1,
        }}>{i + 1}</div>
        <div style={{ flex: 1, fontSize: 12.5, lineHeight: 1.55,
          color: 'rgba(40,30,20,0.82)',
        }}>
          {typeof note === 'string' ? note : note}
        </div>
      </div>
    ))}
  </div>
);

// Convenient horizontal layout: artboard + notes side-by-side
const WithNotes = ({ children, notes, title, gap = 32, notesWidth = 280, notesPos = 'right' }) => (
  <div style={{ display: 'flex', gap, alignItems: 'flex-start',
    flexDirection: notesPos === 'left' ? 'row-reverse' : 'row',
  }}>
    {children}
    <CalloutNotes title={title} notes={notes} width={notesWidth} />
  </div>
);

// Section intro: a designer's-note block that goes above a row of artboards.
const SectionIntro = ({ title, children, width = 560 }) => (
  <div style={{
    width, padding: '0 4px', fontFamily: 'var(--font-ui)',
    color: 'rgba(40,30,20,0.85)', marginBottom: 8,
  }}>
    <div className="serif" style={{ fontSize: 22, fontWeight: 500,
      letterSpacing: '-0.01em', marginBottom: 8,
      color: 'rgba(30,20,10,0.92)',
    }}>{title}</div>
    <div style={{ fontSize: 13, lineHeight: 1.6, color: 'rgba(50,40,30,0.78)' }}>
      {children}
    </div>
  </div>
);

Object.assign(window, { CalloutPin, CalloutNotes, WithNotes, SectionIntro });
