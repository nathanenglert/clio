/* Result editing surfaces: dirty cells, add row, delete row, pending tray, review modal.
   Companion to surfaces.jsx — reference visual implementation only. See design/result-editing.md. */

// ── Read-only banner ─────────────────────────────────────────────────
const ReadOnlyBanner = ({ reason = 'spans multiple tables' }) => (
  <div style={{
    display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px',
    background: 'rgba(212, 161, 85, 0.06)',
    borderBottom: '1px solid var(--line-soft)',
    fontSize: 11, color: 'var(--text-secondary)',
  }}>
    <span style={{ color: 'var(--text-muted)' }}>{Icons.lock}</span>
    <span>
      <span style={{ color: 'var(--text-primary)' }}>Read-only result</span>
      <span style={{ color: 'var(--text-muted)' }}> · {reason}</span>
    </span>
    <div style={{ flex: 1 }} />
    <button style={{
      ...editorBtn, height: 20, padding: '0 7px',
      fontSize: 10, color: 'var(--text-muted)',
    }}>Why?</button>
  </div>
);

// ── Sample staged state ─────────────────────────────────────────────
// Maps PATIENT_ROWS by index. Each entry is one of:
//   { kind: 'edit', cells: { [colIdx]: { was, now } } }
//   { kind: 'delete' }
//   { kind: 'add', cells: [c0, c1, …] }
const STAGED = {
  0: { kind: 'edit',   cells: { 5: { was: '+1 415 555 0142', now: '+1 510 555 0103' } } },
  4: { kind: 'edit',   cells: { 6: { was: 'aiyana.t@…',     now: 'aiyana@new.org' } } },
  5: { kind: 'delete' },
};
const STAGED_ADDS = [
  ['M0048841', 'M0048841', 'Alex', 'Cho', '1990-04-12', '', '', '', '', ''],
];

// ── Editable grid (dirty cell + add row + delete row + ghost row) ───
const EditableResultsGrid = ({ cols = PATIENT_COLS, rows = PATIENT_ROWS, staged = STAGED, adds = STAGED_ADDS }) => {
  const totalW = cols.reduce((a, c) => a + c.w, 40);
  return (
    <div style={{
      flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0,
      background: 'var(--bg-app)', overflow: 'hidden',
    }}>
      {/* toolbar */}
      <div style={{
        height: 30, flex: '0 0 auto', display: 'flex', alignItems: 'center',
        padding: '0 10px', gap: 12,
        background: 'var(--bg-panel)', borderBottom: '1px solid var(--line-soft)',
        fontSize: 11, color: 'var(--text-secondary)',
      }}>
        <StatusPill tone="ok" mono>12,840 rows · 86 ms</StatusPill>
        <span style={{ color: 'var(--line-strong)' }}>│</span>
        <span className="mono" style={{ color: 'var(--text-muted)' }}>
          select * from patients order by created_at desc limit 200
        </span>
        <div style={{ flex: 1 }} />
        <button style={editorBtn}>{Icons.filter} Filter</button>
        <button style={editorBtn}>{Icons.export} Export</button>
        <button style={{
          ...editorBtn,
          color: 'var(--op-write)',
          borderColor: 'rgba(212,161,85,0.35)',
        }}>{Icons.plus} Add row</button>
        <button style={editorBtn}>{Icons.refresh}</button>
      </div>

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
              {c.idx && <span style={{ color: 'var(--text-muted)', fontSize: 9 }}>{Icons.index}</span>}
              <span style={{ marginLeft: 'auto', color: 'var(--text-faint)', fontSize: 10 }}>{c.type}</span>
            </div>
          ))}
        </div>

        {/* existing rows */}
        <div>
          {rows.map((row, ri) => {
            const s = staged[ri];
            const isDeleted = s?.kind === 'delete';
            return (
              <div key={ri} style={{
                display: 'flex', height: 28,
                borderBottom: '1px solid var(--line-faint)',
                background: ri % 2 ? 'transparent' : 'rgba(255,240,220,0.012)',
                fontFamily: 'var(--font-mono)', fontSize: 11.5,
                color: isDeleted ? 'var(--op-destruct)' : 'var(--text-primary)',
                textDecoration: isDeleted ? 'line-through' : 'none',
                opacity: isDeleted ? 0.7 : 1,
                position: 'relative',
              }}>
                {/* gutter */}
                <div style={{
                  width: 40, flex: '0 0 auto', textAlign: 'right',
                  padding: '7px 8px',
                  color: isDeleted ? 'var(--op-destruct)' : 'var(--text-faint)',
                  display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4,
                }}>
                  {isDeleted
                    ? <OpGlyph kind="destruct" size={9} />
                    : ri + 1}
                </div>
                {row.map((cell, ci) => {
                  const edited = s?.kind === 'edit' && s.cells[ci];
                  const col = cols[ci];
                  const isNull = cell === null;
                  const isJson = col?.type === 'jsonb';
                  const value = edited ? edited.now : (isNull ? 'null' : cell);
                  return (
                    <div key={ci} style={{
                      width: col.w, flex: '0 0 auto', padding: '7px 10px',
                      borderRight: '1px solid var(--line-faint)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      color: isNull && !edited ? 'var(--text-faint)'
                            : isJson ? 'var(--op-ddl)' : 'inherit',
                      fontStyle: isNull && !edited ? 'italic' : 'normal',
                      position: 'relative',
                      boxShadow: edited && !isDeleted
                        ? 'inset 2px 0 0 0 var(--op-write)'
                        : 'none',
                    }}>
                      {value}
                    </div>
                  );
                })}
              </div>
            );
          })}

          {/* staged adds */}
          {adds.map((row, ai) => (
            <div key={`add-${ai}`} style={{
              display: 'flex', height: 28,
              borderBottom: '1px solid var(--line-faint)',
              fontFamily: 'var(--font-mono)', fontSize: 11.5,
              color: 'var(--text-primary)',
              background: 'rgba(212,161,85,0.04)',
            }}>
              <div style={{
                width: 40, flex: '0 0 auto', textAlign: 'right',
                padding: '7px 8px', color: 'var(--op-write)',
                display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4,
              }}>
                <OpGlyph kind="write" size={9} />
              </div>
              {row.map((cell, ci) => {
                const col = cols[ci];
                const empty = cell === '' || cell == null;
                return (
                  <div key={ci} style={{
                    width: col.w, flex: '0 0 auto', padding: '7px 10px',
                    borderRight: '1px solid var(--line-faint)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    color: empty ? 'var(--text-faint)' : 'inherit',
                    fontStyle: empty ? 'italic' : 'normal',
                    boxShadow: 'inset 2px 0 0 0 var(--op-write)',
                  }}>
                    {empty ? (col.name === 'id' ? 'gen_random_uuid()' : '—') : cell}
                  </div>
                );
              })}
            </div>
          ))}

          {/* ghost row (placeholder for next add) */}
          <div style={{
            display: 'flex', height: 28,
            borderBottom: '1px dashed var(--line-faint)',
            fontFamily: 'var(--font-mono)', fontSize: 11.5,
            color: 'var(--text-faint)', fontStyle: 'italic',
            cursor: 'text',
          }}>
            <div style={{
              width: 40, flex: '0 0 auto', textAlign: 'right',
              padding: '7px 8px', color: 'var(--text-faint)',
            }}>+</div>
            <div style={{ padding: '7px 10px' }}>Click or ⌘N to add a row…</div>
          </div>
        </div>
      </div>
    </div>
  );
};

// ── Pending changes tray (above status bar) ─────────────────────────
const PendingTray = ({ edits = 2, adds = 1, deletes = 1, table = 'patients', conn = 'lassomd-staging' }) => {
  const Seg = ({ kind, count, label }) => count > 0 && (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <OpGlyph kind={kind} size={9} />
      <span className="mono" style={{ color: 'var(--text-primary)' }}>{count}</span>
      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
    </span>
  );
  return (
    <div style={{
      height: 36, flex: '0 0 auto',
      display: 'flex', alignItems: 'center',
      padding: '0 14px', gap: 14,
      background: 'var(--bg-panel)',
      borderTop: '1px solid var(--line-default)',
      borderBottom: '1px solid var(--line-soft)',
      fontSize: 11, color: 'var(--text-secondary)',
    }}>
      <Seg kind="write"    count={edits}   label="edits" />
      <Seg kind="write"    count={adds}    label="add" />
      <Seg kind="destruct" count={deletes} label="delete" />
      <span style={{ color: 'var(--line-strong)' }}>·</span>
      <span className="mono" style={{ color: 'var(--text-muted)' }}>
        {table} @ {conn}
      </span>
      <span style={{ color: 'var(--line-strong)' }}>·</span>
      <span style={{ color: 'var(--text-muted)', fontStyle: 'italic' }}>uncommitted</span>
      <div style={{ flex: 1 }} />
      <button style={editorBtn}>Review SQL</button>
      <button style={{
        ...editorBtn,
        color: 'var(--op-write)',
        borderColor: 'rgba(212,161,85,0.55)',
        background: 'rgba(212,161,85,0.06)',
      }}>Commit  <Kbd dim>⌘⏎</Kbd></button>
      <button style={iconBtn} title="Discard">{Icons.close}</button>
    </div>
  );
};

// ── Review SQL modal ────────────────────────────────────────────────
// Renders only the modal panel — wrap in an overlay (FullShell's `overlay` prop
// supplies the backdrop) when composing into an artboard.
const ReviewModal = () => (
  <div style={{
    width: 720, maxHeight: '80%',
    background: 'var(--bg-panel)',
    border: '1px solid var(--line-default)',
    borderRadius: 8,
    boxShadow: '0 24px 64px rgba(0,0,0,0.5)',
    display: 'flex', flexDirection: 'column',
    overflow: 'hidden',
  }}>
    {/* header */}
      <div style={{
        height: 38, padding: '0 14px', flex: '0 0 auto',
        display: 'flex', alignItems: 'center', gap: 10,
        borderBottom: '1px solid var(--line-soft)',
        fontSize: 12, color: 'var(--text-secondary)',
      }}>
        <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>Review</span>
        <span style={{ color: 'var(--line-strong)' }}>·</span>
        <span className="mono" style={{ color: 'var(--text-muted)' }}>4 statements</span>
        <span style={{ color: 'var(--line-strong)' }}>·</span>
        <span className="mono" style={{ color: 'var(--text-muted)' }}>lassomd-staging</span>
        <div style={{ flex: 1 }} />
        <button style={iconBtn}>{Icons.close}</button>
      </div>

      {/* body: SQL */}
      <div style={{
        flex: 1, padding: '14px 16px', overflow: 'auto',
        fontFamily: 'var(--font-mono)', fontSize: 12, lineHeight: 1.55,
        color: 'var(--text-primary)',
        background: 'var(--bg-input)',
      }}>
        <div style={{ color: 'var(--text-muted)' }}>BEGIN;</div>
        <div style={{ height: 8 }} />
        <div>
          <span style={{ color: 'var(--op-write)', fontWeight: 500 }}>UPDATE</span>{' '}
          <span style={{ color: 'var(--text-primary)' }}>public.patients</span>
        </div>
        <div style={{ paddingLeft: 16 }}>
          <span style={{ color: 'var(--text-muted)' }}>SET</span>{' '}
          phone_e164 = <span style={{ color: '#9ab38a' }}>'+1 510 555 0103'</span>
        </div>
        <div style={{ paddingLeft: 16 }}>
          <span style={{ color: 'var(--text-muted)' }}>WHERE</span>{' '}
          id = <span style={{ color: '#9ab38a' }}>'M0048221'</span>;
        </div>
        <div style={{ height: 8 }} />
        <div>
          <span style={{ color: 'var(--op-write)', fontWeight: 500 }}>UPDATE</span>{' '}
          <span style={{ color: 'var(--text-primary)' }}>public.patients</span>
        </div>
        <div style={{ paddingLeft: 16 }}>
          <span style={{ color: 'var(--text-muted)' }}>SET</span>{' '}
          email = <span style={{ color: '#9ab38a' }}>'aiyana@new.org'</span>
        </div>
        <div style={{ paddingLeft: 16 }}>
          <span style={{ color: 'var(--text-muted)' }}>WHERE</span>{' '}
          id = <span style={{ color: '#9ab38a' }}>'M0048217'</span>;
        </div>
        <div style={{ height: 8 }} />
        <div>
          <span style={{ color: 'var(--op-write)', fontWeight: 500 }}>INSERT</span>{' '}
          <span style={{ color: 'var(--text-muted)' }}>INTO</span>{' '}
          <span style={{ color: 'var(--text-primary)' }}>public.patients</span>{' '}
          (id, first_name, last_name, dob)
        </div>
        <div style={{ paddingLeft: 16 }}>
          <span style={{ color: 'var(--text-muted)' }}>VALUES</span>{' '}
          (<span style={{ color: '#9ab38a' }}>'M0048841'</span>,{' '}
          <span style={{ color: '#9ab38a' }}>'Alex'</span>,{' '}
          <span style={{ color: '#9ab38a' }}>'Cho'</span>,{' '}
          <span style={{ color: '#9ab38a' }}>'1990-04-12'</span>);
        </div>
        <div style={{ height: 8 }} />
        <div>
          <span style={{ color: 'var(--op-destruct)', fontWeight: 600 }}>DELETE</span>{' '}
          <span style={{ color: 'var(--text-muted)' }}>FROM</span>{' '}
          <span style={{ color: 'var(--text-primary)' }}>public.patients</span>
        </div>
        <div style={{ paddingLeft: 16 }}>
          <span style={{ color: 'var(--text-muted)' }}>WHERE</span>{' '}
          id = <span style={{ color: '#9ab38a' }}>'M0048216'</span>;
        </div>
        <div style={{ height: 8 }} />
        <div style={{ color: 'var(--text-muted)' }}>COMMIT;</div>
      </div>

      {/* warn line */}
      <div style={{
        padding: '8px 16px', display: 'flex', alignItems: 'center', gap: 8,
        borderTop: '1px solid var(--line-soft)',
        background: 'rgba(217, 108, 84, 0.06)',
        fontSize: 11, color: 'var(--op-destruct)',
      }}>
        <span>{Icons.warn}</span>
        <span style={{ color: 'var(--text-secondary)' }}>
          1 destructive statement — DELETE will be re-confirmed before running.
        </span>
      </div>

      {/* footer */}
      <div style={{
        height: 44, padding: '0 14px', flex: '0 0 auto',
        display: 'flex', alignItems: 'center', gap: 8,
        borderTop: '1px solid var(--line-default)',
      }}>
        <button style={editorBtn}>Copy SQL</button>
        <div style={{ flex: 1 }} />
        <button style={editorBtn}>Cancel</button>
        <button style={{
          ...editorBtn,
          color: 'var(--op-write)',
          borderColor: 'rgba(212,161,85,0.55)',
          background: 'rgba(212,161,85,0.08)',
        }}>Commit</button>
      </div>
  </div>
);

Object.assign(window, {
  ReadOnlyBanner, EditableResultsGrid, PendingTray, ReviewModal, STAGED, STAGED_ADDS,
});
