import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, escapeSchemeString, ERROR_MARKER, normalizeImport } from '../chez.js';

const RESULT_MARKER = 'JERBOA-MCP-STUB:';

export function registerGenerateModuleStubTool(server: McpServer): void {
  server.registerTool(
    'jerboa_generate_module_stub',
    {
      title: 'Generate Module Stub',
      description:
        'Generate a module skeleton by introspecting an existing module\'s exports and signatures. ' +
        'Produces (define ...) stubs for procedures and values. ' +
        'Does not write to disk — returns the generated text.',
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        module_path: z
          .string()
          .describe(
            'Module to generate a stub from (e.g. "(std text json)", "(myproject handler)")',
          ),
        package_prefix: z
          .string()
          .optional()
          .describe('Package prefix for the generated module (e.g. "myproject")'),
        imports: z
          .array(z.string())
          .optional()
          .describe('Additional import paths to include (e.g. ["(std sort)", "(std test)"])'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ module_path, package_prefix, imports, jerboa_home }) => {
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

      const stdout = result.stdout;
      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        return {
          content: [
            {
              type: 'text' as const,
              text: `Error loading module ${normalizedMod}:\n${errorMsg}`,
            },
          ],
          isError: true,
        };
      }

      // Parse result lines
      const lines = stdout
        .split('\n')
        .filter((l) => l.startsWith(RESULT_MARKER));

      const entries = lines.map((line) => {
        const parts = line.slice(RESULT_MARKER.length).split('\t');
        return {
          name: String(parts[0] || ''),
          kind: String(parts[1] || ''),
          arityMask: parseInt(parts[2] || '0', 10),
        };
      });

      // Build import list
      const importPaths = [normalizedMod];
      if (imports) {
        for (const imp of imports) {
          importPaths.push(normalizeImport(imp));
        }
      }

      // Build export list
      const exportNames = entries.map((e) => e.name);

      // Generate stubs
      const stubs: string[] = [];
      for (const entry of entries) {
        if (entry.kind === 'procedure') {
          // Guess arity from mask: lowest set bit position
          const guessedArity = entry.arityMask > 0
            ? Math.floor(Math.log2(entry.arityMask & -entry.arityMask))
            : 0;
          const args = guessedArity > 0
            ? ' ' + Array.from({ length: guessedArity }, (_, i) => `arg${i + 1}`).join(' ')
            : '';
          stubs.push(`(define (${entry.name}${args})`);
          stubs.push(`  ...)`);
          stubs.push('');
        } else {
          // value
          stubs.push(`(define ${entry.name} ...)`);
          stubs.push('');
        }
      }

      // Assemble the module file
      const sections: string[] = [];

      sections.push(`(import (jerboa prelude))`);
      for (const imp of importPaths) {
        sections.push(`(import ${imp})`);
      }

      if (exportNames.length > 0) {
        sections.push(`(export ${exportNames.join(' ')})`);
      }

      sections.push('');

      if (stubs.length > 0) {
        sections.push(...stubs);
      } else {
        sections.push(`;; No exports found in ${normalizedMod}`);
      }

      return {
        content: [
          { type: 'text' as const, text: sections.join('\n') },
        ],
      };
    },
  );
}
