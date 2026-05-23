export function makeComparator(dataType: string): (a: string, b: string) => number {
  const t = dataType.toLowerCase();
  const numeric =
    /^(small|big)?int|^int\d?|^numeric|^decimal|^real|^double|^float|^serial/.test(t);
  const date = t.startsWith("date") || t.startsWith("timestamp") || t.startsWith("time");
  if (numeric) {
    return (a, b) => {
      const na = Number(a);
      const nb = Number(b);
      if (Number.isNaN(na) || Number.isNaN(nb)) return a.localeCompare(b);
      return na - nb;
    };
  }
  if (date) {
    return (a, b) => {
      const da = Date.parse(a);
      const db = Date.parse(b);
      if (Number.isNaN(da) || Number.isNaN(db)) return a.localeCompare(b);
      return da - db;
    };
  }
  return (a, b) => a.localeCompare(b, undefined, { numeric: true });
}

// Excel/Numbers-compatible TSV encoding: cells with tabs, newlines, or
// quotes get wrapped in double quotes with internal quotes doubled. NULL
// becomes an empty cell.
export function cellToTsv(v: string | null): string {
  if (v === null) return "";
  if (/[\t\n\r"]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
