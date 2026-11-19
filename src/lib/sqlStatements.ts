/** A statement's span in editor text. `from` is its first token (leading
 *  whitespace and comments excluded); `to` is just past its `;`, or past its
 *  last token when unterminated. `sql` is the statement without the `;`. */
export type Stmt = { from: number; to: number; sql: string };

const IDENT_CONT = /[A-Za-z0-9_$\u0080-￿]/;
const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-￿][A-Za-z0-9_\u0080-￿]*)?\$/y;

/**
 * Split SQL into statements on top-level `;` the way psql does: never inside
 * quotes ('…', E'…', "…"), dollar quotes ($$…$$, $tag$…$tag$), comments (--,
 * nested /* *\/) or parentheses. Comment-only stretches aren't statements.
 */
export function splitStatements(text: string): Stmt[] {
  const out: Stmt[] = [];
  const n = text.length;
  let start = -1; // first token of the current statement
  let end = -1; // just past its latest token
  let depth = 0;
  let i = 0;
  while (i < n) {
    const c = text[i];
    const next = text[i + 1];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "-" && next === "-") {
      const nl = text.indexOf("\n", i);
      i = nl < 0 ? n : nl;
      continue;
    }
    if (c === "/" && next === "*") {
      let d = 1;
      i += 2;
      while (i < n && d > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          d++;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          d--;
          i += 2;
        } else i++;
      }
      continue;
    }
    if (c === ";" && depth === 0) {
      if (start >= 0) out.push({ from: start, to: i + 1, sql: text.slice(start, end) });
      start = -1;
      i++;
      continue;
    }
    if (start < 0) start = i;
    if (c === "'") {
      // E'…' strings take backslash escapes; the E must start its own token.
      const escapes = i > 0 && /[eE]/.test(text[i - 1]) && !(i > 1 && IDENT_CONT.test(text[i - 2]));
      i = skipQuoted(text, i, "'", escapes);
    } else if (c === '"') {
      i = skipQuoted(text, i, '"', false);
    } else if (c === "$" && !(i > 0 && IDENT_CONT.test(text[i - 1]))) {
      DOLLAR_TAG.lastIndex = i;
      const tag = DOLLAR_TAG.exec(text)?.[0];
      if (tag) {
        const close = text.indexOf(tag, i + tag.length);
        i = close < 0 ? n : close + tag.length;
      } else i++;
    } else {
      if (c === "(") depth++;
      else if (c === ")" && depth > 0) depth--;
      i++;
    }
    end = i;
  }
  if (start >= 0) out.push({ from: start, to: end, sql: text.slice(start, end) });
  return out;
}

/** Index just past the quoted run opening at `i` (or the end, unterminated). */
function skipQuoted(text: string, i: number, quote: string, escapes: boolean): number {
  let j = i + 1;
  while (j < text.length) {
    if (escapes && text[j] === "\\") j += 2;
    else if (text[j] === quote) {
      if (text[j + 1] !== quote) return j + 1;
      j += 2;
    } else j++;
  }
  return text.length;
}

/**
 * The statement ⌘↵ runs for a cursor at `pos`: the one it's inside; else, from
 * the gap between two statements, the earlier one while still on the line it
 * ended on (just after its `;`), otherwise the next — comments above a
 * statement read as its header.
 */
export function statementAt(text: string, stmts: Stmt[], pos: number): Stmt | null {
  for (let k = 0; k < stmts.length; k++) {
    const s = stmts[k];
    if (pos < s.from) {
      const prev = stmts[k - 1];
      if (prev && !text.slice(prev.to, pos).includes("\n")) return prev;
      return s;
    }
    if (pos <= s.to) return s;
  }
  return stmts[stmts.length - 1] ?? null;
}
