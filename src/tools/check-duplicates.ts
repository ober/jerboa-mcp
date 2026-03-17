import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { parseDefinitions } from './parse-utils.js';

export function registerCheckDuplicatesTool(server: McpServer): void {
  server.registerTool(
    'jerboa_check_duplicates',
    {
      title: 'Check Duplicate Definitions',
      description:
        'Fast pre-build check that scans a Jerboa .ss file for duplicate top-level definitions. ' +
        'Reports all binding forms (def, define, defstruct, defclass, defmethod, etc.) that appear ' +
        'more than once, with line numbers. No subprocess needed — pure static analysis.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Path to a Jerboa .ss file to check'),
        code: z.string().optional().describe('Inline code to check (alternative to file_path)'),
      },
    },
    async ({ file_path, code }) => {
      if (!code && !file_path) {
        return {
          content: [{ type: 'text' as const, text: 'Either "code" or "file_path" must be provided.' }],
          isError: true,
        };
      }

      let sourceCode = code || '';
      if (!code && file_path) {
        try {
          sourceCode = await readFile(file_path, 'utf-8');
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Error reading file: ${err instanceof Error ? err.message : String(err)}` }],
            isError: true,
          };
        }
      }

      const analysis = parseDefinitions(sourceCode);
      const seen = new Map<string, { line: number; kind: string }>();
      const duplicates: Array<{
        name: string;
        firstLine: number;
        firstKind: string;
        duplicateLine: number;
        duplicateKind: string;
      }> = [];

      for (const def of analysis.definitions) {
        const existing = seen.get(def.name);
        if (existing) {
          duplicates.push({
            name: def.name,
            firstLine: existing.line,
            firstKind: existing.kind,
            duplicateLine: def.line,
            duplicateKind: def.kind,
          });
        } else {
          seen.set(def.name, { line: def.line, kind: def.kind });
        }
      }

      if (duplicates.length === 0) {
        return {
          content: [{
            type: 'text' as const,
            text: `No duplicate definitions found (${analysis.definitions.length} definitions checked).`,
          }],
        };
      }

      const sections: string[] = [`Found ${duplicates.length} duplicate definition(s):`, ''];
      for (const dup of duplicates) {
        sections.push(
          `  "${dup.name}" (${dup.duplicateKind}) at line ${dup.duplicateLine} — ` +
          `first defined (${dup.firstKind}) at line ${dup.firstLine}`,
        );
      }
      sections.push('');
      sections.push('Remove or rename the duplicate definitions before building.');

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
        isError: true,
      };
    },
  );
}
