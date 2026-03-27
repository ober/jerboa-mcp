import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  runChez,
  buildSyntaxCheckScript,
  buildIsolatedCompileCheckScript,
  ERROR_MARKER,
  VALID_MARKER,
} from '../chez.js';
import { readFile } from 'node:fs/promises';

/**
 * Detect whether source code should use the Chez reader instead of jerboa-read.
 * Files starting with #!chezscheme or .sls library files use brackets in
 * syntax-case patterns, which jerboa-read incorrectly converts to (list ...).
 */
function shouldUseChezReader(source: string, filePath?: string): boolean {
  // Explicit #!chezscheme directive
  if (source.trimStart().startsWith('#!chezscheme')) return true;

  // .sls files are Chez library files — use Chez reader
  if (filePath && filePath.endsWith('.sls')) return true;

  return false;
}

/**
 * Detect whether source code is a library form that should be compiled
 * in isolation (without importing the prelude).
 */
function isLibraryForm(source: string): boolean {
  const trimmed = source.trimStart();
  // Skip #!chezscheme directive
  const afterDirective = trimmed.startsWith('#!')
    ? trimmed.slice(trimmed.indexOf('\n') + 1).trimStart()
    : trimmed;
  return afterDirective.startsWith('(library ');
}

export function registerCompileCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_compile_check',
    {
      title: 'Compile-Check Jerboa File',
      description:
        'Check a Jerboa .ss/.sls file for compile errors by expanding all top-level forms. ' +
        'Catches unbound identifiers and macro errors beyond syntax checking. ' +
        'Automatically detects #!chezscheme files and .sls libraries, using the Chez reader ' +
        'instead of jerboa-read (avoids false errors from bracket syntax in syntax-case). ' +
        'Library files are compiled in isolation without importing the prelude, so compile-check ' +
        'works even when the prelude has errors.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Path to a .ss or .sls file to check'),
        code: z.string().optional().describe('Code string to check directly'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory'),
        force_chez_reader: z.coerce.boolean().optional().describe('Force use of Chez reader instead of jerboa-read'),
        force_isolated: z.coerce.boolean().optional().describe('Force isolated compilation (no prelude import)'),
      },
    },
    async ({ file_path, code, jerboa_home, force_chez_reader, force_isolated }) => {
      let source = code;
      if (file_path && !source) {
        try {
          source = await readFile(file_path, 'utf-8');
        } catch (e) {
          return { content: [{ type: 'text' as const, text: `Cannot read file: ${file_path}` }], isError: true };
        }
      }

      if (!source) {
        return { content: [{ type: 'text' as const, text: 'Provide file_path or code.' }], isError: true };
      }

      // Determine compilation strategy
      const useChezReader = force_chez_reader || shouldUseChezReader(source, file_path);
      const useIsolated = force_isolated || isLibraryForm(source);

      let script: string;
      let mode: string;

      if (useIsolated || useChezReader) {
        // Isolated compilation: no prelude, appropriate reader
        script = buildIsolatedCompileCheckScript(source, useChezReader);
        mode = useChezReader ? 'chez-reader/isolated' : 'jerboa-reader/isolated';
      } else {
        // Standard: full prelude + jerboa reader
        script = buildSyntaxCheckScript(source);
        mode = 'jerboa-reader/prelude';
      }

      const result = await runChez(script, { jerboaHome: jerboa_home, timeout: 60_000 });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Compile check timed out.' }], isError: true };
      }

      const stdout = result.stdout;

      if (stdout.includes(VALID_MARKER)) {
        const label = file_path ? file_path : 'code';
        return { content: [{ type: 'text' as const, text: `No errors found in ${label}. (mode: ${mode})` }] };
      }

      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        return { content: [{ type: 'text' as const, text: `Error (mode: ${mode}):\n${errorMsg}` }], isError: true };
      }

      const errOut = result.stderr.trim();
      if (errOut) {
        return { content: [{ type: 'text' as const, text: `Error (mode: ${mode}):\n${errOut}` }], isError: true };
      }

      return { content: [{ type: 'text' as const, text: `Unexpected output (mode: ${mode}):\n${stdout.trim()}` }], isError: true };
    },
  );
}
