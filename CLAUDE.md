# CLAUDE.md

Behavioral guidelines to reduce common LLM coding mistakes.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 5. Design Source of Truth

**`./design/`** is the design spec. Always consult it before building or restyling UI.

- **`design/screenshots/`** — 31 PNG artboards covering every surface and state. Numbered:
  - `03–07` shell, `08–12` schema tree, `13–16` query editor + results,
  - `17–18` dock, `19–23` agent drawer / inline, `24–25` palettes,
  - `26–28` connections & policy, `29–30` permissions, `31` shortcuts.
- **`design/styles/tokens.css`** — color/type/radius tokens. Mirrored at `src/styles/tokens.css`. Keep them in sync.
- **`design/components/`** — JSX prototypes (`surfaces.jsx`, `app-shell.jsx`, `overlays.jsx`, etc.). Reference implementations, not for direct import — recreate in our own components.
- **`design/README.md`** — full handoff doc: rationale, motion specs, accessibility notes.

When asked to implement or change a UI surface, read the relevant screenshot + the matching JSX prototype first.

## 6. Toolchain Quirks

- Homebrew `cargo` is broken on this machine. Use `$HOME/.cargo/bin/cargo` for any Rust build.
- In Tauri 2 main-thread/setup code, use `tauri::async_runtime::spawn` — not `tokio::spawn`.
- The Tauri 2 webview silently suppresses `alert/confirm/prompt`. Use inline UI or `@tauri-apps/plugin-dialog`.

## 7. Validate Before Done

**For any change that touches runtime behavior, drive the running app via
`tauri-pilot` before claiming the task complete.**

`cargo check` and type checks prove the code compiles. They do not prove
the feature works. Run the app, then:

```
tauri-pilot ping              # confirm connectivity
tauri-pilot snapshot -i       # see what's actually on screen
tauri-pilot screenshot <path> # visual confirmation
```

Drive the golden path and at least one edge case. If you cannot reach
the code path through the UI, say so explicitly — do not claim success
from a green build alone.

Skip when changes are docs-only, gitignore, build config, or Rust-only
refactors with no UI surface.

See `.claude/skills/tauri-pilot/SKILL.md` for the full command reference.
