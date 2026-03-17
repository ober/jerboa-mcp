import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, escapeSchemeString, ERROR_MARKER } from '../chez.js';

const INFO_MARKER = 'JERBOA-MCP-INFO:';

export function registerDocTool(server: McpServer): void {
  server.registerTool(
    'jerboa_doc',
    {
      title: 'Symbol Documentation',
      description:
        'Look up info about a Jerboa/Chez Scheme symbol: its type (procedure/macro/record/value), ' +
        'arity, and description. Optionally import a module to bring the symbol into scope. ' +
        'Example: symbol "sort" with module_path "(std sort)".',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        symbol: z.string().describe('Symbol name to look up (e.g. "sort", "read-json")'),
        module_path: z
          .string()
          .optional()
          .describe('Module to import for context (e.g. "(std text json)"). If omitted, searches current environment.'),
        jerboa_home: z.string().optional(),
      },
    },
    async ({ symbol, module_path, jerboa_home }) => {
      const escapedSym = escapeSchemeString(symbol);
      const preamble = buildPreamble(module_path ? [module_path] : []);

      const code = `${preamble}

(guard (e [else
           (display "${ERROR_MARKER}\\n")
           (display-condition e (current-output-port))])
  (let ((val (eval '${symbol} (interaction-environment))))
    (cond
      ((procedure? val)
       (display "${INFO_MARKER}kind\\tprocedure\\n")
       (display "${INFO_MARKER}name\\t${escapedSym}\\n")
       ; Try to get arity via procedure-arity if available
       (guard (e2 [else (void)])
         (let ((arity (procedure-arity val)))
           (display "${INFO_MARKER}arity\\t")
           (write arity)
           (newline))))
      ((record-type-descriptor? val)
       (display "${INFO_MARKER}kind\\trecord-type\\n")
       (display "${INFO_MARKER}name\\t")
       (display (record-type-name val))
       (newline)
       (display "${INFO_MARKER}fields\\t")
       (let ((fields (record-type-field-names val)))
         (let loop ((i 0))
           (when (< i (vector-length fields))
             (display (vector-ref fields i))
             (display " ")
             (loop (+ i 1)))))
       (newline))
      (else
       (display "${INFO_MARKER}kind\\tvalue\\n")
       (display "${INFO_MARKER}name\\t${escapedSym}\\n")
       (display "${INFO_MARKER}value\\t")
       (write val)
       (newline)))))
`;

      const result = await runChez(code, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Symbol lookup timed out.' }], isError: true };
      }

      const stdout = result.stdout;

      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        return {
          content: [{ type: 'text' as const, text: `Error looking up "${symbol}":\n${errorMsg}` }],
          isError: true,
        };
      }

      const infoLines = stdout.split('\n').filter((l) => l.startsWith(INFO_MARKER));

      if (infoLines.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No information found for symbol "${symbol}".` }],
        };
      }

      const info: Record<string, string> = {};
      for (const line of infoLines) {
        const payload = line.slice(INFO_MARKER.length);
        const tabIdx = payload.indexOf('\t');
        if (tabIdx === -1) continue;
        info[payload.slice(0, tabIdx)] = payload.slice(tabIdx + 1).trim();
      }

      const sections: string[] = [`Symbol: ${symbol}`, ''];
      if (info['kind']) sections.push(`Kind: ${info['kind']}`);
      if (info['name'] && info['name'] !== symbol) sections.push(`Name: ${info['name']}`);
      if (info['arity']) sections.push(`Arity: ${info['arity']}`);
      if (info['fields']) sections.push(`Fields: ${info['fields']}`);
      if (info['value']) sections.push(`Value: ${info['value']}`);
      if (module_path) sections.push(`Module: ${module_path}`);

      return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
    },
  );
}
