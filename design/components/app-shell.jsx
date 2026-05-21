/* Full app shell composer. Variants drive the layout. */

const FullShell = ({
  width = 1440, height = 900,
  // chrome
  windowTitle = 'lassomd-staging · public',
  windowSubtitle = null,
  // schema rail
  showRail = true,
  railVariant = 'default',      // 'default' | 'annotated' | 'searching' | 'empty'
  // tabs
  tabs = DEFAULT_TABS,
  activeTab = 0,
  agentTab = null,
  // editor & grid
  showEditor = true,
  editorLines = DEFAULT_QUERY,
  editorAgent = false,
  editorDestructive = false,
  showGrid = true,
  jsonOpen = false,
  activeCell = null,
  resultRows = PATIENT_ROWS,
  // agent surface variant
  agentVariant = 'right-dock',  // 'right-dock' | 'bottom-strip' | 'bottom-drawer' | 'inline' | 'none'
  awaitingApproval = false,
  // overlay
  overlay = null,
  // status
  agentActive = true,
  queued = null,
  // override children (replaces editor+grid)
  children,
  // empty state
  empty = false,
}) => {
  const railWidth = railVariant === 'empty' ? 240 : 260;
  return (
    <div className="app-root" style={{
      width, height, overflow: 'hidden', position: 'relative',
      display: 'flex', flexDirection: 'column',
      borderRadius: 12,
      boxShadow: 'var(--shadow-window)',
    }}>
      <WindowChrome
        title={windowTitle}
        subtitle={windowSubtitle}
        agentActive={agentActive}
        right={
          <>
            <button style={iconBtn}>{Icons.search}</button>
            <button style={iconBtn}>{Icons.shield}</button>
            <div style={{ width: 1, height: 14, background: 'var(--line-default)' }} />
            <AgentBadge size="sm" pulse={agentActive} />
          </>
        }
      />

      {/* main body */}
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        {showRail && agentVariant !== 'inline' && (
          <div style={{
            width: railWidth, flex: '0 0 auto',
            background: 'var(--bg-panel)',
            borderRight: '1px solid var(--line-default)',
            overflow: 'hidden',
          }}>
            <SchemaTree
              annotated={railVariant === 'annotated'}
              showAgentTouched
            />
          </div>
        )}
        {agentVariant === 'inline' && <AgentRail />}
        {agentVariant === 'inline' && showRail && (
          <div style={{
            width: 244, flex: '0 0 auto',
            background: 'var(--bg-panel)',
            borderRight: '1px solid var(--line-default)',
            overflow: 'hidden',
          }}>
            <SchemaTree annotated />
          </div>
        )}

        {/* workspace column */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex',
          flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
          {empty ? (
            <EmptyWorkspace />
          ) : (
            <>
              <TabBar tabs={tabs} active={activeTab} agentTab={agentTab} />
              {children ? children : (
                <>
                  {showEditor && (
                    <QueryEditor
                      lines={editorLines}
                      destructive={editorDestructive}
                      agent={editorAgent}
                      runLabel={editorDestructive ? 'Run · destructive' : 'Run'}
                      height={showGrid ? 200 : undefined}
                    />
                  )}
                  {showGrid && (
                    <ResultsGrid
                      jsonOpen={jsonOpen}
                      activeCell={activeCell}
                      rows={resultRows}
                    />
                  )}
                </>
              )}
            </>
          )}

          {/* inline agent annotations overlay (variant C) */}
          {agentVariant === 'inline' && !empty && (
            <>
              <AgentInlineMarker style={{ top: 110, left: 240 }}>
                <span className="mono" style={{ color: 'var(--text-primary)' }}>agent</span>
                <span>is reading this</span>
                <span className="mono" style={{ color: 'var(--text-muted)' }}>· 2s ago</span>
              </AgentInlineMarker>
              <AgentInlineMarker style={{ bottom: 64, right: 28 }}>
                <span style={{ color: 'var(--op-destruct)', display: 'inline-flex' }}>
                  <OpGlyph kind="destruct" size={8}/>
                </span>
                <span style={{ color: 'var(--op-destruct)', fontWeight: 500 }}>
                  awaiting approval
                </span>
                <span>·</span>
                <span className="mono" style={{ color: 'var(--text-primary)' }}>
                  DELETE on leads
                </span>
                <span style={{ color: 'var(--agent)', fontWeight: 500, marginLeft: 4 }}>
                  Review →
                </span>
              </AgentInlineMarker>
            </>
          )}
        </div>

        {/* right dock variant */}
        {agentVariant === 'right-dock' && (
          <AgentDockRight />
        )}
      </div>

      {/* bottom agent surfaces */}
      {agentVariant === 'bottom-strip'  && <AgentStripBottom awaiting={awaitingApproval} />}
      {agentVariant === 'bottom-drawer' && <AgentDrawerBottom />}

      <StatusBar agentActive={agentActive} queued={queued} />

      {/* modal overlay */}
      {overlay && (
        <div style={{
          position: 'absolute', inset: 0, background: 'var(--bg-overlay)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(2px)',
          paddingTop: overlay.top || 0,
        }}>
          {overlay.node}
        </div>
      )}
    </div>
  );
};

// ── Empty / first-run workspace ───────────────────────────────────
const EmptyWorkspace = () => (
  <div style={{ flex: 1, display: 'flex', flexDirection: 'column',
    alignItems: 'center', justifyContent: 'center', padding: 32 }}>
    <div style={{ maxWidth: 480, textAlign: 'center' }}>
      <div style={{
        width: 64, height: 64, margin: '0 auto 20px',
        borderRadius: 16, background: 'var(--agent-wash)',
        border: '1px solid var(--agent-line)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <svg width="32" height="32" viewBox="0 0 14 14">
          <polygon points="7 1.5 12 4.25 12 9.75 7 12.5 2 9.75 2 4.25"
            fill="var(--agent)" />
        </svg>
      </div>
      <h1 className="serif" style={{
        fontSize: 26, fontWeight: 500, margin: '0 0 8px',
        color: 'var(--text-primary)', letterSpacing: '-0.015em',
      }}>
        A workbench you watch from
      </h1>
      <p style={{ fontSize: 13, color: 'var(--text-secondary)',
        lineHeight: 1.6, margin: '0 0 28px' }}>
        Connect a Postgres database, then point your coding agent at it.
        You'll see every query it runs, every row it reads, and gate any
        write before it touches the database.
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8,
        alignItems: 'stretch', maxWidth: 360, margin: '0 auto' }}>
        <button style={{
          height: 36, padding: '0 16px', borderRadius: 7, border: 0,
          background: 'var(--text-primary)', color: 'var(--bg-app)',
          fontSize: 13, fontWeight: 500, fontFamily: 'var(--font-ui)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        }}>
          {Icons.plus} Connect a database
          <Kbd>⌘N</Kbd>
        </button>
        <button style={{
          height: 36, padding: '0 16px', borderRadius: 7,
          background: 'var(--bg-elevated)', color: 'var(--text-primary)',
          border: '1px solid var(--line-default)',
          fontSize: 13, fontWeight: 500, fontFamily: 'var(--font-ui)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
        }}>
          {Icons.database} Restore a session
        </button>
      </div>
      <div style={{ marginTop: 28, fontSize: 11.5, color: 'var(--text-muted)',
        display: 'flex', justifyContent: 'center', gap: 18 }}>
        <span><Kbd>⌘K</Kbd> open palette</span>
        <span><Kbd>?</Kbd> shortcuts</span>
      </div>
    </div>
  </div>
);

// ── Default content used by FullShell ─────────────────────────────
const DEFAULT_TABS = [
  { glyph: Icons.table, label: 'patients',            mono: true },
  { glyph: Icons.table, label: 'appointments',        mono: true },
  { glyph: Icons.bolt,  label: 'recent ten · scratch.sql', dirty: true },
];

const DEFAULT_QUERY = [
  `<span class="sql-cmt">-- recent patients with upcoming appointments</span>`,
  `<span class="sql-kw">select</span> p.<span class="sql-id">mrn</span>, p.<span class="sql-id">last_name</span>, p.<span class="sql-id">first_name</span>, <span class="sql-fn">count</span>(a.<span class="sql-id">id</span>) <span class="sql-kw">as</span> upcoming`,
  `<span class="sql-kw">from</span> <span class="sql-id">patients</span> p`,
  `<span class="sql-kw">join</span> <span class="sql-id">appointments</span> a <span class="sql-kw">on</span> a.<span class="sql-id">patient_id</span> <span class="sql-op">=</span> p.<span class="sql-id">id</span>`,
  `<span class="sql-kw">where</span> a.<span class="sql-id">starts_at</span> <span class="sql-op">&gt;=</span> <span class="sql-fn">now</span>() <span class="sql-op">+</span> <span class="sql-kw">interval</span> <span class="sql-str">'1 day'</span>`,
  `  <span class="sql-kw">and</span> p.<span class="sql-id">deleted_at</span> <span class="sql-kw">is</span> <span class="sql-kw">null</span>`,
  `<span class="sql-kw">group</span> <span class="sql-kw">by</span> p.<span class="sql-id">id</span>`,
  `<span class="sql-kw">order</span> <span class="sql-kw">by</span> upcoming <span class="sql-kw">desc</span>`,
  `<span class="sql-kw">limit</span> <span class="sql-num">200</span>;`,
];

const AGENT_QUERY = [
  `<span class="sql-cmt">-- agent · finding leads expired ≥ 90d still tied to active appointments</span>`,
  `<span class="sql-kw">select</span> l.<span class="sql-id">id</span>, l.<span class="sql-id">phone_e164</span>, l.<span class="sql-id">created_at</span>`,
  `<span class="sql-kw">from</span> <span class="sql-id">leads</span> l`,
  `<span class="sql-kw">left</span> <span class="sql-kw">join</span> <span class="sql-id">patients</span> p <span class="sql-kw">on</span> p.<span class="sql-id">phone_e164</span> <span class="sql-op">=</span> l.<span class="sql-id">phone_e164</span>`,
  `<span class="sql-kw">left</span> <span class="sql-kw">join</span> <span class="sql-id">appointments</span> a <span class="sql-kw">on</span> a.<span class="sql-id">patient_id</span> <span class="sql-op">=</span> p.<span class="sql-id">id</span>`,
  `<span class="sql-kw">where</span> l.<span class="sql-id">status</span> <span class="sql-op">=</span> <span class="sql-str">'expired'</span>`,
  `  <span class="sql-kw">and</span> l.<span class="sql-id">created_at</span> <span class="sql-op">&lt;</span> <span class="sql-fn">now</span>() <span class="sql-op">-</span> <span class="sql-kw">interval</span> <span class="sql-str">'90 days'</span>`,
  `  <span class="sql-kw">and</span> a.<span class="sql-id">starts_at</span> <span class="sql-op">&gt;</span> <span class="sql-fn">now</span>();`,
];

const DESTRUCT_QUERY = [
  `<span class="sql-cmt">-- agent · written but not yet executed</span>`,
  `<span class="sql-destruct">delete</span> <span class="sql-kw">from</span> <span class="sql-id">leads</span>`,
  `<span class="sql-kw">where</span> <span class="sql-id">created_at</span> <span class="sql-op">&lt;</span> <span class="sql-fn">now</span>() <span class="sql-op">-</span> <span class="sql-kw">interval</span> <span class="sql-str">'90 days'</span>`,
  `  <span class="sql-kw">and</span> <span class="sql-id">status</span> <span class="sql-op">=</span> <span class="sql-str">'expired'</span>;`,
];

Object.assign(window, { FullShell, EmptyWorkspace,
  DEFAULT_TABS, DEFAULT_QUERY, AGENT_QUERY, DESTRUCT_QUERY });
