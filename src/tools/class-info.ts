import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, escapeSchemeString, ERROR_MARKER } from '../chez.js';

const RESULT_MARKER = 'JERBOA-MCP-CLASS:';

export function registerClassInfoTool(server: McpServer): void {
  server.registerTool(
    'jerboa_class_info',
    {
      title: 'Inspect Record Types',
      description:
        'Inspect a Chez Scheme / Jerboa record type. Shows the type name, fields, parent RTD, ' +
        'sealed/opaque flags, and constructor signature. Pass the type name as a symbol — ' +
        'the tool imports the module and introspects the RTD at runtime.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        type_name: z.string().describe('Record type name (e.g. "point", "person")'),
        module_path: z
          .string()
          .optional()
          .describe('Module to import to bring the type into scope (e.g. "(std text json)")'),
        jerboa_home: z.string().optional(),
      },
    },
    async ({ type_name, module_path, jerboa_home }) => {
      const escapedName = escapeSchemeString(type_name);
      const preamble = buildPreamble(module_path ? [module_path] : []);

      const code = `${preamble}

(define (show-rtd rtd)
  (display "${RESULT_MARKER}name\\t")
  (display (record-type-name rtd))
  (newline)
  (let ((fields (record-type-field-names rtd)))
    (display "${RESULT_MARKER}fields\\t")
    (if (= (vector-length fields) 0)
      (display "(none)")
      (let loop ((i 0))
        (when (< i (vector-length fields))
          (display (vector-ref fields i))
          (display " ")
          (loop (+ i 1)))))
    (newline))
  (let ((parent (record-type-parent rtd)))
    (display "${RESULT_MARKER}parent\\t")
    (if parent
      (display (record-type-name parent))
      (display "(none)"))
    (newline))
  (display "${RESULT_MARKER}sealed\\t")
  (display (record-type-sealed? rtd))
  (newline)
  (display "${RESULT_MARKER}opaque\\t")
  (display (record-type-opaque? rtd))
  (newline)
  ; Build constructor signature
  (display "${RESULT_MARKER}constructor\\t")
  (display "make-")
  (display (record-type-name rtd))
  (display "(")
  (let ((fields (record-type-field-names rtd)))
    (let loop ((i 0))
      (when (< i (vector-length fields))
        (when (> i 0) (display ", "))
        (display (vector-ref fields i))
        (loop (+ i 1)))))
  (display ")")
  (newline))

(guard (e [else
           (display "${ERROR_MARKER}\\n")
           (display-condition e (current-output-port))])
  (let ((val (eval '${type_name} (interaction-environment))))
    (cond
      ((record-type-descriptor? val)
       (show-rtd val))
      ((record? val)
       (show-rtd (record-type-descriptor val)))
      (else
       (display "${ERROR_MARKER}\\n")
       (display "${escapedName} is not a record type descriptor")))))
`;

      const result = await runChez(code, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Class inspection timed out.' }], isError: true };
      }

      if (result.exitCode !== 0 && !result.stdout.includes(ERROR_MARKER) && !result.stdout.includes(RESULT_MARKER)) {
        return {
          content: [{ type: 'text' as const, text: `Failed to inspect type ${type_name}:\n${result.stderr.trim()}` }],
          isError: true,
        };
      }

      const stdout = result.stdout;
      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        return {
          content: [{ type: 'text' as const, text: `Error inspecting ${type_name}:\n${errorMsg}` }],
          isError: true,
        };
      }

      const lines = stdout.split('\n').filter((l) => l.startsWith(RESULT_MARKER));
      const info: Record<string, string> = {};
      for (const line of lines) {
        const payload = line.slice(RESULT_MARKER.length);
        const tabIdx = payload.indexOf('\t');
        if (tabIdx !== -1) {
          info[payload.slice(0, tabIdx)] = payload.slice(tabIdx + 1).trim();
        }
      }

      if (Object.keys(info).length === 0) {
        return {
          content: [{ type: 'text' as const, text: `${type_name} is not a record type or was not found.` }],
          isError: true,
        };
      }

      const sections: string[] = [`Type: ${info['name'] || type_name} (record)`, ''];
      if (info['fields']) sections.push(`Fields: ${info['fields']}`);
      if (info['parent']) sections.push(`Parent: ${info['parent']}`);
      if (info['sealed']) sections.push(`Sealed: ${info['sealed']}`);
      if (info['opaque']) sections.push(`Opaque: ${info['opaque']}`);
      if (info['constructor']) sections.push(`Constructor: ${info['constructor']}`);

      return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
    },
  );
}
