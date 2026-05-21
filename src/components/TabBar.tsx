import type { Tab } from "../lib/useTabs";

type Props = {
  tabs: Tab[];
  activeId: string | null;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onAdd: () => void;
};

export function TabBar({ tabs, activeId, onSelect, onClose, onAdd }: Props) {
  return (
    <div className="tabbar-strip" role="tablist">
      {tabs.map((tab) => {
        const isActive = tab.id === activeId;
        const cls = [
          "tab",
          isActive ? "active" : "",
          tab.agentAuthored ? "agent" : "",
          tab.source === "table" ? "tab-mono" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div
            key={tab.id}
            className={cls}
            role="tab"
            aria-selected={isActive}
            onClick={() => onSelect(tab.id)}
            onMouseDown={(e) => {
              // Middle click closes (common pattern)
              if (e.button === 1) {
                e.preventDefault();
                onClose(tab.id);
              }
            }}
            title={tab.title}
          >
            <span className="tab-glyph">{tab.source === "table" ? "▦" : "≡"}</span>
            <span className="tab-label">{tab.title}</span>
            {tab.dirty && <span className="tab-dirty" aria-label="unsaved" />}
            <button
              className="tab-close"
              aria-label={`Close ${tab.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(tab.id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button className="tab-add" aria-label="New query" onClick={onAdd}>
        +
      </button>
    </div>
  );
}
