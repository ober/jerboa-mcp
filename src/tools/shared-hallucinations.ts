import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const DIVERGENCE_PATH = join(__dirname, '..', '..', 'divergence.json');
const API_SIG_PATH = join(__dirname, '..', '..', 'api-signatures.json');

interface DivergenceEntry {
  id: string;
  wrong: string;
  wrong_source: string[];
  wrong_example?: string;
  correct: string;
  correct_example?: string;
  imports?: string[];
  category: string;
  severity: 'error' | 'warning' | 'aliased' | 'compat';
  notes?: string;
  available_via?: string[] | null;
}

interface DivergenceData {
  version: string;
  generated: string;
  entries: DivergenceEntry[];
}

interface ApiSignatures {
  modules: Record<string, { file: string; exports: string[] }>;
  symbol_index: Record<string, string[]>;
}

// Load once at module init.
const DIVERGENCE: DivergenceData = loadJson<DivergenceData>(DIVERGENCE_PATH, {
  version: '',
  generated: '',
  entries: [],
});
const API: ApiSignatures = loadJson<ApiSignatures>(API_SIG_PATH, {
  modules: {},
  symbol_index: {},
});

function loadJson<T>(path: string, fallback: T): T {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return fallback;
  }
}

// Simple-identifier regex: matches the "wrong" forms that are bare symbols
// rather than multi-token syntactic templates.
const SIMPLE_ID_RE = /^[A-Za-z_\-+*/<>=!?0-9$%&^~.]+$/;

// Build a map: wrong-identifier → entry, only for simple-id entries.
const BY_WRONG_ID: Map<string, DivergenceEntry> = (() => {
  const m = new Map<string, DivergenceEntry>();
  for (const e of DIVERGENCE.entries) {
    if (SIMPLE_ID_RE.test(e.wrong)) {
      // Prefer error/compat over warning for stronger hints.
      const existing = m.get(e.wrong);
      if (!existing || severityWeight(e.severity) > severityWeight(existing.severity)) {
        m.set(e.wrong, e);
      }
    }
  }
  return m;
})();

function severityWeight(s: DivergenceEntry['severity']): number {
  switch (s) {
    case 'error':
      return 4;
    case 'compat':
      return 3;
    case 'warning':
      return 2;
    case 'aliased':
      return 1;
  }
}

/**
 * Back-compat export: same shape as the old hardcoded map, derived from
 * divergence.json. Downstream callers that iterated this map continue to
 * work, now with ~100 entries instead of 24.
 */
export const KNOWN_HALLUCINATIONS: Record<string, string> = (() => {
  const out: Record<string, string> = {};
  for (const [wrong, e] of BY_WRONG_ID.entries()) {
    out[wrong] = e.correct;
  }
  return out;
})();

/**
 * Format a rich hint for a single divergence entry. Includes:
 *  - corrected form
 *  - dialect attribution (which Scheme people migrate from)
 *  - available_via imports if the symbol is a compat export
 */
function formatHint(entry: DivergenceEntry): string {
  const parts: string[] = [];
  parts.push(`\`${entry.wrong}\` → \`${entry.correct}\``);

  if (entry.wrong_source?.length) {
    parts.push(`(from ${entry.wrong_source.join(', ')})`);
  }

  const avail = entry.available_via;
  if (avail && avail.length > 0) {
    // `compat`: the symbol *is* in some module. Import suggestion is
    // often the right fix.
    parts.push(`— available via ${avail.map((m) => `\`${m}\``).join(' or ')}`);
  } else if (entry.severity === 'error') {
    parts.push('— does not exist in Jerboa');
  }
  return parts.join(' ');
}

/**
 * Enrich a Chez error message with divergence-aware hints. Matches the
 * historical signature; callers require no change.
 */
export function injectHallucinationHints(errorMsg: string): string {
  let result = errorMsg;

  // Primary path: Chez's unbound-variable error mentions the name.
  const m = errorMsg.match(/(?:unbound identifier|variable|not bound)\s+([^\s,.;]+)/i);
  let ident: string | null = null;
  if (m && m[1]) {
    ident = m[1].replace(/^['`.]+|['`.]+$/g, '');
  }

  if (ident && BY_WRONG_ID.has(ident)) {
    const entry = BY_WRONG_ID.get(ident)!;
    result += `\n\nHint: ${formatHint(entry)}.`;
    if (entry.notes) {
      result += `\n${entry.notes}`;
    }
    return result;
  }

  // Fallback: scan the error message for any known-wrong identifier.
  // Word-boundary match so `read-line` doesn't false-positive on
  // `read-liner` etc.
  for (const [wrong, entry] of BY_WRONG_ID.entries()) {
    const escaped = wrong.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![A-Za-z0-9_\\-!?])${escaped}(?![A-Za-z0-9_\\-!?])`).test(errorMsg)) {
      result += `\n\nHint: ${formatHint(entry)}.`;
      return result;
    }
  }
  return result;
}

export interface DivergenceHit {
  identifier: string;
  line: number;
  column: number;
  severity: DivergenceEntry['severity'];
  correct: string;
  sources: string[];
  available_via: string[] | null | undefined;
  notes: string | undefined;
}

/**
 * Tokenize source and report every occurrence of a known-wrong
 * identifier. Catches hallucinations *before* compile — useful when an
 * LLM writes code that happens to still compile (e.g., because the
 * name is shadowed locally) but is semantically wrong.
 *
 * Skips content inside string literals and line/block comments.
 */
export function preScanDivergence(source: string): DivergenceHit[] {
  const hits: DivergenceHit[] = [];
  const n = source.length;
  let line = 1;
  let col = 1;

  function newline(): void {
    line += 1;
    col = 1;
  }

  let i = 0;
  while (i < n) {
    const ch = source[i]!;

    // Line comment
    if (ch === ';') {
      while (i < n && source[i] !== '\n') i++;
      continue;
    }

    // Block comment #| ... |# — nested
    if (ch === '#' && source[i + 1] === '|') {
      let depth = 1;
      i += 2;
      col += 2;
      while (i < n && depth > 0) {
        if (source[i] === '\n') {
          newline();
          i++;
          continue;
        }
        if (source[i] === '#' && source[i + 1] === '|') {
          depth++;
          i += 2;
          col += 2;
          continue;
        }
        if (source[i] === '|' && source[i + 1] === '#') {
          depth--;
          i += 2;
          col += 2;
          continue;
        }
        i++;
        col++;
      }
      continue;
    }

    // String literal
    if (ch === '"') {
      i++;
      col++;
      while (i < n && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < n) {
          i += 2;
          col += 2;
          continue;
        }
        if (source[i] === '\n') newline();
        else col++;
        i++;
      }
      if (i < n) {
        i++;
        col++;
      }
      continue;
    }

    // Newline
    if (ch === '\n') {
      newline();
      i++;
      continue;
    }

    // Whitespace / delimiters
    if (/\s/.test(ch) || ch === '(' || ch === ')' || ch === '[' || ch === ']' || ch === '{' || ch === '}' || ch === "'" || ch === '`' || ch === ',') {
      i++;
      col++;
      continue;
    }

    // Read an atom
    const startLine = line;
    const startCol = col;
    let atom = '';
    while (i < n) {
      const c = source[i]!;
      if (/\s/.test(c) || c === '(' || c === ')' || c === '[' || c === ']' || c === '{' || c === '}' || c === '"' || c === ';') {
        break;
      }
      atom += c;
      i++;
      col++;
    }

    if (atom.length > 0 && BY_WRONG_ID.has(atom)) {
      const entry = BY_WRONG_ID.get(atom)!;
      hits.push({
        identifier: atom,
        line: startLine,
        column: startCol,
        severity: entry.severity,
        correct: entry.correct,
        sources: entry.wrong_source,
        available_via: entry.available_via,
        notes: entry.notes,
      });
    }
  }

  return hits;
}

/**
 * Render pre-scan hits as a human-readable block to append to verifier
 * output. Returns empty string if no hits.
 */
export function formatPreScanHits(hits: DivergenceHit[]): string {
  if (hits.length === 0) return '';
  const lines: string[] = [];
  lines.push(`\nDivergence pre-scan found ${hits.length} suspicious identifier${hits.length === 1 ? '' : 's'}:`);
  for (const h of hits) {
    const sevTag =
      h.severity === 'error' ? '[ERROR]' :
      h.severity === 'compat' ? '[compat]' :
      h.severity === 'warning' ? '[warn]' : '[aliased]';
    lines.push(`  ${sevTag} ${h.line}:${h.column}  \`${h.identifier}\` → \`${h.correct}\`  (from ${h.sources.join(', ')})`);
    if (h.available_via && h.available_via.length > 0) {
      lines.push(`           available via ${h.available_via.map((m) => `\`${m}\``).join(' or ')}`);
    }
  }
  return lines.join('\n');
}

/**
 * Look up modules that export a given symbol. Used for
 * missing-import suggestions.
 */
export function modulesProviding(symbol: string): string[] {
  return API.symbol_index[symbol] ?? [];
}

export function divergenceEntryFor(identifier: string): DivergenceEntry | undefined {
  return BY_WRONG_ID.get(identifier);
}
