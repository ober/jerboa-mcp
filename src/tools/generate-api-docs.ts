import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, escapeSchemeString, RESULT_MARKER, ERROR_MARKER, buildPreamble, normalizeImport } from '../chez.js';

export function registerGenerateApiDocsTool(server: McpServer): void {
  server.registerTool(
    'jerboa_generate_api_docs',
    {
      title: 'Generate API Documentation',
      description:
        'Generate markdown API documentation from a Jerboa module\'s exports. ' +
        'Introspects the module to discover exported procedures (with arities), ' +
        'macros, and values, producing a complete API reference document.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        module_path: z.string().describe('Module path to document (e.g. "(std text json)", "(myproject handler)")'),
        title: z
          .string()
          .optional()
          .describe('Title for the documentation (default: derived from module path)'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ module_path, title, jerboa_home }) => {
      const normalizedMod = normalizeImport(module_path);
      const resMarker = RESULT_MARKER;
      const errMarker = ERROR_MARKER;

      // Generate a combined introspection expression that returns exports with their types and arities.
      // We classify each export as PROC (procedure), MACRO (syntax/macro), or VALUE.
      const code = `
(import (jerboa prelude))
(import ${normalizedMod})

(define (inspect-module)
  (guard (e [else
             (display "${errMarker}\\n")
             (display-condition e (current-output-port))])
    (display "${resMarker}\\n")
    (let ((env (the-environment)))
      (environment-for-each env
        (lambda (name val)
          (cond
            ((procedure? val)
             (display "PROC|")
             (display name)
             (display "|")
             (display (procedure-arity-mask val))
             (newline))
            (else
             (display "VALUE|")
             (display name)
             (display "|")
             (display (guard (e [else "?"]) (with-output-to-string (lambda () (write val)))))
             (newline))))))))

(inspect-module)
`;

      const result = await runChez(code, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return {
          content: [{ type: 'text' as const, text: 'Module introspection timed out.' }],
          isError: true,
        };
      }

      const stdout = result.stdout;
      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        return {
          content: [{ type: 'text' as const, text: `Error loading module:\n${errorMsg}` }],
          isError: true,
        };
      }

      const resultIdx = stdout.indexOf(RESULT_MARKER);
      if (resultIdx === -1) {
        // Fallback: try simpler introspection approach
        const simpleCode = `
(import (jerboa prelude))
(import ${normalizedMod})
(display "${resMarker}\\n")
(display "Module loaded successfully.\\n")
`;
        const simpleResult = await runChez(simpleCode, { jerboaHome: jerboa_home });
        const simpleOut = simpleResult.stdout;
        const simpleResultIdx = simpleOut.indexOf(RESULT_MARKER);

        const docTitle = title ?? `API Reference: ${normalizedMod}`;
        const sections: string[] = [];
        sections.push(`# ${docTitle}\n`);
        sections.push(`Module: \`${normalizedMod}\`\n`);
        sections.push(`\`\`\`scheme\n(import ${normalizedMod})\n\`\`\`\n`);

        if (simpleResultIdx !== -1) {
          sections.push('Module loaded successfully. Use `jerboa_module_exports` for detailed export listing.\n');
        } else {
          sections.push('Module could not be introspected.\n');
        }

        return {
          content: [{ type: 'text' as const, text: sections.join('\n') }],
        };
      }

      const lines = stdout
        .slice(resultIdx + RESULT_MARKER.length)
        .trim()
        .split('\n')
        .filter(Boolean);

      // Parse into categories
      const procedures: Array<{ name: string; info: string }> = [];
      const macros: Array<{ name: string }> = [];
      const values: Array<{ name: string; repr: string }> = [];

      for (const line of lines) {
        const parts = line.split('|');
        if (parts.length < 2) continue;
        const kind = parts[0];
        const name = parts[1];
        const extra = parts.slice(2).join('|');

        switch (kind) {
          case 'PROC':
            procedures.push({ name, info: extra });
            break;
          case 'MACRO':
            macros.push({ name });
            break;
          case 'VALUE':
            values.push({ name, repr: extra });
            break;
        }
      }

      // Generate markdown
      const docTitle = title ?? `API Reference: ${normalizedMod}`;
      const sections: string[] = [];

      sections.push(`# ${docTitle}\n`);
      sections.push(`Module: \`${normalizedMod}\`\n`);
      sections.push(`\`\`\`scheme\n(import ${normalizedMod})\n\`\`\`\n`);

      const total = procedures.length + macros.length + values.length;
      sections.push(`**${total} exports**: ${procedures.length} procedures, ${macros.length} macros, ${values.length} values\n`);
      sections.push('---\n');

      if (procedures.length > 0) {
        sections.push('## Procedures\n');
        procedures.sort((a, b) => a.name.localeCompare(b.name));
        for (const p of procedures) {
          sections.push(`### \`${p.name}\`\n`);
          if (p.info && p.info !== '?') {
            sections.push(`Arity mask: \`${p.info}\`\n`);
          }
        }
      }

      if (macros.length > 0) {
        sections.push('## Macros\n');
        macros.sort((a, b) => a.name.localeCompare(b.name));
        for (const m of macros) {
          sections.push(`### \`${m.name}\`\n`);
        }
      }

      if (values.length > 0) {
        sections.push('## Values\n');
        values.sort((a, b) => a.name.localeCompare(b.name));
        for (const v of values) {
          sections.push(`### \`${v.name}\`\n`);
          if (v.repr && v.repr !== '?') {
            const repr = v.repr.length > 200 ? v.repr.slice(0, 200) + '...' : v.repr;
            sections.push(`Value: \`${repr}\`\n`);
          }
        }
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
