# Database App — agent notes

Tauri 2 + React + Rust Postgres workbench. The app is also an MCP server agents connect to.

## Design source of truth

**`./design/`** is the design spec. Always consult it before building or restyling UI.

- **`design/screenshots/`** — 31 PNG artboards covering every surface and state. Numbered:
  - `03–07` shell, `08–12` schema tree, `13–16` query editor + results,
  - `17–18` dock, `19–23` agent drawer / inline, `24–25` palettes,
  - `26–28` connections & policy, `29–30` permissions, `31` shortcuts.
- **`design/styles/tokens.css`** — color/type/radius tokens. Mirrored at `src/styles/tokens.css`. Keep them in sync.
- **`design/components/`** — JSX prototypes (`surfaces.jsx`, `app-shell.jsx`, `overlays.jsx`, etc.). Reference implementations, not for direct import — recreate in our own components.
- **`design/README.md`** — full handoff doc: rationale, motion specs, accessibility notes.

When asked to implement or change a UI surface, read the relevant screenshot + the matching JSX prototype first.

## Toolchain quirks

- Homebrew `cargo` is broken on this machine. Use `$HOME/.cargo/bin/cargo` for any Rust build.
- In Tauri 2 main-thread/setup code, use `tauri::async_runtime::spawn` — not `tokio::spawn`.
- The Tauri 2 webview silently suppresses `alert/confirm/prompt`. Use inline UI or `@tauri-apps/plugin-dialog`.
