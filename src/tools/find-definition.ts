import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { scanSchemeFiles } from './parse-utils.js';

const DEF_KEYWORDS = [
  'define', 'def', 'defstruct', 'defclass', 'definterface',
  'defrule', 'defrules', 'defsyntax', 'defsyntax-call', 'defmacro',
  'defmethod', 'defconst', 'definline', 'defvalues', 'defalias', 'deftype', 'def/c', 'def*',
];

export function registerFindDefinitionTool(server: McpServer): void {
  server.registerTool(
    'jerboa_find_definition',
    {
      title: 'Find Symbol Definition',
      description:
        'Search .ss files in a directory for where a Jerboa symbol is defined. ' +
        'Looks for def/define/defstruct/defclass/defmethod forms. ' +
        'Returns file path, line number, and optional source preview.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        symbol: z.string().describe('Symbol name to find (e.g. "my-function", "point")'),
        directory: z.string().describe('Directory to search in'),
        source_preview: z
          .boolean()
          .optional()
          .describe('If true, include a source preview of the definition'),
        preview_lines: z
          .number()
          .optional()
          .describe('Maximum lines for source preview (default: 20)'),
      },
    },
    async ({ symbol, directory, source_preview, preview_lines }) => {
      let files: string[];
      try {
        files = await scanSchemeFiles(directory);
      } catch (err) {
        return {
          content: [{ type: 'text' as const, text: `Error scanning directory: ${err instanceof Error ? err.message : String(err)}` }],
          isError: true,
        };
      }

      if (files.length === 0) {
        return { content: [{ type: 'text' as const, text: `No .ss files found in ${directory}` }] };
      }

      interface FindResult {
        file: string;
        line: number;
        kind: string;
        preview?: string;
      }

      const results: FindResult[] = [];
      const maxLines = preview_lines ?? 20;

      for (const file of files) {
        let content: string;
        try {
          content = await readFile(file, 'utf-8');
        } catch {
          continue;
        }

        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          const trimmed = lines[i].trimStart();
          if (!trimmed.startsWith('(')) continue;

          const rest = trimmed.slice(1); // strip leading '('
          for (const kw of DEF_KEYWORDS) {
            const prefix = kw + ' ';
            if (!rest.startsWith(prefix)) continue;

            const after = rest.slice(prefix.length).trimStart();
            let matchedName: string | null = null;
            let kind = kw;

            // Check for (defXXX (symbol ...) ...) or (defXXX symbol ...)
            // Also check (defmethod (symbol type) ...)
            const nameStr = extractDefNameStr(after);
            if (nameStr === symbol) {
              matchedName = symbol;
            }

            if (matchedName) {
              let preview: string | undefined;
              if (source_preview) {
                preview = extractFormPreview(lines, i, maxLines);
              }
              results.push({ file, line: i + 1, kind, preview });
              break;
            }
          }
        }
      }

      if (results.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `Symbol "${symbol}" not found in ${directory}` }],
        };
      }

      const sections: string[] = [`Found ${results.length} definition(s) for "${symbol}":`, ''];
      for (const r of results) {
        sections.push(`  ${r.file}:${r.line}  (${r.kind})`);
        if (r.preview) {
          sections.push('  ```scheme');
          for (const l of r.preview.split('\n')) {
            sections.push('  ' + l);
          }
          sections.push('  ```');
        }
      }

      return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
    },
  );
}

function extractDefNameStr(after: string): string | null {
  const trimmed = after.trimStart();
  if (!trimmed) return null;

  if (trimmed.startsWith('(')) {
    // (name ...) form — extract first token after '('
    return readToken(trimmed.slice(1));
  }
  if (trimmed.startsWith('{')) {
    // {name type} form — extract first token after '{'
    const tok = readToken(trimmed.slice(1));
    return tok ? (tok.startsWith(':') ? tok.slice(1) : tok) : null;
  }
  return readToken(trimmed);
}

function readToken(text: string): string | null {
  const delimiters = new Set([' ', '\t', '\n', '\r', '(', ')', '[', ']', '{', '}', '"', "'", '`', ',', ';']);
  let i = 0;
  while (i < text.length && !delimiters.has(text[i])) i++;
  const tok = text.slice(0, i);
  return tok.length > 0 ? tok : null;
}

function extractFormPreview(lines: string[], startIdx: number, maxLines: number): string {
  let depth = 0;
  let started = false;
  const result: string[] = [];

  for (let i = startIdx; i < lines.length && result.length < maxLines; i++) {
    const line = lines[i];
    result.push(line);

    for (let j = 0; j < line.length; j++) {
      const ch = line[j];
      if (ch === ';') break;
      if (ch === '"') {
        j++;
        while (j < line.length && line[j] !== '"') {
          if (line[j] === '\\') j++;
          j++;
        }
        continue;
      }
      if (ch === '(' || ch === '[') { depth++; started = true; }
      else if (ch === ')' || ch === ']') {
        depth--;
        if (started && depth <= 0) return result.join('\n');
      }
    }
  }

  if (result.length >= maxLines) result.push('...');
  return result.join('\n');
}
