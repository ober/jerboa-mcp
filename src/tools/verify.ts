import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildSyntaxCheckScript, ERROR_MARKER, VALID_MARKER } from '../chez.js';
import { readFile } from 'node:fs/promises';
import {
  injectHallucinationHints,
  preScanDivergence,
  formatPreScanHits,
} from './shared-hallucinations.js';
import { structureError } from './error-formatter.js';

export function registerVerifyTool(server: McpServer): void {
  server.registerTool(
    'jerboa_verify',
    {
      title: 'Verify Jerboa Code',
      description:
        'Combined syntax + expand check for Jerboa code or a file. ' +
        'Replaces sequential check_syntax → compile_check workflow. ' +
        'Also runs a divergence pre-scan that flags known-wrong identifiers ' +
        'from other Scheme dialects before invoking Chez.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Path to a .ss or .sls file'),
        code: z.string().optional().describe('Code string to verify directly'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory'),
        skip_prescan: z
          .boolean()
          .optional()
          .describe('If true, skip the divergence pre-scan (default: false)'),
      },
    },
    async ({ file_path, code, jerboa_home, skip_prescan }) => {
      let source = code;
      if (file_path && !source) {
        try {
          source = await readFile(file_path, 'utf-8');
        } catch {
          return { content: [{ type: 'text' as const, text: `Cannot read file: ${file_path}` }], isError: true };
        }
      }

      if (!source) {
        return { content: [{ type: 'text' as const, text: 'Provide file_path or code.' }], isError: true };
      }

      const label = file_path ?? 'code';

      // Pre-scan: look for known-wrong identifiers. Errors in the pre-scan
      // are surfaced but do not short-circuit — the user still benefits
      // from Chez's expand-time diagnostics.
      const hits = skip_prescan ? [] : preScanDivergence(source);
      const errorHits = hits.filter((h) => h.severity === 'error');
      const prescanBlock = formatPreScanHits(hits);

      const script = buildSyntaxCheckScript(source);
      const result = await runChez(script, { jerboaHome: jerboa_home, timeout: 60_000 });
      const stdout = result.stdout;

      if (stdout.includes(VALID_MARKER)) {
        // Chez accepted the code. If the pre-scan found error-severity
        // divergences (symbol *would* fail at runtime when executed
        // along a path the compiler didn't exercise), still surface
        // them.
        if (errorHits.length > 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `⚠ ${label}: Chez accepted the code, but the pre-scan flagged ${errorHits.length} divergence issue${errorHits.length === 1 ? '' : 's'}:${prescanBlock}`,
              },
            ],
            isError: true,
          };
        }
        const body = hits.length > 0
          ? `✓ ${label}: No compile issues. ${prescanBlock}`
          : `✓ ${label}: No issues found.`;
        return { content: [{ type: 'text' as const, text: body }] };
      }

      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        const hintMsg = injectHallucinationHints(structureError(errorMsg));
        const body = `✗ ${label}:\n${hintMsg}${prescanBlock}`;
        return { content: [{ type: 'text' as const, text: body }], isError: true };
      }

      const errOut = result.stderr.trim();
      if (errOut) {
        const hintErrOut = injectHallucinationHints(structureError(errOut));
        const body = `✗ ${label}:\n${hintErrOut}${prescanBlock}`;
        return { content: [{ type: 'text' as const, text: body }], isError: true };
      }

      return { content: [{ type: 'text' as const, text: `Unexpected output:\n${stdout.trim()}${prescanBlock}` }], isError: true };
    },
  );
}
