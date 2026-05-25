import { Modal } from "./Modal";

type Shortcut = { keys: string[]; label: string };
type Section = { title: string; tone?: "agent"; items: Shortcut[] };

const SECTIONS: Section[] = [
  {
    title: "Navigation",
    items: [
      { keys: ["⌘", "K"], label: "Command palette" },
      { keys: ["⌘", "P"], label: "Quick open table" },
      { keys: ["⌘", "⇧", "P"], label: "Quick open column" },
      { keys: ["⌘", "1–9"], label: "Jump to tab" },
      { keys: ["⌘", "\\"], label: "Toggle agent drawer" },
      { keys: ["⌘", "B"], label: "Toggle schema rail" },
      { keys: ["⌘", "⇧", "J"], label: "Toggle JSON viewer" },
    ],
  },
  {
    title: "Editing",
    items: [
      { keys: ["⌘", "↵"], label: "Run query / selection" },
      { keys: ["⌘", "⇧", "↵"], label: "Run all queries in tab" },
      { keys: ["⌥", "⇧", "F"], label: "Format SQL" },
      { keys: ["⌘", "/"], label: "Toggle comment" },
      { keys: ["⌘", "D"], label: "Add cursor at next match" },
      { keys: ["F2"], label: "Rename symbol" },
    ],
  },
  {
    title: "Agent",
    tone: "agent",
    items: [
      { keys: ["⌘", "⇧", "A"], label: "Nudge / ask agent" },
      { keys: ["⌘", "."], label: "Pause agent" },
      { keys: ["↵"], label: "Approve pending" },
      { keys: ["Esc"], label: "Deny pending" },
      { keys: ["⌘", "⇧", "."], label: "Open policy editor" },
      { keys: ["⌘", "⇧", "H"], label: "Open session timeline" },
    ],
  },
  {
    title: "Results",
    items: [
      { keys: ["⌘", "F"], label: "Filter result set" },
      { keys: ["⌘", "E"], label: "Export…" },
      { keys: ["⌘", "C"], label: "Copy cell" },
      { keys: ["⌘", "⇧", "C"], label: "Copy as JSON" },
      { keys: ["↵"], label: "Edit cell" },
      { keys: ["⌘", "Z"], label: "Undo cell edit" },
    ],
  },
];

/// Keyboard shortcuts overlay per design/screenshots/31. Opens via `?` and
/// Esc. The list is the canonical reference for the design's shortcuts —
/// note that a few entries (Format SQL, Quick open table/column, session
/// timeline) describe planned behavior that isn't shipped yet; they're
/// listed for discoverability so the design intent is clear.
export function ShortcutsOverlay({ onClose }: { onClose: () => void }) {
  return (
    <Modal
      onClose={onClose}
      className="modal"
      style={{
        width: 720,
        maxHeight: "82vh",
        padding: "16px 18px 18px",
        display: "flex",
        flexDirection: "column",
        gap: 14,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <div className="serif" style={{ fontSize: 18, color: "var(--text-primary)" }}>
          Keyboard shortcuts
        </div>
        <span
          className="mono"
          style={{ color: "var(--text-muted)", fontSize: 11 }}
        >
          macOS
        </span>
        <div style={{ flex: 1 }} />
        <button
          onClick={onClose}
          aria-label="Close"
          style={{
            background: "transparent",
            border: 0,
            color: "var(--text-muted)",
            cursor: "pointer",
            fontFamily: "var(--font-mono)",
            fontSize: 12,
          }}
        >
          ✕
        </button>
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          columnGap: 20,
          rowGap: 16,
          overflowY: "auto",
        }}
      >
        {SECTIONS.map((s) => (
          <ShortcutSection key={s.title} section={s} />
        ))}
      </div>
    </Modal>
  );
}

function ShortcutSection({ section }: { section: Section }) {
  const titleColor =
    section.tone === "agent" ? "var(--agent)" : "var(--text-secondary)";
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          color: titleColor,
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: 0.6,
          textTransform: "uppercase",
        }}
      >
        {section.tone === "agent" && (
          <span aria-hidden style={{ color: "var(--agent)" }}>
            ◆
          </span>
        )}
        {section.title}
      </div>
      {section.items.map((s) => (
        <ShortcutRow key={s.label} shortcut={s} />
      ))}
    </div>
  );
}

function ShortcutRow({ shortcut }: { shortcut: Shortcut }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        fontSize: 12,
        color: "var(--text-primary)",
      }}
    >
      <span style={{ flex: 1 }}>{shortcut.label}</span>
      <div style={{ display: "inline-flex", gap: 2 }}>
        {shortcut.keys.map((k, i) => (
          <kbd key={i} className="kbd">
            {k}
          </kbd>
        ))}
      </div>
    </div>
  );
}
