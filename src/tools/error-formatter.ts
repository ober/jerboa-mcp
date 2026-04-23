/**
 * Parse and restructure Chez Scheme error output into a
 * machine-friendly header plus the original trace.
 *
 * Input: the raw stderr/stdout from a failed compile/expand.
 * Output: string where the first line is an LLM-digestible summary
 *   (ERROR <kind>: <what> at <file:line:col>) followed by the raw
 *   trace. If nothing matches, returns the input unchanged.
 */

export interface StructuredError {
  kind: string;
  summary: string;
  identifier?: string;
  file?: string;
  line?: number;
  column?: number;
}

const PATTERNS: Array<{
  kind: string;
  re: RegExp;
  summary: (m: RegExpMatchArray) => string;
  identifier?: (m: RegExpMatchArray) => string | undefined;
}> = [
  {
    kind: 'unbound-identifier',
    re: /(?:Exception:\s*)?(?:unbound identifier|variable)\s+([^\s,.;]+)\s+(?:is not bound|not bound)/i,
    summary: (m) => `unbound identifier '${m[1]}'`,
    identifier: (m) => m[1],
  },
  {
    kind: 'unbound-identifier',
    re: /(?:Exception:\s*)?variable\s+([^\s,.;]+)\s+is not bound/i,
    summary: (m) => `unbound identifier '${m[1]}'`,
    identifier: (m) => m[1],
  },
  {
    kind: 'missing-import',
    re: /(?:Exception:\s*)?missing import for ([^\s]+)/i,
    summary: (m) => `missing import for '${m[1]}'`,
    identifier: (m) => m[1],
  },
  {
    kind: 'wrong-argument-count',
    re: /Exception:\s*(?:incorrect number of arguments|wrong number of arguments|too few arguments|too many arguments)[^\n]*?(?:to|in)\s+([^\s)]+)/i,
    summary: (m) => `wrong argument count in call to '${m[1]}'`,
    identifier: (m) => m[1],
  },
  {
    kind: 'syntax-error',
    re: /(?:Exception:\s*)?invalid syntax(?:[:\s]+([^\n]+?))?(?:\s+at\s|$)/i,
    summary: (m) => `invalid syntax${m[1] ? `: ${m[1].trim()}` : ''}`,
  },
  {
    kind: 'syntax-error',
    re: /Exception:\s*(unexpected [^\n]+?)(?:\s+at\s|$)/i,
    summary: (m) => m[1].trim(),
  },
  {
    kind: 'runtime-error',
    re: /Exception in ([^\s:]+):\s*([^\n]+)/,
    summary: (m) => `${m[1]}: ${m[2].trim()}`,
    identifier: (m) => m[1],
  },
  {
    kind: 'runtime-error',
    re: /Exception:\s*([^\n]+)/,
    summary: (m) => m[1].trim(),
  },
];

const LOC_RE = /at line (\d+),?\s*char(?:acter)? (\d+) of\s+([^\s]+)/i;
const LOC_RE_SHORT = /([A-Za-z0-9_./\-]+\.(?:ss|sls)):(\d+):(\d+)/;

function extractLocation(raw: string): Pick<StructuredError, 'file' | 'line' | 'column'> {
  const m = raw.match(LOC_RE);
  if (m) {
    return { file: m[3], line: parseInt(m[1], 10), column: parseInt(m[2], 10) };
  }
  const m2 = raw.match(LOC_RE_SHORT);
  if (m2) {
    return { file: m2[1], line: parseInt(m2[2], 10), column: parseInt(m2[3], 10) };
  }
  return {};
}

export function parseSchemeError(raw: string): StructuredError | null {
  const loc = extractLocation(raw);
  for (const pat of PATTERNS) {
    const m = raw.match(pat.re);
    if (m) {
      return {
        kind: pat.kind,
        summary: pat.summary(m),
        identifier: pat.identifier?.(m),
        ...loc,
      };
    }
  }
  return null;
}

/**
 * Render a one-line header from a parsed error.
 */
export function formatErrorHeader(s: StructuredError): string {
  const locPart =
    s.file && s.line
      ? ` at ${s.file}:${s.line}${s.column ? `:${s.column}` : ''}`
      : '';
  return `ERROR [${s.kind}]: ${s.summary}${locPart}`;
}

/**
 * Wrap a raw Chez trace with a one-line structured header, then the
 * original text. Returns the input unchanged if no pattern matches.
 */
export function structureError(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const parsed = parseSchemeError(trimmed);
  if (!parsed) return raw;
  return `${formatErrorHeader(parsed)}\n\n${trimmed}`;
}
