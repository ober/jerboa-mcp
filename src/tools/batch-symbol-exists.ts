import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  runChez,
  escapeSchemeString,
  normalizeImport,
  ERROR_MARKER,
} from '../chez.js';

const ROW_MARKER = 'JERBOA-MCP-ROW:';

const DEFAULT_PROBE_MODULES = [
  '(jerboa prelude)',
  '(std clojure)',
  '(std srfi srfi-1)',
  '(std srfi srfi-13)',
  '(std misc list)',
  '(std misc string)',
  '(std misc func)',
  '(std misc thread)',
  '(std misc process)',
  '(std misc ports)',
  '(std sort)',
  '(std iter)',
  '(std sugar)',
  '(std result)',
  '(std datetime)',
  '(std text json)',
  '(std os path)',
  '(std os env)',
];

interface SymbolRow {
  name: string;
  exists: boolean;
  module?: string;
  kind?: string; // procedure, macro/syntax, record-type, value
  arity?: string;
}

export function registerBatchSymbolExistsTool(server: McpServer): void {
  server.registerTool(
    'jerboa_batch_symbol_exists',
    {
      title: 'Batch Symbol Existence Check',
      description:
        'Check whether each of N symbols is exported by (jerboa prelude) or any of a probe ' +
        'set of stdlib modules. Returns per-symbol exists/module/kind/arity in a single Chez ' +
        'subprocess call. Equivalent to N parallel apropos calls but cheaper. ' +
        'Default probes a curated list of common stdlib modules; pass probe_modules to extend or override.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        symbols: z
          .array(z.string())
          .min(1)
          .describe('Symbol names to look up (e.g. ["merge-with", "select-keys", "fnil"])'),
        probe_modules: z
          .array(z.string())
          .optional()
          .describe(
            'Modules to probe in addition to (jerboa prelude). Default covers common stdlib modules. ' +
              'Pass replace_defaults: true to use only your list.',
          ),
        replace_defaults: z
          .boolean()
          .optional()
          .describe('If true, ignore the default module list and probe only probe_modules.'),
        jerboa_home: z.string().optional(),
      },
    },
    async ({ symbols, probe_modules, replace_defaults, jerboa_home }) => {
      const requested = (probe_modules ?? []).map(normalizeImport);
      const probes = replace_defaults
        ? requested
        : Array.from(new Set([...DEFAULT_PROBE_MODULES.map(normalizeImport), ...requested]));

      // Build the Scheme list of probe modules as quoted s-exprs
      const probeListSchemeLiteral = probes.map((m) => `'${m}`).join(' ');

      // Build the Scheme list of symbol names (quoted)
      const symbolsLiteral = symbols
        .map((s) => `'${s}`)
        .join(' ');

      // Note: rows print plain | separated values. Module is printed as a
      // (...) form with spaces preserved, so we use \t as the field
      // separator on output.
      const code = `
(import (chezscheme))

(define probes (list ${probeListSchemeLiteral}))
(define queries (list ${symbolsLiteral}))

;; Per-module symbol sets — built lazily in a guard so a missing or
;; broken module does not abort the whole check.
(define probe-tables
  (map (lambda (mod)
         (guard (e [else #f])
           (let ([env (environment mod)])
             (let ([syms (environment-symbols env)])
               (let ([tbl (make-eq-hashtable)])
                 (for-each (lambda (s) (hashtable-set! tbl s #t)) syms)
                 (cons mod tbl))))))
       probes))

(define (module-of sym)
  (let loop ([ps probe-tables])
    (cond
      [(null? ps) #f]
      [(not (car ps)) (loop (cdr ps))]
      [(hashtable-ref (cdr (car ps)) sym #f) (car (car ps))]
      [else (loop (cdr ps))])))

(define (kind-of-binding sym mod)
  (guard (e [else "unknown"])
    (let ([env (environment mod)])
      (let ([val (eval sym env)])
        (cond
          [(procedure? val) "procedure"]
          [(record-type-descriptor? val) "record-type"]
          [else "value"])))))

(define (arity-of-binding sym mod)
  (guard (e [else ""])
    (let ([env (environment mod)])
      (let ([val (eval sym env)])
        (if (procedure? val)
            (number->string (procedure-arity-mask val))
            "")))))

(for-each
  (lambda (sym)
    (let ([mod (module-of sym)])
      (display "${ROW_MARKER}")
      (display sym) (display "\\t")
      (if mod
          (begin
            (display "yes") (display "\\t")
            (write mod) (display "\\t")
            (display (kind-of-binding sym mod)) (display "\\t")
            (display (arity-of-binding sym mod)))
          (begin
            (display "no") (display "\\t\\t\\t")))
      (newline)))
  queries)
`;

      const result = await runChez(code, { jerboaHome: jerboa_home, timeout: 30_000 });

      if (result.timedOut) {
        return {
          content: [{ type: 'text' as const, text: 'Symbol existence check timed out.' }],
          isError: true,
        };
      }

      if (result.stdout.includes(ERROR_MARKER)) {
        const errIdx = result.stdout.indexOf(ERROR_MARKER);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error during check:\n${result.stdout.slice(errIdx + ERROR_MARKER.length).trim()}`,
            },
          ],
          isError: true,
        };
      }

      if (result.exitCode !== 0 && !result.stdout.includes(ROW_MARKER)) {
        return {
          content: [{ type: 'text' as const, text: `Failed:\n${result.stderr.trim() || result.stdout.trim()}` }],
          isError: true,
        };
      }

      const rows: SymbolRow[] = [];
      for (const line of result.stdout.split('\n')) {
        if (!line.startsWith(ROW_MARKER)) continue;
        const payload = line.slice(ROW_MARKER.length);
        const fields = payload.split('\t');
        const [name, exists, mod, kind, arity] = fields;
        rows.push({
          name: name ?? '',
          exists: exists === 'yes',
          module: mod && mod.length > 0 ? mod : undefined,
          kind: kind && kind.length > 0 ? kind : undefined,
          arity: arity && arity.length > 0 ? arityMaskDescription(arity) : undefined,
        });
      }

      const present = rows.filter((r) => r.exists);
      const absent = rows.filter((r) => !r.exists);

      const lines: string[] = [];
      lines.push(`Batch symbol check: ${present.length}/${rows.length} found`);
      lines.push(`Probed ${probes.length} module(s)`);
      lines.push('');

      if (present.length > 0) {
        lines.push('Present:');
        for (const r of present) {
          const meta = [r.module, r.kind, r.arity].filter(Boolean).join(' ');
          lines.push(`  ${r.name} — ${meta}`);
        }
        lines.push('');
      }

      if (absent.length > 0) {
        lines.push('Absent (not in probed modules):');
        for (const r of absent) {
          lines.push(`  ${r.name}`);
        }
      }

      return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
    },
  );
}

function arityMaskDescription(maskStr: string): string {
  const mask = parseInt(maskStr, 10);
  if (Number.isNaN(mask)) return '';
  if (mask < 0) {
    // Negative mask means variadic: bits cleared in the upper portion
    // describe the minimum required argument count.
    const inv = ~mask;
    let min = 0;
    while ((inv & (1 << min)) !== 0) min++;
    return `${min}+ args (variadic)`;
  }
  const arities: number[] = [];
  for (let i = 0; i < 20; i++) {
    if (mask & (1 << i)) arities.push(i);
  }
  if (arities.length === 0) return `mask=${mask}`;
  if (arities.length === 1) return `${arities[0]} args`;
  return `${arities.join('/')} args`;
}
