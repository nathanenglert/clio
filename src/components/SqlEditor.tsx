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
import { Compartment, Prec } from "@codemirror/state";
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

type Props = {
  value: string;
  onChange: (v: string) => void;
  onRun?: () => void;
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

export function SqlEditor({
  value,
  onChange,
  onRun,
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
      ...(onRun
        ? [
            keymap.of([
              {
                key: "Mod-Enter",
                preventDefault: true,
                run: () => {
                  onRun();
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
  }, [onRun, sqlCompartment, snippetCompartment, onEnsureColumns]);

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
