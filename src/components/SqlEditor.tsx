import { useMemo } from "react";
import CodeMirror, { EditorView, keymap, type ReactCodeMirrorProps } from "@uiw/react-codemirror";
import { sql, PostgreSQL } from "@codemirror/lang-sql";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { undo, redo } from "@codemirror/commands";
import { tags as t } from "@lezer/highlight";

type Props = {
  value: string;
  onChange: (v: string) => void;
  onRun?: () => void;
  readOnly?: boolean;
  height?: string | number;
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
  },
  { dark: true },
);

export function SqlEditor({ value, onChange, onRun, readOnly, height }: Props) {
  const extensions = useMemo<ReactCodeMirrorProps["extensions"]>(() => {
    const exts = [
      sql({ dialect: PostgreSQL, upperCaseKeywords: false }),
      syntaxHighlighting(highlight),
      // In the Tauri webview, ⌘Z / ⌘⇧Z don't dispatch a keydown for the
      // letter (the OS routes them through the Edit menu instead). They
      // surface as `beforeinput` events with inputType "historyUndo" /
      // "historyRedo", which CodeMirror's historyKeymap doesn't bind. We
      // catch them here so undo works after paste — paste's preventDefault
      // means WebKit's native undo manager has no record of the change.
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
    ];
    if (onRun) {
      exts.push(
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
      );
    }
    return exts;
  }, [onRun]);

  return (
    <CodeMirror
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
        autocompletion: true,
        bracketMatching: true,
        closeBrackets: true,
        indentOnInput: true,
      }}
    />
  );
}
