import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { join, extname } from 'node:path';

function runCommand(
  cmd: string,
  args: string[],
  options?: { timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: options?.timeout ?? 30_000,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = typeof error.code === 'number' ? error.code : 1;
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode });
        } else {
          resolve({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 });
        }
      },
    );
  });
}

interface AuditResult {
  registeredSymbols: Array<{ name: string; line: number; file: string }>;
  librarySymbols: Map<string, string>; // symbol -> library file
  missing: Array<{ name: string; library: string }>; // in library but not registered
  dead: Array<{ name: string; line: number; file: string }>; // registered but not in any library
  matched: Array<{ name: string; library: string }>;
}

/**
 * Extract Sforeign_symbol registrations from C source files.
 * Matches patterns like: Sforeign_symbol("symbol_name", symbol_name);
 */
function extractRegistrations(content: string, filePath: string): Array<{ name: string; line: number; file: string }> {
  const results: Array<{ name: string; line: number; file: string }> = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match Sforeign_symbol("name", ...) patterns
    const match = line.match(/Sforeign_symbol\s*\(\s*"([^"]+)"/);
    if (match) {
      results.push({ name: match[1], line: i + 1, file: filePath });
    }
  }

  return results;
}

/**
 * Extract exported symbols from .a or .o files using nm.
 * Returns symbols marked as T (text/code) or D (data).
 */
async function extractLibrarySymbols(libPath: string): Promise<Map<string, string>> {
  const symbols = new Map<string, string>();
  const result = await runCommand('nm', ['--defined-only', '--extern-only', libPath]);

  if (result.exitCode !== 0) return symbols;

  for (const line of result.stdout.split('\n')) {
    // nm output: address type name
    const match = line.match(/^[0-9a-f]*\s+[TtDdBb]\s+(\S+)/);
    if (match) {
      symbols.set(match[1], libPath);
    }
  }

  return symbols;
}

export function registerStaticSymbolAuditTool(server: McpServer): void {
  server.registerTool(
    'jerboa_static_symbol_audit',
    {
      title: 'Static Symbol Audit',
      description:
        'Cross-references Sforeign_symbol() registration calls in C entry point files against ' +
        'actual symbols exported by linked .a/.o files (via nm). Detects: missing registrations ' +
        '(library symbol not registered — causes runtime "foreign-procedure not found"), and dead ' +
        'registrations (registered but symbol no longer exists in any library). ' +
        'Prevents hard-to-debug runtime FFI failures in static Chez binaries.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        entry_files: z.array(z.string()).describe('C source files containing Sforeign_symbol() calls (e.g. main.c)'),
        library_files: z.array(z.string()).describe('Static library (.a) or object (.o) files to check symbols against'),
        symbol_prefix: z.string().optional().describe('Only audit symbols matching this prefix (e.g. "rustls_" or "argon2_")'),
        ignore_symbols: z.array(z.string()).optional().describe('Symbols to ignore (e.g. system symbols always available)'),
      },
    },
    async ({ entry_files, library_files, symbol_prefix, ignore_symbols }) => {
      const ignoreSet = new Set(ignore_symbols ?? []);
      const sections: string[] = [];

      // Step 1: Extract registrations from all entry files
      const allRegistrations: Array<{ name: string; line: number; file: string }> = [];
      for (const ef of entry_files) {
        let content: string;
        try {
          content = await readFile(ef, 'utf-8');
        } catch (err) {
          return {
            content: [{ type: 'text' as const, text: `Cannot read entry file: ${ef}` }],
            isError: true,
          };
        }
        allRegistrations.push(...extractRegistrations(content, ef));
      }

      // Step 2: Extract symbols from all library files
      const allLibrarySymbols = new Map<string, string>();
      for (const lf of library_files) {
        const symbols = await extractLibrarySymbols(lf);
        for (const [name, lib] of symbols) {
          allLibrarySymbols.set(name, lib);
        }
      }

      // Step 3: Filter by prefix if specified
      const registeredNames = new Set(allRegistrations.map(r => r.name));
      const relevantLibSymbols = new Map<string, string>();
      for (const [name, lib] of allLibrarySymbols) {
        if (symbol_prefix && !name.startsWith(symbol_prefix)) continue;
        if (ignoreSet.has(name)) continue;
        relevantLibSymbols.set(name, lib);
      }

      // Step 4: Find missing and dead registrations
      const missing: Array<{ name: string; library: string }> = [];
      for (const [name, lib] of relevantLibSymbols) {
        if (!registeredNames.has(name)) {
          missing.push({ name, library: lib });
        }
      }

      const dead: Array<{ name: string; line: number; file: string }> = [];
      const matched: Array<{ name: string; library: string }> = [];
      for (const reg of allRegistrations) {
        if (ignoreSet.has(reg.name)) continue;
        if (symbol_prefix && !reg.name.startsWith(symbol_prefix)) continue;

        if (allLibrarySymbols.has(reg.name)) {
          matched.push({ name: reg.name, library: allLibrarySymbols.get(reg.name)! });
        } else {
          dead.push(reg);
        }
      }

      // Step 5: Report
      sections.push('Static Symbol Audit');
      sections.push(`Entry files: ${entry_files.join(', ')}`);
      sections.push(`Library files: ${library_files.join(', ')}`);
      if (symbol_prefix) sections.push(`Prefix filter: ${symbol_prefix}`);
      sections.push(`Registered symbols: ${allRegistrations.length}`);
      sections.push(`Library symbols: ${relevantLibSymbols.size}${symbol_prefix ? ` (matching ${symbol_prefix}*)` : ''}`);
      sections.push('');

      if (missing.length === 0 && dead.length === 0) {
        sections.push(`All ${matched.length} symbols matched. No issues found.`);
      } else {
        if (missing.length > 0) {
          sections.push(`MISSING REGISTRATIONS (${missing.length}):`);
          sections.push('These symbols exist in libraries but have no Sforeign_symbol() call.');
          sections.push('They will cause "foreign-procedure not found" at runtime.');
          sections.push('');
          for (const m of missing.sort((a, b) => a.name.localeCompare(b.name))) {
            const shortLib = m.library.split('/').pop();
            sections.push(`  ${m.name}  (in ${shortLib})`);
          }
          sections.push('');
          sections.push('Add to your entry point:');
          for (const m of missing.sort((a, b) => a.name.localeCompare(b.name))) {
            sections.push(`  Sforeign_symbol("${m.name}", ${m.name});`);
          }
          sections.push('');
        }

        if (dead.length > 0) {
          sections.push(`DEAD REGISTRATIONS (${dead.length}):`);
          sections.push('These are registered but no matching symbol exists in any library.');
          sections.push('');
          for (const d of dead.sort((a, b) => a.name.localeCompare(b.name))) {
            const shortFile = d.file.split('/').pop();
            sections.push(`  ${d.name}  (${shortFile}:${d.line})`);
          }
          sections.push('');
        }

        if (matched.length > 0) {
          sections.push(`Matched: ${matched.length} symbols OK`);
        }
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n').trimEnd() }],
        isError: missing.length > 0,
      };
    },
  );
}
