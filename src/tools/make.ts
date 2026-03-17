import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { runMake } from '../chez.js';

export function registerMakeTool(server: McpServer): void {
  server.registerTool(
    'jerboa_make',
    {
      title: 'Run Makefile Target',
      description:
        'Run a Makefile target in a Jerboa project directory. ' +
        'Returns structured output with exit code, stdout, and stderr. ' +
        'Defaults to the default target if none specified.',
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        project_path: z
          .string()
          .describe('Directory containing the Makefile'),
        target: z
          .string()
          .optional()
          .describe(
            'Make target to run (e.g. "build", "clean", "install"). Defaults to the default target.',
          ),
        timeout: z
          .number()
          .optional()
          .describe('Timeout in milliseconds (default: 120000)'),
      },
    },
    async ({ project_path, target, timeout }) => {
      // Check that the Makefile exists
      const makefilePath = join(project_path, 'Makefile');
      try {
        await access(makefilePath, constants.R_OK);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No Makefile found in ${project_path}`,
            },
          ],
          isError: true,
        };
      }

      const makeTimeout = timeout ?? 120_000;
      const result = await runMake(target ?? '', project_path, { timeout: makeTimeout });

      if (result.timedOut) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `make timed out after ${Math.round(makeTimeout / 1000)} seconds.`,
            },
          ],
          isError: true,
        };
      }

      if (result.exitCode === 127) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'make not found. Ensure GNU Make is installed and in PATH.',
            },
          ],
          isError: true,
        };
      }

      const output = [result.stdout, result.stderr]
        .filter(Boolean)
        .join('\n')
        .trim();

      const targetStr = target ?? '(default)';

      if (result.exitCode === 0) {
        const sections = [`make ${targetStr} succeeded.`];
        if (output) {
          sections.push('', output);
        }
        return {
          content: [{ type: 'text' as const, text: sections.join('\n') }],
        };
      }

      return {
        content: [
          {
            type: 'text' as const,
            text: `make ${targetStr} failed (exit code ${result.exitCode}):\n\n${output}`,
          },
        ],
        isError: true,
      };
    },
  );
}
