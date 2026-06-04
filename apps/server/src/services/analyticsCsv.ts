/**
 * CSV export for the analytics v2 dashboard.
 *
 * Every export is a pure transform over the same query results the
 * dashboard's JSON endpoints already return — no new query logic.
 * Centralizing the escape here keeps the export endpoints tiny and
 * consistent: every string goes through `csvEscape` which handles
 * commas, quotes, newlines, and the infamous CSV-injection prefixes
 * (`=`, `+`, `-`, `@`, TAB, CR) by prepending a single quote.
 */

/** CSV-injection sensitive prefixes. See OWASP "Formula Injection".
 * `\n` included as defense-in-depth even though RFC 4180 quoting already
 * protects compliant parsers. */
const INJECTION_PREFIXES = new Set(["=", "+", "-", "@", "\t", "\r", "\n"]);

/**
 * Escape a single CSV field. Wraps in double quotes when the value
 * contains separators or special chars; neutralizes formula-injection
 * prefixes. Always returns a quoted string so field boundaries are
 * unambiguous even when the caller concatenates without a joiner.
 *
 * @param v - Value to escape. Non-strings are coerced via String().
 * @returns Quoted CSV field.
 */
export function csvEscape(v: unknown): string {
  let s = v === null || v === undefined ? "" : String(v);
  if (s.length > 0 && INJECTION_PREFIXES.has(s[0])) {
    s = `'${s}`;
  }
  // Always double-quote so commas / newlines / tabs stay inside the field.
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Serialize an array of records to CSV. The header row is the UNION of
 * all keys across every input row (not just the first row's keys), so
 * rows with extra columns don't get silently dropped. Header order
 * follows each key's first appearance across the input.
 *
 * @param rows - Array of objects with primitive values.
 * @returns CSV string with `\r\n` line endings (Excel-friendly).
 */
export function toCsv(rows: Array<Record<string, unknown>>): string {
  if (rows.length === 0) return "";
  const headers: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!seen.has(key)) {
        seen.add(key);
        headers.push(key);
      }
    }
  }
  const headerLine = headers.map(csvEscape).join(",");
  const dataLines = rows.map((row) =>
    headers.map((h) => csvEscape(row[h])).join(","),
  );
  return [headerLine, ...dataLines].join("\r\n") + "\r\n";
}
