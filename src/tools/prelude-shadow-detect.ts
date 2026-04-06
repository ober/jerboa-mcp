import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/**
 * Known shadows: names where (jerboa prelude) exports an incompatible
 * version of a Chez Scheme builtin — different arg order, different arg count,
 * different semantics, or different return type.
 *
 * Source: CLAUDE.md "Chez Scheme Conflicts (handled by prelude)" section.
 */
interface ShadowEntry {
  /** Chez Scheme (or R6RS) signature/semantics */
  chezVersion: string;
  /** Jerboa prelude version — what changes */
  jerboaVersion: string;
  /** How to access the Chez original when you need it */
  bypassPattern: string;
  /** The most common mistake this shadow causes */
  commonMistake: string;
  /** How incompatible is it? */
  severity: 'breaking' | 'signature-change' | 'minor';
}

export const PRELUDE_SHADOWS: Record<string, ShadowEntry> = {
  'make-time': {
    chezVersion: '(make-time type nanoseconds seconds) → SRFI-19 time record; type is a symbol like \'time-duration or \'time-utc',
    jerboaVersion: '(make-time year month day [hour min sec]) → Jerboa datetime record — completely different semantics',
    bypassPattern: `(let ([chez-make-time (let () (import (only (chezscheme) make-time)) make-time)])
  (chez-make-time 'time-duration 0 5))  ; 5 seconds`,
    commonMistake: '(sleep (make-time \'time-duration 0 1)) — fails with wrong-type-argument because prelude make-time expects year/month/day, not type/ns/secs',
    severity: 'breaking',
  },
  'make-date': {
    chezVersion: '(make-date nanosecond second minute hour day month year zone-offset) → SRFI-19 date record (8 args, nanoseconds first)',
    jerboaVersion: '(make-date year month day [hour min sec]) → Jerboa datetime (3-6 args, year first)',
    bypassPattern: `(let ([chez-make-date (let () (import (only (chezscheme) make-date)) make-date)])
  (chez-make-date 0 0 0 12 27 3 2026 0))  ; 2026-03-27 12:00:00 UTC`,
    commonMistake: '(make-date 2026 3 27) — Chez wants nanoseconds first (8 required args), Jerboa takes year first (3+ args)',
    severity: 'breaking',
  },
  'sort': {
    chezVersion: '(sort list pred) — LIST first, PREDICATE second',
    jerboaVersion: '(sort pred list) — PREDICATE first, LIST second (INVERTED arg order)',
    bypassPattern: `(let ([chez-sort (let () (import (only (chezscheme) sort)) sort)])
  (chez-sort '(3 1 2) <))`,
    commonMistake: '(sort \'(3 1 2) <) — will get "wrong type" error because Jerboa sort expects predicate first',
    severity: 'breaking',
  },
  'sort!': {
    chezVersion: '(sort! list pred) — destructive, LIST first, PREDICATE second',
    jerboaVersion: '(sort! pred list) — PREDICATE first, LIST second (INVERTED)',
    bypassPattern: `(let ([chez-sort! (let () (import (only (chezscheme) sort!)) sort!)])
  (chez-sort! lst <))`,
    commonMistake: '(sort! lst <) — arg order inverted vs Chez',
    severity: 'breaking',
  },
  'printf': {
    chezVersion: 'Chez printf uses ~a, ~s, ~b etc. (R6RS format codes) — same as Jerboa prelude',
    jerboaVersion: 'Same format codes; the prelude re-export should be compatible',
    bypassPattern: 'Usually compatible — if differences arise, use (format #t "..." args...)',
    commonMistake: 'Using C-style %d/%s format codes — Chez/Jerboa use ~a/~s instead',
    severity: 'minor',
  },
  'fprintf': {
    chezVersion: '(fprintf port "~a format" arg) — port first, then format, then args',
    jerboaVersion: 'Same as Chez; prelude re-export',
    bypassPattern: 'Use (format port "~a" arg) as equivalent',
    commonMistake: 'Using C-style %d/%s format codes — use ~a/~s',
    severity: 'minor',
  },
  'make-hash-table': {
    chezVersion: '(make-equal-hashtable) or (make-hashtable hash-fn equiv-fn) — Chez has no make-hash-table',
    jerboaVersion: '(make-hash-table) → equal-based hash table, 0 args',
    bypassPattern: 'Use Jerboa (make-hash-table) from prelude. For custom hash/equiv: (make-hashtable hash-fn equiv-fn)',
    commonMistake: '(make-hash-table equal? hash-by-equal) — prelude version takes 0 args, not 2',
    severity: 'signature-change',
  },
  'hash-table?': {
    chezVersion: '(hash-table? x) — Chez hashtable predicate (returns #t for any hashtable)',
    jerboaVersion: '(hash-table? x) — Jerboa re-export, same behavior',
    bypassPattern: 'Should be compatible; both check for the underlying record type',
    commonMistake: 'Not a common source of errors',
    severity: 'minor',
  },
  'iota': {
    chezVersion: 'Not a Chez builtin — comes from SRFI-1; (iota count [start [step]])',
    jerboaVersion: '(iota count [start [step]]) — Jerboa prelude provides same SRFI-1 iota',
    bypassPattern: 'Use (in-range start end) for iterator form, or (iota count start step) for list',
    commonMistake: 'Arg order confusion with R7RS iota which takes (count start step)',
    severity: 'minor',
  },
  '1+': {
    chezVersion: '(1+ n) — Chez builtin, increment',
    jerboaVersion: '(1+ n) — prelude re-export, identical',
    bypassPattern: 'No shadow issue; use (+ n 1) as portable alternative',
    commonMistake: 'Not a source of errors',
    severity: 'minor',
  },
  '1-': {
    chezVersion: '(1- n) — Chez builtin, decrement',
    jerboaVersion: '(1- n) — prelude re-export, identical',
    bypassPattern: 'No shadow issue; use (- n 1) as portable alternative',
    commonMistake: 'Not a source of errors',
    severity: 'minor',
  },
  'partition': {
    chezVersion: '(partition pred lst) → returns two values: (values matching non-matching)',
    jerboaVersion: '(partition pred lst) — Jerboa prelude version; check return convention',
    bypassPattern: '(let-values ([(yes no) (partition pred lst)]) ...) for explicit multi-value binding',
    commonMistake: '(define-values (yes no) (partition pred lst)) — use let-values instead',
    severity: 'signature-change',
  },
  'path-extension': {
    chezVersion: 'Not a Chez builtin — Chez has no built-in path utilities',
    jerboaVersion: '(path-extension "file.txt") → "txt" (without leading dot)',
    bypassPattern: 'Use Jerboa prelude version; note: returns extension WITHOUT leading dot',
    commonMistake: 'Expecting Racket-style with leading dot — Jerboa returns "txt" not ".txt"',
    severity: 'minor',
  },
  'path-absolute?': {
    chezVersion: 'Not a Chez builtin',
    jerboaVersion: '(path-absolute? "/home") → #t',
    bypassPattern: 'Use Jerboa prelude version',
    commonMistake: 'Not typically a shadow issue',
    severity: 'minor',
  },
  'with-input-from-string': {
    chezVersion: '(with-input-from-string str thunk) — R6RS; rebinds current-input-port',
    jerboaVersion: 'Same semantics; Jerboa re-export with possible UTF-8 transcoder',
    bypassPattern: '(open-string-input-port str) for explicit port without rebinding',
    commonMistake: 'Concurrent use: not safe to call from multiple threads simultaneously',
    severity: 'minor',
  },
  'with-output-to-string': {
    chezVersion: '(with-output-to-string thunk) → string; captures output',
    jerboaVersion: 'Same semantics; Jerboa re-export',
    bypassPattern: 'Use (call-with-string-output-port (lambda (p) ...)) for explicit port',
    commonMistake: 'Thread safety — captures from the current-output-port which is global',
    severity: 'minor',
  },
};

/** Scan source code for uses of shadowed symbols. */
function findShadowedUses(code: string): string[] {
  const found: string[] = [];
  for (const sym of Object.keys(PRELUDE_SHADOWS)) {
    // Word-boundary match: sym must appear as a standalone token
    // Scheme identifiers can contain ?, !, +, - so we use a custom boundary
    const escaped = sym.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![a-zA-Z0-9_!?<>=+\\-*/\\.])(${escaped})(?![a-zA-Z0-9_!?<>=+\\-*/.:#~])`, 'g');
    if (re.test(code)) {
      found.push(sym);
    }
  }
  return found;
}

function formatEntry(sym: string, entry: ShadowEntry): string {
  const lines: string[] = [];
  const severityLabel = entry.severity === 'breaking' ? '⚠ BREAKING' :
    entry.severity === 'signature-change' ? '⚡ SIGNATURE-CHANGE' : 'ℹ minor';

  lines.push(`## \`${sym}\` [${severityLabel}]`);
  lines.push('');
  lines.push(`**Chez Scheme:** ${entry.chezVersion}`);
  lines.push('');
  lines.push(`**Jerboa prelude:** ${entry.jerboaVersion}`);
  lines.push('');
  lines.push(`**Common mistake:** ${entry.commonMistake}`);
  lines.push('');
  lines.push(`**Bypass pattern (access Chez original):**`);
  lines.push('```scheme');
  lines.push(entry.bypassPattern);
  lines.push('```');
  return lines.join('\n');
}

export function registerPreludeShadowDetectTool(server: McpServer): void {
  server.registerTool(
    'jerboa_prelude_shadow_detect',
    {
      title: 'Detect Prelude-Shadowed Chez Builtins',
      description:
        'Detects when (jerboa prelude) shadows a Chez Scheme builtin with an incompatible ' +
        'version, causing confusing type/arity errors. ' +
        'Known breaking shadows: make-time (arg semantics), sort/sort! (arg order inverted), ' +
        'make-date (arg order/count). ' +
        'Provide a symbol name to look up one shadow, code to scan for all shadowed uses, ' +
        'or list_all to see every known shadow. ' +
        'Returns: Chez vs Jerboa version, common mistake, and bypass pattern to access the original.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        symbol: z.string().optional()
          .describe('Symbol name to look up (e.g. "make-time", "sort")'),
        code: z.string().optional()
          .describe('Jerboa source code to scan for shadowed symbol uses'),
        list_all: z.coerce.boolean().optional()
          .describe('List all known prelude shadows (default: only breaking/signature-change)'),
      },
    },
    async ({ symbol, code, list_all }) => {
      // Single symbol lookup
      if (symbol) {
        const entry = PRELUDE_SHADOWS[symbol];
        if (!entry) {
          const breaking = Object.entries(PRELUDE_SHADOWS)
            .filter(([, e]) => e.severity === 'breaking')
            .map(([s]) => s)
            .join(', ');
          return {
            content: [{
              type: 'text' as const,
              text: `"${symbol}" is not a known prelude shadow.\n\nBreaking shadows: ${breaking}\n\nUse list_all: true to see all ${Object.keys(PRELUDE_SHADOWS).length} tracked symbols.`,
            }],
          };
        }
        return {
          content: [{ type: 'text' as const, text: formatEntry(symbol, entry) }],
        };
      }

      // Scan code for shadowed uses
      if (code) {
        const found = findShadowedUses(code);
        if (found.length === 0) {
          return {
            content: [{
              type: 'text' as const,
              text: 'No prelude-shadowed symbols detected in the provided code.',
            }],
          };
        }
        const sections: string[] = [
          `Found ${found.length} prelude-shadowed symbol(s): ${found.join(', ')}`,
          '',
        ];
        for (const sym of found) {
          sections.push(formatEntry(sym, PRELUDE_SHADOWS[sym]));
          sections.push('');
          sections.push('---');
          sections.push('');
        }
        return {
          content: [{ type: 'text' as const, text: sections.join('\n') }],
          isError: found.some((s) => PRELUDE_SHADOWS[s].severity === 'breaking'),
        };
      }

      // List all (or just breaking+signature-change)
      const filter = list_all
        ? Object.keys(PRELUDE_SHADOWS)
        : Object.entries(PRELUDE_SHADOWS)
            .filter(([, e]) => e.severity !== 'minor')
            .map(([s]) => s);

      const sections: string[] = [
        list_all
          ? `All ${Object.keys(PRELUDE_SHADOWS).length} prelude-shadowed Chez symbols:`
          : `Breaking and signature-changing prelude shadows (${filter.length} of ${Object.keys(PRELUDE_SHADOWS).length}):`,
        '',
      ];

      for (const sym of filter) {
        sections.push(formatEntry(sym, PRELUDE_SHADOWS[sym]));
        sections.push('');
        sections.push('---');
        sections.push('');
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
