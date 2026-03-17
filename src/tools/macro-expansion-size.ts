import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, ERROR_MARKER, escapeSchemeString } from '../chez.js';

const EXPANDED_MARKER = 'JERBOA-EXPANDED:';

/**
 * Count approximate tokens in a Scheme source string.
 * Splits on whitespace and paren/bracket/brace boundaries.
 */
function countTokens(src: string): number {
  // Tokenize by splitting on whitespace and treating each paren/bracket/brace as its own token
  const tokenized = src.replace(/[()[\]{}]/g, ' $& ');
  return tokenized
    .split(/\s+/)
    .filter((t) => t.length > 0).length;
}

function warningLevel(ratio: number): string {
  if (ratio >= 50) return 'EXPLOSIVE (>= 50x) — consider rewriting as a function';
  if (ratio >= 10) return 'LARGE (>= 10x) — review macro for accidental duplication';
  return 'OK';
}

export function registerMacroExpansionSizeTool(server: McpServer): void {
  server.registerTool(
    'jerboa_macro_expansion_size',
    {
      title: 'Macro Expansion Size',
      description:
        'Analyze macro expansion size to detect accidentally explosive macros. ' +
        'Expands a macro invocation and compares the number of tokens in the source vs expanded output. ' +
        'Reports expansion ratio and warns if > 10x (large) or > 50x (explosive).',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        expression: z
          .string()
          .describe('The macro invocation to analyze (e.g. "(my-macro arg1 arg2)")'),
        imports: z
          .array(z.string())
          .optional()
          .describe('Modules to import for macro context'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ expression, imports, jerboa_home }) => {
      const escaped = escapeSchemeString(expression);
      const preamble = buildPreamble(imports);

      const script = `${preamble}

(guard (e [else (display "${ERROR_MARKER}\\n") (display-condition e (current-output-port))])
  (let* ([src-expr (read (open-string-input-port "${escaped}"))]
         [expanded (expand src-expr)]
         [port (open-output-string)])
    (parameterize ([current-output-port port])
      (pretty-print expanded))
    (display "${EXPANDED_MARKER}")
    (display (get-output-string port))
    (display "${EXPANDED_MARKER}")))
`;

      const result = await runChez(script, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Expansion timed out.' }], isError: true };
      }

      const stdout = result.stdout;

      if (stdout.includes(ERROR_MARKER)) {
        const msg = stdout.slice(stdout.indexOf(ERROR_MARKER) + ERROR_MARKER.length).trim();
        return { content: [{ type: 'text' as const, text: `Error:\n${msg}` }], isError: true };
      }

      if (result.exitCode !== 0 && !stdout.trim()) {
        return { content: [{ type: 'text' as const, text: `Failed: ${result.stderr.trim()}` }], isError: true };
      }

      // Extract expanded text from markers
      const startIdx = stdout.indexOf(EXPANDED_MARKER);
      if (startIdx === -1) {
        return { content: [{ type: 'text' as const, text: `Unexpected output:\n${stdout.trim()}` }], isError: true };
      }

      const afterStart = stdout.slice(startIdx + EXPANDED_MARKER.length);
      const endIdx = afterStart.indexOf(EXPANDED_MARKER);
      const expandedText = endIdx !== -1 ? afterStart.slice(0, endIdx) : afterStart;

      const sourceTokens = countTokens(expression);
      const expandedTokens = countTokens(expandedText);
      const ratio = sourceTokens > 0 ? expandedTokens / sourceTokens : expandedTokens;
      const ratioDisplay = ratio.toFixed(1);
      const warning = warningLevel(ratio);

      const sections: string[] = [
        `Macro Expansion Size Analysis`,
        ``,
        `Source:   ${sourceTokens} tokens`,
        `Expanded: ${expandedTokens} tokens`,
        `Ratio:    ${ratioDisplay}x  [${warning}]`,
        ``,
        `Expanded form:`,
        expandedText.trim(),
      ];

      return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
    },
  );
}
