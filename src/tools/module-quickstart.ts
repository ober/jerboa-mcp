import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, normalizeImport } from '../chez.js';

export function registerModuleQuickstartTool(server: McpServer): void {
  server.registerTool(
    'jerboa_module_quickstart',
    {
      title: 'Module Quickstart',
      description:
        'Generate a working example file that exercises a module\'s main exports. ' +
        'Introspects the module to discover exports, arities, and types, then generates ' +
        'a runnable .ss file demonstrating usage. Useful for undocumented stdlib modules.',
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        module_path: z
          .string()
          .describe('Module path (e.g. (std text json), (std sort))'),
        max_exports: z
          .number()
          .optional()
          .describe('Maximum number of exports to include (default: 10)'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ module_path, max_exports, jerboa_home }) => {
      const limit = max_exports || 10;
      const normalizedMod = normalizeImport(module_path);

      // Step 1: Get module exports with arity info
      const code = `
(import (jerboa prelude))
(import ${normalizedMod})

(let ((results '()))
  (let ((env (the-environment)))
    (environment-for-each env
      (lambda (name val)
        (guard (e [else (void)])
          (let ((info (cond ((procedure? val)
                             (list name "procedure" (procedure-arity-mask val)))
                            (else (list name "value" 0)))))
            (set! results (cons info results)))))))
  (let* ((sorted (sort results (lambda (a b) (string<? (symbol->string (car a)) (symbol->string (car b))))))
         (limited (if (> (length sorted) ${limit}) (list-head sorted ${limit}) sorted)))
    (display "EXPORTS:\\n")
    (for-each (lambda (entry) (write entry) (newline)) limited)
    (display "TOTAL:") (display (length results)) (newline)))
`;

      const result = await runChez(code, { timeout: 15000, jerboaHome: jerboa_home });
      const output = result.stdout + result.stderr;

      // Parse export info
      const exportLines = output.split('\n').filter((l) => l.startsWith('('));
      const total = output.match(/TOTAL:(\d+)/)?.[1] || '?';

      if (exportLines.length === 0) {
        // Fallback: simpler approach
        const simpleCode = `
(import (jerboa prelude))
(import ${normalizedMod})
(display "Module loaded: ${normalizedMod}\\n")
`;
        const simpleResult = await runChez(simpleCode, { timeout: 10000, jerboaHome: jerboa_home });
        const loadOk = simpleResult.exitCode === 0;

        return {
          content: [
            {
              type: 'text' as const,
              text: `## Module Quickstart: ${normalizedMod}\n\n` +
                `Module ${loadOk ? 'loads successfully' : 'failed to load'}.\n\n` +
                `Could not introspect exports. Use jerboa_module_exports for detailed export listing.\n\n` +
                '```scheme\n' +
                `(import (jerboa prelude))\n` +
                `(import ${normalizedMod})\n` +
                `;; Use jerboa_module_exports to discover available functions\n` +
                '```',
            },
          ],
        };
      }

      // Generate example file
      const sections: string[] = [
        `## Module Quickstart: ${normalizedMod}`,
        '',
        `Total exports: ${total} (showing top ${Math.min(exportLines.length, limit)})`,
        '',
        '```scheme',
        `;;; Quickstart example for ${normalizedMod}`,
        `(import (jerboa prelude))`,
        `(import ${normalizedMod})`,
        '',
      ];

      const procs: string[] = [];
      const values: string[] = [];

      for (const line of exportLines) {
        // Parse (name "type" arity)
        const match = line.match(/\((\S+)\s+"(\w+)"\s+(.+)\)/);
        if (match) {
          const name = match[1];
          const type = match[2];
          if (type === 'procedure') {
            procs.push(name);
            sections.push(`;;; ${name} — procedure`);
            sections.push(`; (${name} ...)`);
            sections.push('');
          } else {
            values.push(name);
            sections.push(`;;; ${name} — value`);
            sections.push(`; ${name}`);
            sections.push('');
          }
        }
      }

      sections.push('```');
      sections.push('');
      sections.push('### Available Procedures');
      if (procs.length > 0) {
        sections.push(procs.map((p) => `- \`${p}\``).join('\n'));
      } else {
        sections.push('None found');
      }

      if (values.length > 0) {
        sections.push('');
        sections.push('### Available Values');
        sections.push(values.map((v) => `- \`${v}\``).join('\n'));
      }

      sections.push('');
      sections.push(
        '**Tip**: Use `jerboa_function_signature` to check arities before calling, ' +
        'and `jerboa_dynamic_reference` for full module documentation.',
      );

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
