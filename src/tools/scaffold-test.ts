import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, escapeSchemeString, ERROR_MARKER, buildPreamble, normalizeImport } from '../chez.js';

const RESULT_MARKER = 'JERBOA-MCP-SCAFFOLD-TEST:';

export function registerScaffoldTestTool(server: McpServer): void {
  server.registerTool(
    'jerboa_scaffold_test',
    {
      title: 'Scaffold Test File',
      description:
        'Generate a (std test) skeleton from a module\'s exports. ' +
        'Introspects the module to discover exported procedures and values, ' +
        'then produces a ready-to-fill test file. Does not write to disk — returns the generated text.',
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        module_path: z
          .string()
          .describe(
            'Module to generate tests for (e.g. "(std text json)", "(myproject handler)")',
          ),
        suite_name: z
          .string()
          .optional()
          .describe(
            'Override the test suite name (default: derived from module path)',
          ),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ module_path, suite_name, jerboa_home }) => {
      const normalizedMod = normalizeImport(module_path);

      // Introspect the module to get exports with kind and arity
      const code = `
(import (jerboa prelude))
(import ${normalizedMod})

(define (inspect)
  (guard (e [else
             (display "${ERROR_MARKER}\\n")
             (display-condition e (current-output-port))])
    (let ((env (the-environment)))
      (environment-for-each env
        (lambda (name val)
          (cond
            ((procedure? val)
             (display "${RESULT_MARKER}")
             (display name)
             (display "\\tprocedure\\t")
             (display (procedure-arity-mask val))
             (newline))
            (else
             (display "${RESULT_MARKER}")
             (display name)
             (display "\\tvalue\\t0")
             (newline))))))))

(inspect)
`;

      const result = await runChez(code, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return {
          content: [
            { type: 'text' as const, text: 'Module introspection timed out.' },
          ],
          isError: true,
        };
      }

      // Even on exit code != 0, we may have partial output
      const stdout = result.stdout;
      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();

        // If module load fails, generate minimal skeleton anyway
        const derivedSuiteName = suite_name ?? deriveSuiteName(normalizedMod);
        const displayName = normalizedMod;

        const skeleton = [
          `(import (jerboa prelude))`,
          `(import (std test))`,
          `(import ${normalizedMod})`,
          `(export ${derivedSuiteName})`,
          '',
          `(define ${derivedSuiteName}`,
          `  (test-suite "${escapeSchemeString(displayName)}"`,
          `    ;; Module load error: ${errorMsg.slice(0, 100)}`,
          `    ;; Add test cases here`,
          `    ))`,
          '',
          `(run-tests! ${derivedSuiteName})`,
          '(test-report-summary!)',
        ].join('\n');

        return {
          content: [{ type: 'text' as const, text: skeleton }],
        };
      }

      // Parse result lines
      const lines = stdout
        .split('\n')
        .filter((l) => l.startsWith(RESULT_MARKER));

      // Derive suite name from module path
      const derivedSuiteName = suite_name ?? deriveSuiteName(normalizedMod);
      const displayName = normalizedMod;

      if (lines.length === 0) {
        // Module has no exports — generate minimal skeleton
        const skeleton = [
          `(import (jerboa prelude))`,
          `(import (std test))`,
          `(import ${normalizedMod})`,
          `(export ${derivedSuiteName})`,
          '',
          `(define ${derivedSuiteName}`,
          `  (test-suite "${escapeSchemeString(displayName)}"`,
          `    ;; No exports found in ${normalizedMod}`,
          `    ))`,
          '',
          `(run-tests! ${derivedSuiteName})`,
          '(test-report-summary!)',
        ].join('\n');

        return {
          content: [{ type: 'text' as const, text: skeleton }],
        };
      }

      const entries = lines.map((line) => {
        const parts = line.slice(RESULT_MARKER.length).split('\t');
        return {
          name: String(parts[0] || ''),
          kind: String(parts[1] || ''),
          arityMask: parseInt(parts[2] || '0', 10),
        };
      });

      // Generate test cases
      const testCases: string[] = [];
      for (const entry of entries) {
        if (entry.kind === 'procedure') {
          // Arity mask: bit N set means procedure accepts N arguments
          // Mask 2 = bit 1 = 1 arg, mask 4 = bit 2 = 2 args, etc.
          const guessedArity = entry.arityMask > 0
            ? Math.floor(Math.log2(entry.arityMask & -entry.arityMask))
            : 0;
          const argPlaceholders = guessedArity > 0
            ? ' ' + Array.from({ length: guessedArity }, (_, i) => `arg${i + 1}`).join(' ')
            : '';
          testCases.push(
            `    (test-case "${escapeSchemeString(String(entry.name))}"`,
            `      (check (${entry.name}${argPlaceholders}) => ...))`
          );
        } else {
          // value
          testCases.push(
            `    (test-case "${escapeSchemeString(String(entry.name))}"`,
            `      (check ${entry.name} => ...))`
          );
        }
      }

      const testFile = [
        `(import (jerboa prelude))`,
        `(import (std test))`,
        `(import ${normalizedMod})`,
        `(export ${derivedSuiteName})`,
        '',
        `(define ${derivedSuiteName}`,
        `  (test-suite "${escapeSchemeString(displayName)}"`,
        ...testCases,
        `    ))`,
        '',
        `(run-tests! ${derivedSuiteName})`,
        '(test-report-summary!)',
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text: testFile }],
      };
    },
  );
}

function deriveSuiteName(modulePath: string): string {
  // (std text json) → json-test
  // (myproject handler) → handler-test
  const inner = modulePath.replace(/^\(|\)$/g, '').trim();
  const parts = inner.split(/\s+/);
  const last = parts[parts.length - 1] || 'module';
  return `${last}-test`;
}
