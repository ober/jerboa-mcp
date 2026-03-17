import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { parseDefinitions } from './parse-utils.js';

export function registerLoadFileTool(server: McpServer): void {
  server.registerTool(
    'jerboa_load_file',
    {
      title: 'Analyze Jerboa Source File',
      description:
        'Parse a Jerboa .ss source file and extract its top-level structure: ' +
        'imports, exports, and all defined symbols categorized by type. ' +
        'Does NOT execute the file — pure static analysis.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().describe('Absolute path to a Jerboa source file (e.g. "/path/to/file.ss")'),
      },
    },
    async ({ file_path }) => {
      let contents: string;
      try {
        contents = await readFile(file_path, 'utf-8');
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Failed to read file: ${err instanceof Error ? err.message : 'Unknown error'}` }],
          isError: true,
        };
      }

      if (!contents.trim()) {
        return { content: [{ type: 'text' as const, text: 'File is empty.' }] };
      }

      const analysis = parseDefinitions(contents);

      if (analysis.imports.length === 0 && analysis.exports.length === 0 && analysis.definitions.length === 0) {
        return { content: [{ type: 'text' as const, text: `No top-level definitions found in ${file_path}.` }] };
      }

      const sections: string[] = [`File: ${file_path}`, ''];

      if (analysis.imports.length > 0) {
        sections.push(`Imports (${analysis.imports.length}):`);
        for (const imp of analysis.imports) {
          sections.push(`  ${imp.raw.replace(/\s+/g, ' ')}`);
        }
        sections.push('');
      }

      if (analysis.exports.length > 0) {
        sections.push(`Exports (${analysis.exports.length}):`);
        for (const exp of analysis.exports) {
          sections.push(`  ${exp.raw.replace(/\s+/g, ' ')}`);
        }
        sections.push('');
      }

      if (analysis.definitions.length > 0) {
        sections.push(`Definitions (${analysis.definitions.length}):`);
        for (const def of analysis.definitions) {
          sections.push(`  ${def.name}  (${def.kind})  line ${def.line}`);
        }
      }

      return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
    },
  );
}
