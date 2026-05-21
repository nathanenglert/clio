/* The full design canvas content: sections + artboards. */

const W_FULL = 1440;
const H_FULL = 900;

const App = () => (
  <DesignCanvas>
    {/* ─── System reference ─────────────────────────────────────── */}
    <DCSection id="system"
      title="Visual system"
      subtitle="One direction, committed. Warm dark; copper owns the agent.">
      <DCArtboard id="sys-ref" label="Tokens & vocabulary" width={1180} height={720}>
        <SystemReference />
      </DCArtboard>
      <DCArtboard id="sys-empty" label="Empty / first-run" width={W_FULL} height={H_FULL}>
        <FullShell empty agentVariant="none" showRail={false}
          windowTitle="Database App"
          agentActive={false}
        />
      </DCArtboard>
    </DCSection>

    {/* ─── Main application shell ───────────────────────────────── */}
    <DCSection id="shell"
      title="Application shell"
      subtitle="The chrome that holds everything. Right-dock agent is the default.">
      <DCArtboard id="shell-primary" label="Primary · right-dock agent"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="right-dock"
          windowSubtitle="postgres 16.4"
          activeTab={0}
          agentActive
        />
        {/* annotations */}
        <CalloutPin n={1} top={18}  left={'50%'} />
        <CalloutPin n={2} top={170} left={130} />
        <CalloutPin n={3} top={70}  left={W_FULL - 200} />
        <CalloutPin n={4} top={H_FULL - 12} left={W_FULL / 2} />
        <CalloutPin n={5} top={460} left={W_FULL - 340} color={'var(--op-destruct)'} />
      </DCArtboard>
      <DCArtboard id="shell-notes" label="Notes" width={420} height={H_FULL}
        style={{ background: '#f5f1ea', borderRadius: 12, padding: 32 }}>
        <CalloutNotes
          title="Why this layout"
          notes={[
            <span><b>Agent active dot in the title bar.</b> The window literally
              says "an agent is here." This is the smallest possible ambient
              signal — present at every zoom level, never demanding.</span>,
            <span><b>Schema rail with agent-touched dots.</b> A 5px copper dot
              next to any table the agent has read in this session. No new
              panel, no clutter — the rail itself becomes a heatmap of where
              the agent's been.</span>,
            <span><b>Agent badge in the toolbar</b> is always-visible and links
              to the dock. Click to expand history, ⌘. to pause. Pulses while
              the agent is actively running queries.</span>,
            <span><b>Status bar shows policy.</b> "read-any · write-public" is
              the active policy in plain English; click to open the editor.
              Engineers glance here the same way they glance at git branch.</span>,
            <span><b>Pending approval is loud, not the chrome.</b> When a
              destructive write needs the human, the stream row turns red,
              the bottom-strip variant lights up, and the dock title pulses.
              Idle chatter never gets to look like an alarm.</span>,
          ]}
        />
      </DCArtboard>
    </DCSection>

    {/* ─── Shell states ─────────────────────────────────────────── */}
    <DCSection id="shell-states"
      title="Shell states"
      subtitle="Same chrome, different traffic.">
      <DCArtboard id="shell-empty" label="A · Empty / first connection"
        width={W_FULL} height={H_FULL}>
        <FullShell empty showRail={false} agentVariant="none"
          agentActive={false}
          windowTitle="Database App" />
      </DCArtboard>
      <DCArtboard id="shell-loading" label="B · Connecting"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="none" agentActive={false}
          windowTitle="Connecting…" windowSubtitle="prod.lassomd.internal:5432">
          <div style={{ flex: 1, display: 'flex', alignItems: 'center',
            justifyContent: 'center', flexDirection: 'column', gap: 16 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {[0, 1, 2].map(i => (
                <div key={i} style={{
                  width: 8, height: 8, borderRadius: '50%',
                  background: 'var(--text-muted)',
                  opacity: i === 1 ? 1 : 0.4,
                }} />
              ))}
            </div>
            <div className="mono" style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              negotiating TLS · verify-full
            </div>
            <div className="mono" style={{ fontSize: 10, color: 'var(--text-muted)' }}>
              postgres 16.4 · 21 schemas · 348 tables · 14 connections in pool
            </div>
          </div>
        </FullShell>
      </DCArtboard>
      <DCArtboard id="shell-heavy" label="C · High-traffic — 8 tabs, 100k rows, agent busy"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="right-dock" agentActive queued={3}
          tabs={[
            { glyph: Icons.table, label: 'patients', mono: true, dirty: true },
            { glyph: Icons.table, label: 'appointments', mono: true },
            { glyph: Icons.table, label: 'leads', mono: true, dirty: true },
            { glyph: Icons.table, label: 'visits', mono: true },
            { glyph: Icons.view,  label: 'patient_summary', mono: true },
            { glyph: Icons.bolt,  label: 'reconciliation.sql', dirty: true },
            { glyph: Icons.bolt,  label: 'scratch.sql' },
            { glyph: Icons.history, label: 'session · 14:18 →', mono: true },
          ]}
          agentTab={6}
          activeTab={0}
          resultRows={[...PATIENT_ROWS, ...PATIENT_ROWS].slice(0, 22)}
        />
      </DCArtboard>
    </DCSection>

    {/* ─── Schema browser ───────────────────────────────────────── */}
    <DCSection id="schema"
      title="Schema browser"
      subtitle="Left rail. Anticipates the v0.3 agent annotation feature.">
      <DCArtboard id="schema-default" label="Default"
        width={320} height={720}>
        <div style={{ width: '100%', height: '100%', background: 'var(--bg-panel)',
          fontFamily: 'var(--font-ui)', borderRight: '1px solid var(--line-default)' }}>
          <SchemaTree />
        </div>
      </DCArtboard>
      <DCArtboard id="schema-annotated" label="With agent annotations (v0.3)"
        width={320} height={720}>
        <div style={{ width: '100%', height: '100%', background: 'var(--bg-panel)',
          fontFamily: 'var(--font-ui)', borderRight: '1px solid var(--line-default)' }}>
          <SchemaTree annotated />
        </div>
      </DCArtboard>
      <DCArtboard id="schema-search" label="Searching · ⌘P"
        width={320} height={720}>
        <div style={{ width: '100%', height: '100%', background: 'var(--bg-panel)',
          fontFamily: 'var(--font-ui)' }}>
          <SchemaSearchState />
        </div>
      </DCArtboard>
      <DCArtboard id="schema-detail" label="Table detail · agent-touched"
        width={400} height={720}>
        <div style={{ width: '100%', height: '100%', background: 'var(--bg-panel)',
          fontFamily: 'var(--font-ui)' }}>
          <TableDetail />
        </div>
      </DCArtboard>
      <DCArtboard id="schema-notes" label="Notes" width={380} height={720}
        style={{ background: '#f5f1ea', borderRadius: 12, padding: 28 }}>
        <CalloutNotes notes={[
          <span><b>Mono identifiers, sans-serif chrome.</b> Table and column
            names are <span style={{fontFamily:'var(--font-mono)'}}>mono</span> —
            you copy/paste them constantly, they need to look like code.
            Schema headers are uppercase sans because they're navigation,
            not data.</span>,
          <span><b>Per-table agent dot.</b> A 5px copper dot next to any
            table the agent has read or written in this session. Hover for
            "agent read 4 times, last 14:22." Zero new panels.</span>,
          <span><b>Pin glyph for agent notes (v0.3).</b> When the agent
            attaches a note to a table or column, a pin appears in the
            rail. The note expands inline — never a separate inspector.</span>,
          <span><b>Read-only connections carry no &laquo;RW&raquo; chip;</b>{' '}
            read-write connections do. The presence of the orange chip is
            the safety signal. Read-only feels like the default.</span>,
        ]} />
      </DCArtboard>
    </DCSection>

    {/* ─── Query editor + results ───────────────────────────────── */}
    <DCSection id="editor"
      title="Query editor & results grid"
      subtitle="User and agent share the editor — but their queries don't look the same.">
      <DCArtboard id="editor-user" label="A · User query — clean chrome"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="right-dock" />
      </DCArtboard>
      <DCArtboard id="editor-agent" label="B · Agent wrote this query — copper wash + badge"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="right-dock"
          editorLines={AGENT_QUERY}
          editorAgent
          agentActive
          activeCell={null}
        >
          <TabBar
            tabs={[
              { glyph: Icons.table, label: 'patients', mono: true },
              { glyph: Icons.bolt,  label: 'reconciliation.sql', dirty: true },
              { glyph: Icons.bolt,  label: 'agent · lead-cleanup.sql', mono: true, dirty: true },
            ]}
            active={2} agentTab={2}
          />
          <div style={{ position: 'relative', background: 'var(--agent-wash)',
            borderBottom: '1px solid var(--agent-line)' }}>
            <AgentEdge style={{ background: 'linear-gradient(180deg, var(--agent), var(--agent))' }} />
            <QueryEditor lines={AGENT_QUERY} agent height={210} />
          </div>
          <ResultsGrid
            meta={{ rows: '412', ms: '124', query: AGENT_QUERY[0].replace(/<[^>]+>/g,'').replace(/^-- /,'') }}
          />
        </FullShell>
      </DCArtboard>
      <DCArtboard id="editor-json" label="C · JSON viewer · jsonb cell"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="right-dock" jsonOpen
          activeCell={[0, 7]} />
      </DCArtboard>
      <DCArtboard id="editor-edit" label="D · Inline cell edit"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="right-dock"
          activeCell={[2, 5]}
        >
          <TabBar tabs={DEFAULT_TABS} active={0} />
          <QueryEditor lines={DEFAULT_QUERY} height={170} />
          <CellEditOverlay />
        </FullShell>
      </DCArtboard>
    </DCSection>

    {/* ─── Agent activity surface — 3 directions ────────────────── */}
    <DCSection id="agent-dock"
      title="Agent activity surface · A · Right dock"
      subtitle="Persistent panel. Best for calm, sustained supervision. Eats 340px of width.">
      <DCArtboard id="dock-calm" label="Calm — agent reading"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="right-dock" />
      </DCArtboard>
      <DCArtboard id="dock-attention" label="Attention — permission gate inline"
        width={W_FULL} height={H_FULL}>
        <FullShell
          agentVariant="none"
          editorLines={DESTRUCT_QUERY}
          editorAgent
          editorDestructive
        >
          <TabBar
            tabs={[
              { glyph: Icons.table, label: 'leads', mono: true },
              { glyph: Icons.bolt, label: 'agent · lead-cleanup.sql', mono: true, dirty: true },
            ]}
            active={1} agentTab={1}
          />
          <QueryEditor lines={DESTRUCT_QUERY} agent destructive height={180}
            runLabel="Run · destructive" />
          <ResultsGrid
            meta={{ rows: '~218 estimated', ms: '4', query: 'EXPLAIN delete from leads …' }}
            rows={[]}
          />
        </FullShell>
        {/* dock with the permission gate */}
        <div style={{
          position: 'absolute', top: 36, right: 0, width: 340, bottom: 24,
          display: 'flex', flexDirection: 'column',
          background: 'var(--bg-panel)',
          borderLeft: '1px solid var(--op-destruct)',
          boxShadow: '-12px 0 32px rgba(217, 108, 84, 0.06)',
        }}>
          <div style={{
            height: 32, flex: '0 0 auto', display: 'flex', alignItems: 'center',
            padding: '0 12px', gap: 8,
            borderBottom: '1px solid var(--line-soft)',
          }}>
            <span style={{ display: 'inline-flex' }}>{Icons.agentDot}</span>
            <span style={{ fontSize: 12, fontWeight: 500 }}>Agent</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--op-destruct)' }}>
              · awaiting you
            </span>
            <span style={{
              marginLeft: 'auto', width: 6, height: 6, borderRadius: '50%',
              background: 'var(--op-destruct)',
              boxShadow: '0 0 8px var(--op-destruct)',
            }} />
          </div>
          <PermissionCard
            destructive deviation
            agentText={<>I want to clean up <span className="mono"
              style={{color:'var(--text-primary)'}}>218 expired leads</span>{' '}
              older than 90 days that aren't tied to any patient or appointment.
              Safe to delete — none are referenced by visits.</>}
            sql={<>
              <span className="sql-destruct">DELETE</span>{' '}
              <span className="sql-kw">FROM</span> leads<br/>
              <span className="sql-kw">WHERE</span> created_at <span className="sql-op">&lt;</span>{' '}
              <span className="sql-fn">now</span>() <span className="sql-op">-</span>{' '}
              <span className="sql-kw">interval</span> <span className="sql-str">'90 days'</span><br/>
              {'  '}<span className="sql-kw">AND</span> status <span className="sql-op">=</span>{' '}
              <span className="sql-str">'expired'</span>;
            </>}
            est="~218 rows"
          />
          <div style={{ flex: 1 }} />
        </div>
      </DCArtboard>
    </DCSection>

    <DCSection id="agent-drawer"
      title="Agent activity surface · B · Bottom drawer"
      subtitle="Status strip when calm, full drawer when expanded. Best when grid space is precious.">
      <DCArtboard id="drawer-strip" label="Collapsed strip · calm"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="bottom-strip" />
      </DCArtboard>
      <DCArtboard id="drawer-attention" label="Collapsed strip · attention required"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="bottom-strip" awaitingApproval />
      </DCArtboard>
      <DCArtboard id="drawer-open" label="Expanded drawer · focus + stream"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="bottom-drawer" />
      </DCArtboard>
    </DCSection>

    <DCSection id="agent-inline"
      title="Agent activity surface · C · Inline annotations"
      subtitle="No separate panel. Agent's presence decorates the workspace where the action is.">
      <DCArtboard id="inline-calm" label="Calm — markers in place"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="inline" />
      </DCArtboard>
      <DCArtboard id="inline-attention" label="Attention — markers escalate, hover preview"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="inline">
          <TabBar tabs={DEFAULT_TABS} active={0} />
          <QueryEditor lines={DEFAULT_QUERY} height={210} />
          <ResultsGrid />
        </FullShell>
        {/* hover preview popup over the marker */}
        <div style={{
          position: 'absolute', bottom: 110, right: 28, width: 380,
          background: 'var(--bg-elevated)',
          border: '1px solid var(--op-destruct)',
          borderLeftWidth: 3,
          borderRadius: 8, padding: 14,
          boxShadow: 'var(--shadow-lg)',
          fontFamily: 'var(--font-ui)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
            <OpGlyph kind="destruct" size={11} />
            <span style={{ fontSize: 10.5, letterSpacing: '0.08em', fontWeight: 600,
              color: 'var(--op-destruct)', fontFamily: 'var(--font-mono)' }}>
              AWAITING APPROVAL · DESTRUCTIVE
            </span>
          </div>
          <div style={{ fontSize: 12.5, lineHeight: 1.55, color: 'var(--text-primary)',
            marginBottom: 10 }}>
            Delete 218 expired leads older than 90 days, not tied to any
            patient.
          </div>
          <div className="mono" style={{ padding: '8px 10px', background: 'var(--bg-input)',
            border: '1px solid var(--line-default)', borderRadius: 5, fontSize: 11,
            color: 'var(--text-primary)', marginBottom: 10 }}>
            <span className="sql-destruct">DELETE</span> <span className="sql-kw">FROM</span> leads <span className="sql-kw">WHERE</span>{' '}
            <span className="sql-id">created_at</span> <span className="sql-op">&lt;</span>{' '}
            <span className="sql-fn">now</span>() <span className="sql-op">-</span>{' '}
            <span className="sql-str">'90d'</span> …
          </div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button style={{
              flex: 1, height: 28, borderRadius: 5, border: 0,
              background: 'var(--op-destruct)', color: '#1a1714',
              fontSize: 11.5, fontWeight: 500, fontFamily: 'var(--font-ui)',
            }}>Allow ⏎</button>
            <button style={{
              height: 28, padding: '0 12px', borderRadius: 5,
              background: 'var(--bg-elevated-2)', color: 'var(--text-primary)',
              border: '1px solid var(--line-default)', fontSize: 11.5,
              fontFamily: 'var(--font-ui)',
            }}>Deny</button>
            <button style={{...editorBtn, height: 28, fontSize: 11.5}}>Open in dock</button>
          </div>
        </div>
      </DCArtboard>
    </DCSection>

    {/* ─── Command palette ──────────────────────────────────────── */}
    <DCSection id="palette"
      title="Command palette · ⌘K"
      subtitle="The navigational spine. Tables, columns, queries, commands — and the agent.">
      <DCArtboard id="palette-global" label="Global"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="right-dock" overlay={{
          node: <CommandPalette query="appoint" />,
          top: -240,
        }} />
      </DCArtboard>
      <DCArtboard id="palette-agent" label="Ask the agent mode · ⌘⇧A"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="right-dock" overlay={{
          node: <CommandPalette mode="agent"
            query="why did the appointment count jump on tuesday" />,
          top: -240,
        }} />
      </DCArtboard>
    </DCSection>

    {/* ─── Connections + Policy + Permission gate ───────────────── */}
    <DCSection id="connections"
      title="Connections & policy"
      subtitle="Where the read-only / read-write distinction is set and enforced.">
      <DCArtboard id="conn-list" label="Connection list"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="none" agentActive={false} overlay={{
          node: <ConnectionManager mode="list" />,
        }} />
      </DCArtboard>
      <DCArtboard id="conn-edit" label="Edit connection · read-only emphasis"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="none" agentActive={false} overlay={{
          node: <ConnectionManager mode="edit" />,
        }} />
      </DCArtboard>
      <DCArtboard id="policy" label="Policy editor"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="right-dock" overlay={{
          node: <PolicyEditor />,
        }} />
      </DCArtboard>
    </DCSection>

    <DCSection id="permission"
      title="Permission gates · bulk-case behavior"
      subtitle="Policy-based: a deviation prompt with one-time / session-scope / pattern-add options.">
      <DCArtboard id="permission-single" label="Single op · in-dock"
        width={W_FULL} height={H_FULL}>
        <FullShell
          agentVariant="none"
          editorLines={DESTRUCT_QUERY}
          editorAgent editorDestructive
        >
          <TabBar tabs={[
            { glyph: Icons.bolt, label: 'agent · lead-cleanup.sql', mono: true, dirty: true },
          ]} active={0} agentTab={0} />
          <QueryEditor lines={DESTRUCT_QUERY} agent destructive height={200}
            runLabel="Run · destructive" />
          <ResultsGrid
            meta={{ rows: '~218 estimated', ms: '4',
              query: 'EXPLAIN delete from leads where created_at < now()-…' }}
            rows={[]} />
        </FullShell>
        <div style={{
          position: 'absolute', top: 36, right: 0, width: 380, bottom: 24,
          background: 'var(--bg-panel)',
          borderLeft: '1px solid var(--op-destruct)',
          display: 'flex', flexDirection: 'column',
        }}>
          <div style={{
            height: 32, padding: '0 12px', display: 'flex', alignItems: 'center', gap: 8,
            borderBottom: '1px solid var(--line-soft)',
          }}>
            <span style={{ display: 'inline-flex' }}>{Icons.agentDot}</span>
            <span style={{ fontSize: 12, fontWeight: 500 }}>Agent</span>
            <span className="mono" style={{ fontSize: 10, color: 'var(--op-destruct)' }}>
              · permission required
            </span>
          </div>
          <PermissionCard
            destructive deviation
            agentText={<>Deleting <span className="mono"
              style={{color:'var(--text-primary)'}}>218 expired leads</span> older
              than 90 days, not tied to any patient.</>}
            sql={<>
              <span className="sql-destruct">DELETE</span>{' '}
              <span className="sql-kw">FROM</span> leads<br/>
              <span className="sql-kw">WHERE</span> created_at <span className="sql-op">&lt;</span>{' '}
              <span className="sql-fn">now</span>() <span className="sql-op">-</span>{' '}
              <span className="sql-kw">interval</span> <span className="sql-str">'90 days'</span><br/>
              {'  '}<span className="sql-kw">AND</span> status <span className="sql-op">=</span>{' '}
              <span className="sql-str">'expired'</span>;
            </>}
            est="~218 rows"
          />
        </div>
      </DCArtboard>
      <DCArtboard id="permission-bulk" label="Bulk · 14-statement migration plan"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="none" overlay={{ node: <BulkPermission /> }} />
      </DCArtboard>
    </DCSection>

    {/* ─── Keyboard shortcuts ───────────────────────────────────── */}
    <DCSection id="shortcuts"
      title="Keyboard shortcuts · ?"
      subtitle="Every action reachable without the mouse.">
      <DCArtboard id="shortcuts-overlay" label="Shortcuts overlay"
        width={W_FULL} height={H_FULL}>
        <FullShell agentVariant="right-dock" overlay={{
          node: <ShortcutsOverlay />
        }} />
      </DCArtboard>
    </DCSection>

  </DesignCanvas>
);

// ─── Sub-components used only here ─────────────────────────────────

const SchemaSearchState = () => (
  <div style={{ padding: '8px 0', fontSize: 12 }}>
    <div style={{ padding: '8px 10px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px',
        height: 28, borderRadius: 6,
        background: 'var(--bg-input)',
        border: '1px solid var(--agent-line)',
        boxShadow: 'var(--agent-glow)',
      }}>
        <span style={{ color: 'var(--text-secondary)' }}>{Icons.search}</span>
        <span className="mono" style={{ color: 'var(--text-primary)', flex: 1 }}>
          appoint
        </span>
        <span className="mono" style={{ color: 'var(--text-muted)', fontSize: 10 }}>
          4 matches
        </span>
      </div>
    </div>
    <div style={{ padding: '4px 12px 4px 12px', fontSize: 10, letterSpacing: '0.06em',
      textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600 }}>
      Tables
    </div>
    {[
      ['public', 'appointments', '231,008'],
      ['reporting', 'appointment_metrics', '1,247'],
    ].map(([s, t, r]) => (
      <SearchHit key={t} schema={s} table={t} rows={r} />
    ))}
    <div style={{ padding: '8px 12px 4px 12px', fontSize: 10, letterSpacing: '0.06em',
      textTransform: 'uppercase', color: 'var(--text-muted)', fontWeight: 600 }}>
      Columns
    </div>
    <SearchHit schema="public" table="visits" col="appointment_id" />
    <SearchHit schema="public" table="appointments" col="appointment_type" />
  </div>
);

const SearchHit = ({ schema, table, col, rows }) => (
  <div style={{ padding: '6px 12px 6px 16px', display: 'flex', alignItems: 'center',
    gap: 8, color: 'var(--text-primary)' }}>
    <span style={{ color: col ? 'var(--text-muted)' : 'var(--text-muted)' }}>
      {col ? Icons.column : Icons.table}
    </span>
    <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
      {schema}.
    </span>
    <span className="mono" style={{ fontSize: 11.5 }}>
      {col || (
        <>
          <span style={{ background: 'rgba(212, 145, 90, 0.22)',
            color: 'var(--text-primary)', padding: '0 1px' }}>appoint</span>
          {table.slice(6)}
        </>
      )}
    </span>
    {col && (
      <>
        <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-muted)' }}>
          · {table}
        </span>
      </>
    )}
    <span className="mono" style={{ marginLeft: 'auto', fontSize: 10,
      color: 'var(--text-muted)' }}>{rows}</span>
  </div>
);

const TableDetail = () => (
  <div style={{ display: 'flex', flexDirection: 'column', height: '100%',
    fontSize: 12 }}>
    <div style={{
      padding: '12px 16px', borderBottom: '1px solid var(--line-soft)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--text-muted)' }}>{Icons.table}</span>
        <span className="mono" style={{ fontSize: 14, fontWeight: 500,
          color: 'var(--text-primary)' }}>patients</span>
        <span style={{ width: 5, height: 5, borderRadius: '50%',
          background: 'var(--agent)', boxShadow: '0 0 4px var(--agent)' }} />
        <button style={{...iconBtn, marginLeft: 'auto'}}>{Icons.pin}</button>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
        public · 12,840 rows · ~4.2 MB · 24 columns
      </div>
    </div>
    <div style={{
      padding: '8px 10px', display: 'flex', gap: 4,
      borderBottom: '1px solid var(--line-faint)',
    }}>
      {['Columns', 'Indexes', 'Constraints', 'Triggers', 'Activity'].map((t, i) => (
        <button key={t} style={{
          ...editorBtn, height: 22, padding: '0 8px', border: 0,
          background: i === 0 ? 'var(--bg-elevated)' : 'transparent',
          color: i === 0 ? 'var(--text-primary)' : 'var(--text-muted)',
          fontSize: 11,
        }}>{t}</button>
      ))}
    </div>
    <div style={{ flex: 1, overflow: 'hidden', padding: '4px 0' }}>
      {SCHEMA.connections[1].schemas[0].tables[0].columns.slice(0, 11).map((c, i) => (
        <div key={i} style={{ padding: '6px 16px', display: 'flex',
          alignItems: 'center', gap: 8,
          borderBottom: '1px solid var(--line-faint)' }}>
          <span style={{ color: c.pk ? 'var(--op-write)' : 'var(--text-muted)',
            width: 12, display: 'inline-flex' }}>
            {c.pk ? Icons.key : c.fk ? '↳' : c.idx ? Icons.index : ''}
          </span>
          <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-primary)' }}>
            {c.name}
          </span>
          {c.nullable && <span style={{ fontSize: 9, color: 'var(--text-muted)',
            fontFamily: 'var(--font-mono)' }}>NULL</span>}
          <span className="mono" style={{ marginLeft: 'auto', fontSize: 10.5,
            color: 'var(--text-muted)' }}>{c.type}</span>
        </div>
      ))}
    </div>
    <div style={{
      padding: 12, borderTop: '1px solid var(--line-soft)',
      background: 'var(--agent-wash)',
      position: 'relative',
    }}>
      <AgentEdge />
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
        <span>{Icons.agentDot}</span>
        <span style={{ fontSize: 11, color: 'var(--agent)', fontWeight: 500 }}>
          Agent activity here
        </span>
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 10,
          color: 'var(--text-muted)' }}>4 reads · 14:22</span>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
        Last query: <span className="mono">SELECT … WHERE created_at &gt; now() - '7d'</span>{' '}
        · 1847 rows · 86ms
      </div>
    </div>
  </div>
);

const CellEditOverlay = () => (
  <div style={{ position: 'relative', flex: 1, minHeight: 0,
    background: 'var(--bg-app)' }}>
    <ResultsGrid activeCell={[2, 5]} />
    {/* the editor floating above the cell */}
    <div style={{
      position: 'absolute', top: 122, left: 538, width: 220,
      background: 'var(--bg-elevated)', border: '2px solid var(--agent)',
      borderRadius: 4, boxShadow: '0 8px 24px rgba(0,0,0,0.5)',
      padding: '6px 8px', fontFamily: 'var(--font-mono)', fontSize: 11.5,
      color: 'var(--text-primary)',
    }}>
      +1 510 555 0103
      <span style={{
        display: 'inline-block', width: 1.5, height: 14, background: 'var(--agent)',
        verticalAlign: 'text-bottom', marginLeft: 1,
      }} />
      <div style={{
        position: 'absolute', top: 'calc(100% + 4px)', left: 0,
        display: 'flex', alignItems: 'center', gap: 6, fontSize: 10,
        color: 'var(--text-muted)', fontFamily: 'var(--font-ui)',
        background: 'var(--bg-elevated)', padding: '3px 7px', borderRadius: 4,
        border: '1px solid var(--line-soft)', whiteSpace: 'nowrap',
      }}>
        <span><Kbd>⏎</Kbd> commit</span>
        <span><Kbd>Esc</Kbd> cancel</span>
        <span style={{ color: 'var(--op-write)' }}>· UPDATE patients SET phone_e164 …</span>
      </div>
    </div>
  </div>
);

const BulkPermission = () => (
  <div style={{
    width: 720, background: 'var(--bg-elevated)', borderRadius: 12,
    border: '1px solid var(--op-write)', borderLeftWidth: 3,
    boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
    display: 'flex', flexDirection: 'column', maxHeight: 640,
  }}>
    <div style={{ padding: '16px 20px 12px',
      borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <OpGlyph kind="ddl" size={14} />
        <span style={{ fontSize: 10.5, letterSpacing: '0.08em', fontWeight: 600,
          color: 'var(--op-ddl)', fontFamily: 'var(--font-mono)' }}>
          MIGRATION · 14 STATEMENTS · 3 TABLES
        </span>
        <span className="mono" style={{ marginLeft: 'auto', fontSize: 10,
          color: 'var(--text-muted)' }}>est. impact ~8,400 rows</span>
      </div>
      <h2 className="serif" style={{ margin: '8px 0 4px', fontSize: 18,
        fontWeight: 500, color: 'var(--text-primary)' }}>
        Backfill lead_sources with provider attribution
      </h2>
      <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.55 }}>
        I want to add a <span className="mono">source_provider_id</span> column
        to <span className="mono">leads</span>, backfill it from{' '}
        <span className="mono">visits</span>, then create an index. Three steps
        cross the policy boundary and need your sign-off.
      </div>
    </div>

    {/* statement list */}
    <div style={{ flex: 1, overflow: 'hidden' }}>
      {[
        { i: 1,  kind: 'ddl',      ok: true,  s: 'ALTER TABLE leads ADD COLUMN source_provider_id uuid' },
        { i: 2,  kind: 'ddl',      ok: true,  s: 'ALTER TABLE leads ADD CONSTRAINT fk_source_provider …' },
        { i: 3,  kind: 'read',     ok: true,  s: 'SELECT count(*) FROM visits v JOIN leads l ON l.phone_e164 = …' },
        { i: 4,  kind: 'write',    ok: true,  s: 'UPDATE leads SET source_provider_id = … FROM visits WHERE …', meta: '~8,231 rows' },
        { i: 5,  kind: 'write',    ok: false, s: 'UPDATE audit.change_log SET note = \'backfill\' WHERE …', meta: 'writes to audit.* — outside policy' },
        { i: 6,  kind: 'ddl',      ok: true,  s: 'CREATE INDEX idx_leads_source_provider ON leads(source_provider_id)' },
        { i: 7,  kind: 'destruct', ok: false, s: 'DELETE FROM leads WHERE source_provider_id IS NULL AND created_at < …', meta: '~172 rows — DELETE without row-cap' },
      ].map(row => (
        <div key={row.i} style={{
          padding: '10px 20px', display: 'flex', alignItems: 'flex-start', gap: 10,
          borderBottom: '1px solid var(--line-faint)',
          background: row.ok ? 'transparent' : 'rgba(217, 108, 84, 0.06)',
        }}>
          <span className="mono" style={{ fontSize: 10, color: 'var(--text-muted)',
            width: 18, paddingTop: 2 }}>
            {String(row.i).padStart(2, '0')}
          </span>
          <div style={{ paddingTop: 1 }}>
            <OpGlyph kind={row.kind} size={10} />
          </div>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="mono" style={{ fontSize: 11.5, color: 'var(--text-primary)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {row.s}
            </div>
            {row.meta && (
              <div style={{ fontSize: 10.5, color: row.ok ? 'var(--text-muted)' : 'var(--op-destruct)',
                marginTop: 2 }}>
                {row.meta}
              </div>
            )}
          </div>
          {row.ok ? (
            <span className="mono" style={{ fontSize: 10, padding: '2px 7px',
              background: 'rgba(127, 168, 134, 0.14)', color: 'var(--op-read)',
              borderRadius: 3, fontWeight: 600, letterSpacing: '0.05em' }}>
              ALLOW
            </span>
          ) : (
            <span className="mono" style={{ fontSize: 10, padding: '2px 7px',
              background: 'var(--op-destruct-soft)', color: 'var(--op-destruct)',
              borderRadius: 3, fontWeight: 600, letterSpacing: '0.05em' }}>
              PROMPT
            </span>
          )}
        </div>
      ))}
    </div>

    <div style={{ padding: '12px 20px 16px', borderTop: '1px solid var(--line-soft)' }}>
      <div style={{ fontSize: 11.5, color: 'var(--text-secondary)', marginBottom: 10,
        display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ color: 'var(--op-destruct)' }}>{Icons.warn}</span>
        <span>
          <b>2 statements</b> deviate from policy. The agent will pause and ask
          again before each one.
        </span>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button style={{
          flex: 1, height: 34, borderRadius: 6, border: 0,
          background: 'var(--op-write)', color: '#1a1714',
          fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 500,
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
        }}>
          Approve 5 of 7, prompt for the rest
          <Kbd>⏎</Kbd>
        </button>
        <button style={{
          height: 34, padding: '0 16px', borderRadius: 6,
          background: 'var(--bg-elevated-2)', color: 'var(--text-primary)',
          border: '1px solid var(--line-default)',
          fontFamily: 'var(--font-ui)', fontSize: 13, fontWeight: 500,
        }}>Reject all</button>
      </div>
      <div style={{ marginTop: 10, fontSize: 10.5, color: 'var(--text-muted)',
        display: 'flex', alignItems: 'center', gap: 6 }}>
        <input type="checkbox" style={{ accentColor: 'var(--agent)' }} />
        <span>Wrap entire migration in a transaction · roll back on any denial</span>
      </div>
    </div>
  </div>
);

Object.assign(window, { App, SchemaSearchState, SearchHit, TableDetail,
  CellEditOverlay, BulkPermission });
