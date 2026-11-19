import { useEffect, useMemo, useRef } from "react";
import CodeMirror, {
  EditorView,
  keymap,
  type ReactCodeMirrorProps,
  type ReactCodeMirrorRef,
} from "@uiw/react-codemirror";
import { PostgreSQL, keywordCompletionSource, schemaCompletionSource } from "@codemirror/lang-sql";
import { HighlightStyle, LanguageSupport, syntaxHighlighting } from "@codemirror/language";
import { undo, redo } from "@codemirror/commands";
import {
  Compartment,
  Prec,
  RangeSetBuilder,
  StateEffect,
  StateField,
  type EditorState,
} from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import {
  acceptCompletion,
  autocompletion,
  startCompletion,
  type Completion,
  type CompletionContext,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { tags as t } from "@lezer/highlight";
import type { IntellisenseSchema } from "../lib/useIntellisense";
import { splitStatements, statementAt, type Stmt } from "../lib/sqlStatements";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onRun?: () => void;
  /** ⌘⇧↵ — run every statement in the tab. */
  onRunAll?: () => void;
  /** The statement the last run failed on, marked until the next run. */
  errorRange?: { from: number; to: number } | null;
  /** ⌘S — write-through for library tabs, else opens the save sheet. */
  onSave?: () => void;
  /** ⌘⇧S — always opens the save sheet as a fresh entry. */
  onSaveAs?: () => void;
  readOnly?: boolean;
  height?: string | number;
  /** SQLNamespace-shaped schema; updates reconfigure the editor in place. */
  schema?: IntellisenseSchema;
  /** Set so unqualified tables (e.g. `users`) complete at the top level. */
  defaultSchema?: string;
  /** Called with (schema, table) when the user types `<ident>.` — lets the
   *  parent kick off a describe_table fetch so column completion can fill in. */
  onEnsureColumns?: (schema: string, table: string) => void;
  /** User-managed snippet completions. Reference-stable from useSnippets. */
  snippets?: readonly Completion[];
  /** Imperatively focus + reveal the editor (used by save-as-snippet flow). */
  registerHandle?: (api: SqlEditorHandle | null) => void;
};

export type SqlEditorHandle = {
  /** Returns the currently selected text, or an empty string when none. */
  getSelection: () => string;
  getSelectionRange: () => { from: number; to: number };
  getText: () => string;
  getCursor: () => number;
  /** Put the cursor at `pos`, scroll it into view, and focus. */
  reveal: (pos: number) => void;
  focus: () => void;
};

/* Syntax colors mirror design/styles/tokens.css `.sql-*` rules. */
const highlight = HighlightStyle.define([
  { tag: t.keyword, color: "#c98a72", fontWeight: "500" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#d4a155" },
  { tag: t.string, color: "#9ab38a" },
  { tag: [t.number, t.bool, t.null], color: "#b591c4" },
  { tag: t.variableName, color: "#c4b89c" },
  { tag: t.propertyName, color: "#c4b89c" },
  { tag: t.comment, color: "#6e6759", fontStyle: "italic" },
  { tag: t.operator, color: "#a89f8f" },
  { tag: t.punctuation, color: "#a89f8f" },
  { tag: t.typeName, color: "#b591c4" },
]);

const theme = EditorView.theme(
  {
    "&": {
      backgroundColor: "var(--bg-input)",
      color: "var(--text-primary)",
      fontFamily: "var(--font-mono)",
      fontSize: "12.5px",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily: "var(--font-mono)",
      lineHeight: "1.65",
      overflow: "auto",
    },
    ".cm-content": { padding: "10px 0", caretColor: "var(--text-primary)" },
    ".cm-gutters": {
      backgroundColor: "var(--bg-input)",
      color: "var(--text-faint)",
      border: "none",
      paddingRight: "4px",
    },
    ".cm-lineNumbers .cm-gutterElement": { padding: "0 8px 0 12px", minWidth: "28px" },
    ".cm-activeLine": { backgroundColor: "transparent" },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text-muted)" },
    "&.cm-focused": { outline: "none" },
    "&.cm-focused .cm-selectionBackground, ::selection": {
      backgroundColor: "rgba(212, 145, 90, 0.18)",
    },
    ".cm-cursor": { borderLeftColor: "var(--text-primary)" },
    // The statement ⌘↵ will run, and the one the last run failed on.
    ".cm-line.cm-stmt-current": {
      boxShadow: "inset 2px 0 0 var(--line-strong)",
      backgroundColor: "rgba(255, 240, 220, 0.018)",
    },
    ".cm-line.cm-stmt-error": {
      boxShadow: "inset 2px 0 0 var(--op-destruct)",
      backgroundColor: "rgba(217, 108, 84, 0.07)",
    },
    // Completion popup — match the dark workbench surface.
    ".cm-tooltip.cm-tooltip-autocomplete": {
      backgroundColor: "var(--bg-panel, #1f1c18)",
      border: "1px solid var(--border-subtle, rgba(255,255,255,0.08))",
      borderRadius: "6px",
      boxShadow: "0 8px 24px rgba(0,0,0,0.4)",
      fontFamily: "var(--font-mono)",
      fontSize: "12px",
    },
    ".cm-tooltip-autocomplete ul li": { padding: "3px 8px" },
    ".cm-tooltip-autocomplete ul li[aria-selected]": {
      backgroundColor: "rgba(212, 145, 90, 0.18)",
      color: "var(--text-primary)",
    },
    ".cm-completionLabel": { color: "var(--text-primary)" },
    ".cm-completionDetail": {
      color: "var(--text-muted)",
      fontStyle: "normal",
      marginLeft: "8px",
      fontSize: "11px",
    },
    ".cm-completionIcon": { opacity: 0.7, marginRight: "4px" },
  },
  { dark: true },
);

// Snippet completion source — list is supplied by the parent (useSnippets).
// Suppresses snippets in `<ident>.` contexts (those are column-completion
// territory; a snippet list there is just noise).
function makeSnippetSource(options: readonly Completion[]): CompletionSource {
  return (context: CompletionContext) => {
    if (options.length === 0) return null;
    const before = context.matchBefore(/[\w".]+/);
    if (before && /\.[\w"]*$/.test(before.text)) return null;
    const word = context.matchBefore(/\w+/);
    if (!word && !context.explicit) return null;
    if (word && word.from === word.to && !context.explicit) return null;
    return {
      from: word ? word.from : context.pos,
      options,
      validFor: /^\w*$/,
    };
  };
}

// Match `<schema>.<table>.` or `<table>.` immediately before the cursor when
// the user just typed a dot. Used to kick off lazy column fetches.
const DOT_TRIGGER_RE = /(?:([a-zA-Z_][\w]*)\.)?([a-zA-Z_][\w]*)\.$/;

// Sweep the editor's doc for `from <table> <alias>` / `join … <alias>` shapes
// so we can resolve `u.` → `users` and prefetch the right table's columns.
// The optional alias capture would happily swallow keywords like `where` if
// unfiltered, so we post-filter against a small reserved-word set.
const ALIAS_RE =
  /\b(?:from|join)\s+(?:only\s+)?(?:"([^"]+)"|([a-z_][\w]*))(?:\s*\.\s*(?:"([^"]+)"|([a-z_][\w]*)))?(?:\s+(?:as\s+)?(?:"([^"]+)"|([a-z_][\w]*)))?/gi;

const ALIAS_RESERVED = new Set([
  "where", "on", "using", "left", "right", "inner", "outer", "full", "cross",
  "join", "group", "order", "limit", "having", "as", "into", "union", "select",
  "intersect", "except", "returning", "for", "with", "when", "then", "else",
  "end", "and", "or", "not", "is", "null", "lateral", "fetch", "offset",
  "window", "all", "distinct", "from", "set", "values", "natural",
]);

type AliasTarget = { schema: string; table: string };

function parseAliases(sql: string): Map<string, AliasTarget> {
  const map = new Map<string, AliasTarget>();
  for (const m of sql.matchAll(ALIAS_RE)) {
    const first = m[1] ?? m[2];
    const second = m[3] ?? m[4];
    const alias = (m[5] ?? m[6])?.toLowerCase();
    if (!first || !alias) continue;
    if (ALIAS_RESERVED.has(alias)) continue;
    map.set(alias, second ? { schema: first, table: second } : { schema: "", table: first });
  }
  return map;
}

const EMPTY_SNIPPETS: readonly Completion[] = [];

const currentLine = Decoration.line({ class: "cm-stmt-current" });
const errorLine = Decoration.line({ class: "cm-stmt-error" });

/** A line decoration on every line from `from` to `to`. */
function markLines(state: EditorState, from: number, to: number, deco: Decoration): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const end = Math.min(to, state.doc.length);
  for (let pos = Math.min(from, end); pos <= end; ) {
    const line = state.doc.lineAt(pos);
    b.add(line.from, line.from, deco);
    pos = line.to + 1;
  }
  return b.finish();
}

/** Marks the statement ⌘↵ will run when the tab holds several — not for a
 *  lone statement, nor while a selection overrides it. */
const currentStatement = ViewPlugin.fromClass(
  class {
    text: string;
    stmts: Stmt[];
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.text = view.state.doc.toString();
      this.stmts = splitStatements(this.text);
      this.decorations = this.build(view.state);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) {
        this.text = u.state.doc.toString();
        this.stmts = splitStatements(this.text);
      }
      if (u.docChanged || u.selectionSet) this.decorations = this.build(u.state);
    }
    build(state: EditorState): DecorationSet {
      const sel = state.selection.main;
      if (!sel.empty || this.stmts.length < 2) return Decoration.none;
      const s = statementAt(this.text, this.stmts, sel.head);
      return s ? markLines(state, s.from, s.to, currentLine) : Decoration.none;
    }
  },
  { decorations: (v) => v.decorations },
);

const setErrorRange = StateEffect.define<{ from: number; to: number } | null>();

/** The failed statement's mark; follows edits until the next run replaces it. */
const errorStatement = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setErrorRange)) {
        deco = e.value ? markLines(tr.state, e.value.from, e.value.to, errorLine) : Decoration.none;
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

export function SqlEditor({
  value,
  onChange,
  onRun,
  onRunAll,
  errorRange,
  onSave,
  onSaveAs,
  readOnly,
  height,
  schema,
  defaultSchema,
  onEnsureColumns,
  snippets,
  registerHandle,
}: Props) {
  const ref = useRef<ReactCodeMirrorRef | null>(null);
  // One compartment per editor instance — lets us swap the sql() extension
  // (and therefore the schema-driven completion source) without rebuilding
  // the editor or losing undo history / selection.
  const sqlCompartment = useMemo(() => new Compartment(), []);
  // Separate compartment for the snippets source so we can reconfigure it
  // when the user adds / edits snippets without disturbing schema state.
  const snippetCompartment = useMemo(() => new Compartment(), []);

  // Custom LanguageSupport so the keyword source can be scoped away from
  // property-access contexts. `sql()` always merges keywords with schema
  // results, which produces noisy popups when typing `users.cre` and seeing
  // SQL `create` next to the `created_at` column.
  const buildSqlExtension = (s?: IntellisenseSchema, ds?: string) => {
    const baseKeywords = keywordCompletionSource(PostgreSQL, false);
    const scopedKeywords: CompletionSource = (ctx) => {
      // In `<ident>.<...>` property contexts, suppress keywords entirely.
      if (ctx.matchBefore(/\.\w*$/)) return null;
      return baseKeywords(ctx);
    };
    const schemaSrc = schemaCompletionSource({
      dialect: PostgreSQL,
      ...(s && Object.keys(s).length > 0 ? { schema: s } : {}),
      ...(ds ? { defaultSchema: ds } : {}),
    });
    return new LanguageSupport(PostgreSQL.language, [
      PostgreSQL.language.data.of({ autocomplete: schemaSrc }),
      PostgreSQL.language.data.of({ autocomplete: scopedKeywords }),
    ]);
  };

  const extensions = useMemo<ReactCodeMirrorProps["extensions"]>(() => {
    return [
      sqlCompartment.of(buildSqlExtension(schema, defaultSchema)),
      syntaxHighlighting(highlight),
      currentStatement,
      errorStatement,
      autocompletion({
        override: undefined, // keep the SQL source; we add ours alongside
        activateOnTyping: true,
        defaultKeymap: true,
        icons: true,
        closeOnBlur: true,
      }),
      // User-managed snippets, merged in via the language's data facet so
      // they sit alongside the keyword + schema sources. The compartment
      // lets us swap the list when the user edits snippets.
      snippetCompartment.of(
        PostgreSQL.language.data.of({
          autocomplete: makeSnippetSource(snippets ?? EMPTY_SNIPPETS),
        }),
      ),
      // After any transaction whose new text ends in `<ident>.`, kick off a
      // lazy column fetch and re-open completion. Listening on transactions
      // rather than `keyup` makes this work for keyboard input, paste,
      // execCommand, and IME alike — all of them go through dispatch.
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        let insertedDot = false;
        update.changes.iterChanges((_fA, _tA, _fB, _tB, inserted) => {
          if (inserted.length > 0 && inserted.toString().endsWith(".")) {
            insertedDot = true;
          }
        });
        if (!insertedDot) return;
        const view = update.view;
        const pos = view.state.selection.main.head;
        const lineStart = view.state.doc.lineAt(pos).from;
        const upToCursor = view.state.sliceDoc(lineStart, pos);
        const m = DOT_TRIGGER_RE.exec(upToCursor);
        if (m && onEnsureColumns) {
          const [, maybeSchema, ident] = m;
          if (maybeSchema) {
            onEnsureColumns(maybeSchema, ident);
          } else {
            // Unqualified `<ident>.` — might be a table in the default schema,
            // or an alias declared elsewhere in the doc. Scan for aliases
            // first so `u.` after `from users u` prefetches `users`, not `u`.
            const alias = parseAliases(view.state.doc.toString()).get(ident.toLowerCase());
            if (alias) {
              onEnsureColumns(alias.schema || defaultSchema || "", alias.table);
            } else if (defaultSchema) {
              onEnsureColumns(defaultSchema, ident);
            }
          }
        }
        // Defer the completion-start: the same updateListener tick is mid-
        // transaction; opening completion synchronously from here re-enters
        // dispatch, which the autocomplete extension dislikes.
        queueMicrotask(() => startCompletion(view));
      }),
      EditorView.domEventHandlers({
        beforeinput(event, view) {
          if (event.inputType === "historyUndo") {
            event.preventDefault();
            return undo(view);
          }
          if (event.inputType === "historyRedo") {
            event.preventDefault();
            return redo(view);
          }
          return false;
        },
      }),
      // Tab accepts the highlighted completion when the popup is open;
      // otherwise acceptCompletion returns false and Tab falls through to
      // the default indent behavior. Boosted to outrun basicSetup's Tab.
      Prec.high(keymap.of([{ key: "Tab", run: acceptCompletion }])),
      // Run keys outrank basicSetup's keymap, which binds Mod-Enter to
      // insertBlankLine and would otherwise swallow ⌘↵. Mod-Shift-Enter
      // first, like Mod-Shift-s below.
      Prec.high(
        keymap.of([
          ...(onRunAll
            ? [
                {
                  key: "Mod-Shift-Enter",
                  preventDefault: true,
                  run: () => {
                    onRunAll();
                    return true;
                  },
                },
              ]
            : []),
          ...(onRun
            ? [
                {
                  key: "Mod-Enter",
                  preventDefault: true,
                  run: () => {
                    onRun();
                    return true;
                  },
                },
              ]
            : []),
        ]),
      ),
      // Mod-Shift-s must be registered before Mod-s so CodeMirror's keymap
      // dispatch matches the more specific binding first.
      ...(onSaveAs
        ? [
            keymap.of([
              {
                key: "Mod-Shift-s",
                preventDefault: true,
                run: () => {
                  onSaveAs();
                  return true;
                },
              },
            ]),
          ]
        : []),
      ...(onSave
        ? [
            keymap.of([
              {
                key: "Mod-s",
                preventDefault: true,
                run: () => {
                  onSave();
                  return true;
                },
              },
            ]),
          ]
        : []),
    ];
    // schema/defaultSchema/snippets deliberately excluded — we react to those
    // via the compartment reconfigure effects below so the extension list
    // stays stable across re-renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [onRun, onRunAll, onSave, onSaveAs, sqlCompartment, snippetCompartment, onEnsureColumns]);

  // When the schema changes, reconfigure the SQL extension in place. This is
  // the load-bearing call for live intellisense: lazy describe_table results
  // arrive after the editor has already mounted, and this is what makes the
  // new column list show up in the next completion query.
  useEffect(() => {
    const view = ref.current?.view;
    if (!view) return;
    view.dispatch({
      effects: sqlCompartment.reconfigure(buildSqlExtension(schema, defaultSchema)),
    });
  }, [schema, defaultSchema, sqlCompartment]);

  // Mark the statement the last run failed on. `errorRange` is the run's own
  // statement object, so this fires per run and per tab switch, not per render.
  useEffect(() => {
    ref.current?.view?.dispatch({ effects: setErrorRange.of(errorRange ?? null) });
  }, [errorRange]);

  // Snippets can mutate while the editor is open (user adds/edits in modal).
  // Swap the snippet completion source without rebuilding the editor.
  useEffect(() => {
    const view = ref.current?.view;
    if (!view) return;
    view.dispatch({
      effects: snippetCompartment.reconfigure(
        PostgreSQL.language.data.of({
          autocomplete: makeSnippetSource(snippets ?? EMPTY_SNIPPETS),
        }),
      ),
    });
  }, [snippets, snippetCompartment]);

  // Expose a tiny imperative handle for save-as-snippet: reads the current
  // selection and refocuses the editor. Kept narrow — anything bigger and we
  // should reach for a context.
  useEffect(() => {
    if (!registerHandle) return;
    registerHandle({
      getSelection: () => {
        const view = ref.current?.view;
        if (!view) return "";
        const { from, to } = view.state.selection.main;
        return view.state.sliceDoc(from, to);
      },
      getSelectionRange: () => {
        const sel = ref.current?.view?.state.selection.main;
        return { from: sel?.from ?? 0, to: sel?.to ?? 0 };
      },
      getText: () => ref.current?.view?.state.doc.toString() ?? "",
      getCursor: () => ref.current?.view?.state.selection.main.head ?? 0,
      reveal: (pos) => {
        const view = ref.current?.view;
        if (!view) return;
        const at = Math.min(pos, view.state.doc.length);
        view.dispatch({
          selection: { anchor: at },
          effects: EditorView.scrollIntoView(at, { y: "center" }),
        });
        view.focus();
      },
      focus: () => ref.current?.view?.focus(),
    });
    return () => registerHandle(null);
  }, [registerHandle]);

  return (
    <CodeMirror
      ref={ref}
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme={theme}
      readOnly={readOnly}
      height={typeof height === "number" ? `${height}px` : height ?? "100%"}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: false,
        highlightActiveLineGutter: false,
        foldGutter: false,
        // `autocompletion: false` here — we wire it up explicitly above so we
        // can layer in snippets + our own configuration.
        autocompletion: false,
        bracketMatching: true,
        closeBrackets: true,
        indentOnInput: true,
      }}
    />
  );
}
