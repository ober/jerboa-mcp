import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { runChez, escapeSchemeString, ERROR_MARKER } from '../chez.js';

const FORM_MARKER = 'JERBOA-MCP-FORM:';
const READ_ERROR_MARKER = 'JERBOA-MCP-READ-ERROR:';

interface FormInfo {
  index: number;
  startLine: number;
  endLine: number;
  summary: string;
}

function buildReadFormsExpr(escaped: string): string {
  // Scheme code that reads all forms from a string port, tracking line numbers.
  // For each form, outputs: MARKER index \t startLine \t endLine \t summary
  return [
    '(import (jerboa prelude))',
    '(let* ((src "' + escaped + '")',
    '       (port (open-input-string src))',
    '       (idx 0))',
    '  (let loop ()',
    '    (let ((start-line (port-line port)))',
    '      (guard (e [else',
    '               (let ((eline (port-line port))',
    '                     (ecol (port-column port)))',
    '                 (display "' + READ_ERROR_MARKER + '")',
    '                 (display eline) (display "\\t")',
    '                 (display ecol) (display "\\t")',
    '                 (display (condition/report-string e))',
    '                 (newline))])',
    '        (let ((form (read port)))',
    '          (if (eof-object? form)',
    '            (void)',
    '            (let ((end-line (port-line port))',
    '                  (summary (cond',
    '                             ((pair? form)',
    '                              (let ((hd (car form)))',
    '                                (if (symbol? hd)',
    '                                  (symbol->string hd)',
    '                                  "(...)" )))',
    '                             ((symbol? form) (symbol->string form))',
    '                             ((string? form) "\\"...\\"" )',
    '                             ((number? form) (number->string form))',
    '                             ((boolean? form) (if form "#t" "#f"))',
    '                             (else (format #f "~s" form)))))',
    '              (display "' + FORM_MARKER + '")',
    '              (display idx) (display "\\t")',
    '              (display start-line) (display "\\t")',
    '              (display end-line) (display "\\t")',
    '              (display summary) (newline)',
    '              (set! idx (+ idx 1))',
    '              (loop)))))))',
  ].join('\n');
}

function parseFormLines(output: string): { forms: FormInfo[]; error: string | null } {
  const forms: FormInfo[] = [];
  let error: string | null = null;

  for (const line of output.split('\n')) {
    if (line.startsWith(FORM_MARKER)) {
      const rest = line.slice(FORM_MARKER.length);
      const parts = rest.split('\t');
      if (parts.length >= 4) {
        forms.push({
          index: parseInt(parts[0], 10),
          startLine: parseInt(parts[1], 10),
          endLine: parseInt(parts[2], 10),
          summary: parts.slice(3).join('\t').trim(),
        });
      }
    } else if (line.startsWith(READ_ERROR_MARKER)) {
      const rest = line.slice(READ_ERROR_MARKER.length);
      const parts = rest.split('\t');
      if (parts.length >= 3) {
        error = `Reader error at line ${parts[0]}, col ${parts[1]}: ${parts.slice(2).join('\t').trim()}`;
      } else {
        error = `Reader error: ${rest.trim()}`;
      }
    }
  }

  return { forms, error };
}

export function registerReadFormsTool(server: McpServer): void {
  server.registerTool(
    'jerboa_read_forms',
    {
      title: 'Read Top-Level Forms',
      description:
        'Read a Jerboa source file using the actual Chez Scheme reader and list all top-level forms ' +
        'with their index, start/end line numbers, and a summary (car of list or type). ' +
        'On reader error, reports the error position plus any forms read before the error.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        file_path: z
          .string()
          .describe('Path to a Jerboa source file to read'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (containing lib/)'),
      },
    },
    async ({ file_path, jerboa_home }) => {
      let source: string;
      try {
        source = await readFile(file_path, 'utf-8');
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Unknown error';
        return {
          content: [{ type: 'text' as const, text: `Failed to read file: ${msg}` }],
          isError: true,
        };
      }

      if (!source.trim()) {
        return {
          content: [{ type: 'text' as const, text: 'File is empty — no forms to read.' }],
        };
      }

      const escaped = escapeSchemeString(source);
      const code = buildReadFormsExpr(escaped);
      const result = await runChez(code, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return {
          content: [{ type: 'text' as const, text: 'Reader timed out.' }],
          isError: true,
        };
      }

      // Check for Chez-level errors that prevented reading at all
      const errorIdx = result.stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1 && !result.stdout.includes(FORM_MARKER) && !result.stdout.includes(READ_ERROR_MARKER)) {
        const errorMsg = result.stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        return {
          content: [{ type: 'text' as const, text: `Reader error:\n${errorMsg}` }],
          isError: true,
        };
      }

      const { forms, error } = parseFormLines(result.stdout);

      const sections: string[] = [`File: ${file_path}`, ''];

      if (forms.length > 0) {
        sections.push(`Forms (${forms.length}):`);
        for (const f of forms) {
          const lineRange =
            f.startLine === f.endLine
              ? `L${f.startLine}`
              : `L${f.startLine}-${f.endLine}`;
          sections.push(`  [${f.index}] ${lineRange}: (${f.summary} ...)`);
        }
      }

      if (error) {
        sections.push('');
        sections.push(error);
      }

      if (forms.length === 0 && !error) {
        sections.push('No forms found.');
      }

      const hasError = !!error;
      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
        isError: hasError,
      };
    },
  );
}
