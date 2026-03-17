import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, normalizeImport } from '../chez.js';

export function registerDynamicReferenceTool(server: McpServer): void {
  server.registerTool(
    'jerboa_dynamic_reference',
    {
      title: 'Dynamic Module Reference',
      description:
        'Auto-generate reference documentation for any Jerboa module on demand. ' +
        'Introspects all exports, classifies them (procedure/value/constant), ' +
        'includes arity masks, and formats as markdown.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        module_path: z
          .string()
          .describe('Module path (e.g. (std text json), (std sort), (jerboa prelude))'),
        include_signatures: z
          .boolean()
          .optional()
          .describe('Include function arity information (default: true)'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ module_path, include_signatures, jerboa_home }) => {
      const withSigs = include_signatures !== false;
      const normalizedMod = normalizeImport(module_path);

      // Get export names with type classification
      const code = `
(import (jerboa prelude))
(import ${normalizedMod})

(let ((env (the-environment)))
  (environment-for-each env
    (lambda (name val)
      (display "EXPORT:")
      (display name)
      (display " ")
      (display (cond ((procedure? val) "procedure")
                     ((number? val) "constant")
                     ((string? val) "constant")
                     ((boolean? val) "constant")
                     (else "value")))
      (when (and ${withSigs ? '#t' : '#f'} (procedure? val))
        (display " ")
        (display (procedure-arity-mask val)))
      (newline)))
  (display "TOTAL:")
  (display (let ((count 0))
    (environment-for-each env (lambda (n v) (set! count (+ count 1))))
    count))
  (newline))
`;

      let result;
      try {
        result = await runChez(code, { timeout: 15000, jerboaHome: jerboa_home });
      } catch (e) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to introspect module ${normalizedMod}: ${e}`,
          }],
          isError: true,
        };
      }

      const output = result.stdout + result.stderr;
      const exportLines = output.split('\n')
        .filter((l) => l.startsWith('EXPORT:'))
        .map((l) => l.slice(7));
      const total = output.match(/TOTAL:(\d+)/)?.[1] || '?';

      if (exportLines.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `Could not introspect exports for ${normalizedMod}.\n` +
              'The module may not exist or may require special loading.',
          }],
          isError: true,
        };
      }

      // Parse entries and classify
      const procs: Array<{ name: string; arity: string }> = [];
      const constants: Array<{ name: string }> = [];
      const values: Array<{ name: string }> = [];

      for (const line of exportLines) {
        // Format: "name kind [arity]"
        const parts = line.trim().split(' ');
        if (parts.length < 2) continue;
        const name = parts[0];
        const kind = parts[1];
        const arity = parts[2] || '';
        if (!name) continue;

        switch (kind) {
          case 'procedure':
            procs.push({ name, arity });
            break;
          case 'constant':
            constants.push({ name });
            break;
          case 'value':
            values.push({ name });
            break;
        }
      }

      // Format as markdown reference
      const sections: string[] = [
        `# ${normalizedMod} — API Reference`,
        '',
        `*Auto-generated reference documentation*`,
        '',
        `Total exports: ${total}`,
        `- Procedures: ${procs.length}`,
        `- Constants: ${constants.length}`,
        `- Values: ${values.length}`,
        '',
      ];

      if (procs.length > 0) {
        sections.push('## Procedures');
        sections.push('');
        sections.push('| Name | Arity Mask |');
        sections.push('|------|-----------|');
        for (const p of procs) {
          sections.push(`| \`${p.name}\` | ${p.arity || '—'} |`);
        }
        sections.push('');
      }

      if (constants.length > 0) {
        sections.push('## Constants');
        sections.push('');
        for (const c of constants) {
          sections.push(`- \`${c.name}\``);
        }
        sections.push('');
      }

      if (values.length > 0) {
        sections.push('## Values');
        sections.push('');
        for (const v of values) {
          sections.push(`- \`${v.name}\``);
        }
        sections.push('');
      }

      sections.push('---');
      sections.push('');
      sections.push(`*Use \`jerboa_function_signature\` to check exact arities.*`);

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
