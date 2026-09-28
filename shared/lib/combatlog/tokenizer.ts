/**
 * Tokenizer for WoWCombatLog.txt lines. A line is `<timestamp>  EVENT,field,field,...`: fields are
 * comma separated, strings are double-quoted (and may contain commas), and some events (COMBATANT_INFO)
 * nest lists in `(...)` and `[...]`. Unknown shapes never throw: the tokenizer returns what it can.
 */

export type Field = string | Field[];

export interface TokenizedLine {
  /** Milliseconds since the Unix epoch, read as UTC then shifted by the line's UTC offset when present. */
  timestamp: number;
  event: string;
  fields: Field[];
}

/**
 * Split a comma-separated field list. Quoted strings lose their quotes (`""` inside becomes `"`);
 * brackets and parentheses become nested arrays.
 */
export function splitFields(input: string): Field[] {
  const root: Field[] = [];
  const stack: Field[][] = [root];
  let current = "";
  let quoted = false;
  let hasToken = false;
  const top = () => stack[stack.length - 1]!;
  const flush = () => {
    if (hasToken) top().push(current);
    current = "";
    hasToken = false;
  };

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === '"') {
      quoted = true;
      hasToken = true;
    } else if (ch === ",") {
      flush();
    } else if (ch === "(" || ch === "[") {
      const list: Field[] = [];
      top().push(list);
      stack.push(list);
    } else if (ch === ")" || ch === "]") {
      flush();
      if (stack.length > 1) stack.pop();
    } else if (ch !== "\r" && ch !== "\n") {
      current += ch;
      hasToken = true;
    }
  }
  flush();
  return root;
}

const TIMESTAMP = /^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s+(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?([+-]\d{1,2}(?::?\d{2})?)?\s+/;

/**
 * Parse the leading timestamp. Retail writes `9/27/2026 21:15:02.123-7`; older and Classic clients
 * write `9/27 21:15:02.123` with no year, so `fallbackYear` fills it in.
 */
export function parseTimestamp(line: string, fallbackYear: number): { ms: number; rest: string } | null {
  const m = TIMESTAMP.exec(line);
  if (!m) return null;
  const [, mo, d, y, h, mi, s, frac, tz] = m;
  let year = y ? Number(y) : fallbackYear;
  if (year < 100) year += 2000;
  const millis = frac ? Number(frac.padEnd(3, "0")) : 0;
  let ms = Date.UTC(year, Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s), millis);
  if (tz) {
    const sign = tz.startsWith("-") ? -1 : 1;
    const digits = tz.slice(1).replace(":", "");
    const hours = digits.length > 2 ? Number(digits.slice(0, -2)) : Number(digits);
    const minutes = digits.length > 2 ? Number(digits.slice(-2)) : 0;
    ms -= sign * (hours * 60 + minutes) * 60_000;
  }
  return { ms, rest: line.slice(m[0].length) };
}

export function tokenizeLine(line: string, fallbackYear = new Date().getUTCFullYear()): TokenizedLine | null {
  const ts = parseTimestamp(line, fallbackYear);
  if (!ts) return null;
  const comma = ts.rest.indexOf(",");
  const event = (comma === -1 ? ts.rest : ts.rest.slice(0, comma)).trim();
  if (!event) return null;
  return { timestamp: ts.ms, event, fields: comma === -1 ? [] : splitFields(ts.rest.slice(comma + 1)) };
}

export interface LogHeader {
  version: number | null;
  advanced: boolean;
  build: string | null;
  projectId: number | null;
}

/** `COMBAT_LOG_VERSION,22,ADVANCED_LOG_ENABLED,1,BUILD_VERSION,12.1.5,PROJECT_ID,1` as key/value pairs. */
export function parseHeader(fields: Field[]): LogHeader {
  const header: LogHeader = { version: null, advanced: false, build: null, projectId: null };
  const flat = fields.map((f) => (typeof f === "string" ? f : ""));
  header.version = Number(flat[0]) || null;
  for (let i = 1; i + 1 < flat.length; i += 2) {
    const key = flat[i]!.toUpperCase();
    const value = flat[i + 1]!;
    if (key === "ADVANCED_LOG_ENABLED") header.advanced = value === "1";
    else if (key === "BUILD_VERSION") header.build = value;
    else if (key === "PROJECT_ID") header.projectId = Number(value) || null;
  }
  return header;
}
