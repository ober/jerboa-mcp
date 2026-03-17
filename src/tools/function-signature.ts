import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, ERROR_MARKER } from '../chez.js';

const ARITY_MARKER = 'JERBOA-MCP-ARITY:';

export function registerFunctionSignatureTool(server: McpServer): void {
  server.registerTool(
    'jerboa_function_signature',
    {
      title: 'Function Signature',
      description: 'Check procedure arity and argument information for a Jerboa/Chez function.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        symbol: z.string().describe('Symbol name (e.g. "sort", "hash-ref")'),
        imports: z.array(z.string()).optional().describe('Modules to import to find the symbol'),
        jerboa_home: z.string().optional(),
      },
    },
    async ({ symbol, imports, jerboa_home }) => {
      const script = buildPreamble(imports) + `
(guard (e [else (display "${ERROR_MARKER}\\n") (display-condition e (current-output-port))])
  (let ([proc ${symbol}])
    (if (procedure? proc)
      (let ([mask (procedure-arity-mask proc)])
        (display "${ARITY_MARKER}")
        (display mask)
        (newline))
      (begin
        (display "${ARITY_MARKER}not-a-procedure")
        (newline)))))
`;

      const result = await runChez(script, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Timed out.' }], isError: true };
      }

      const stdout = result.stdout;

      if (stdout.includes(ERROR_MARKER)) {
        const errorMsg = stdout.slice(stdout.indexOf(ERROR_MARKER) + ERROR_MARKER.length).trim();
        return { content: [{ type: 'text' as const, text: `Error: ${errorMsg}` }], isError: true };
      }

      const arityLine = stdout.split('\n').find(l => l.startsWith(ARITY_MARKER));
      if (!arityLine) {
        return { content: [{ type: 'text' as const, text: `Could not find ${symbol}.` }], isError: true };
      }

      const arityStr = arityLine.slice(ARITY_MARKER.length).trim();
      if (arityStr === 'not-a-procedure') {
        return { content: [{ type: 'text' as const, text: `${symbol} is not a procedure.` }] };
      }

      const mask = parseInt(arityStr, 10);
      const arities: number[] = [];
      for (let i = 0; i < 20; i++) {
        if (mask & (1 << i)) arities.push(i);
      }
      const variadic = mask < 0 || mask > (1 << 20);

      let arityDesc: string;
      if (arities.length === 1 && !variadic) {
        arityDesc = `exactly ${arities[0]} argument(s)`;
      } else if (arities.length > 1 && !variadic) {
        arityDesc = `${arities.join(' or ')} arguments`;
      } else if (variadic) {
        // For negative mask: the minimum required args is the number of bits set in the magnitude
        // Chez encodes variadic as negative: -(min+1) or using high bits
        const minArgs = arities.length > 0 ? Math.min(...arities) : 0;
        arityDesc = `${minArgs} or more arguments (variadic, arity mask: ${mask})`;
      } else {
        arityDesc = `arity mask: ${mask}`;
      }

      return { content: [{ type: 'text' as const, text: `${symbol}: accepts ${arityDesc}` }] };
    },
  );
}
