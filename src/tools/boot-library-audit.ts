import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import { runChez, getJerboaHome, getLibdirs } from '../chez.js';

interface AuditResult {
  bootLibraries: string[];
  transitiveImports: string[];
  missing: string[];
  deadWeight: string[];
  matched: string[];
}

/**
 * Extract library names from a boot file script.
 * Looks for patterns like:
 *   (compile-library "lib/std/sort.sls" ...)
 *   "lib/std/sort.sls"
 *   (std sort)
 * in typical static build scripts.
 */
function extractBootLibraries(content: string): string[] {
  const libs: string[] = [];

  // Pattern 1: Quoted module paths like "std/sort" or "jerboa/prelude"
  const quotedPaths = content.matchAll(/"([a-zA-Z][a-zA-Z0-9_/.-]+)"/g);
  for (const m of quotedPaths) {
    const path = m[1];
    // Filter to look like module paths
    if (path.includes('/') && !path.endsWith('.c') && !path.endsWith('.h') &&
        !path.startsWith('http') && !path.startsWith('/')) {
      // Normalize: strip lib/ prefix and .sls/.ss suffix
      let normalized = path.replace(/^lib\//, '').replace(/\.(sls|ss)$/, '');
      libs.push(normalized);
    }
  }

  // Pattern 2: S-expression module paths like (std sort), (jerboa prelude)
  const sexpPaths = content.matchAll(/\(\s*(std\s+[a-zA-Z0-9_ -]+|jerboa\s+[a-zA-Z0-9_ -]+|chezscheme[^)]*)\s*\)/g);
  for (const m of sexpPaths) {
    const modPath = m[1].trim().replace(/\s+/g, '/');
    if (!libs.includes(modPath)) {
      libs.push(modPath);
    }
  }

  return [...new Set(libs)];
}

/**
 * Normalize a module path to a consistent form for comparison.
 * "std/sort" and "std sort" should match.
 */
function normalizeModPath(path: string): string {
  return path.replace(/\s+/g, '/').replace(/^lib\//, '').replace(/\.(sls|ss)$/, '');
}

export function registerBootLibraryAuditTool(server: McpServer): void {
  server.registerTool(
    'jerboa_boot_library_audit',
    {
      title: 'Boot Library Audit',
      description:
        'Audits a Chez static build script\'s library list against the transitive import closure ' +
        'of the entry point module. Detects: missing libraries (imported transitively but not in ' +
        'boot list — causes runtime "library not found"), and dead-weight libraries (in boot list ' +
        'but never transitively imported). Walks the import graph using jerboa_module_deps logic. ' +
        'Prevents the common static-build bug of forgetting a transitive dependency.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        build_script: z.string().describe('Path to the static build script (e.g. build-static.ss or Makefile)'),
        entry_module: z.string().describe('Entry point module path (e.g. "my-app/main" or "(my-app main)")'),
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory'),
        extra_libraries: z.array(z.string()).optional().describe('Additional libraries known to be needed at runtime (e.g. loaded dynamically)'),
      },
    },
    async ({ build_script, entry_module, jerboa_home, extra_libraries }) => {
      // Step 1: Read build script and extract library list
      let buildContent: string;
      try {
        buildContent = await readFile(build_script, 'utf-8');
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Cannot read build script: ${build_script}` }],
          isError: true,
        };
      }

      const bootLibraries = extractBootLibraries(buildContent);

      // Step 2: Get transitive imports using Chez
      const normalizedEntry = entry_module.startsWith('(')
        ? entry_module
        : `(${entry_module.replace(/\//g, ' ')})`;

      const script = `
(import (jerboa prelude))

(define (module-imports mod-path)
  (guard (e [else '()])
    (let ([lib (find-library-from-path mod-path)])
      (if lib
          (library-requirements lib)
          '()))))

(define visited (make-hashtable equal-hash equal?))

(define (walk-imports mod-path)
  (unless (hashtable-ref visited mod-path #f)
    (hashtable-set! visited mod-path #t)
    (let ([deps (module-imports mod-path)])
      (for-each walk-imports deps))))

;; Walk from entry module
(guard (e [else
  ;; Fallback: just list the direct imports we can find
  (display "ERROR: Cannot resolve transitive imports.\\n")
  (display-condition e)])
  (walk-imports '${normalizedEntry})
  (let ([keys (hashtable-keys visited)])
    (vector-for-each
      (lambda (k)
        (display (format "~a\\n" k)))
      keys)))
`;

      const result = await runChez(script, { jerboaHome: jerboa_home, timeout: 30_000 });

      // Parse transitive imports from output
      const transitiveImports: string[] = [];
      if (result.exitCode === 0 && result.stdout) {
        for (const line of result.stdout.trim().split('\n')) {
          const cleaned = line.trim().replace(/^\(/, '').replace(/\)$/, '').replace(/\s+/g, '/');
          if (cleaned && !cleaned.startsWith('ERROR')) {
            transitiveImports.push(cleaned);
          }
        }
      }

      // Normalize all paths for comparison
      const bootSet = new Set(bootLibraries.map(normalizeModPath));
      const transSet = new Set(transitiveImports.map(normalizeModPath));
      const extraSet = new Set((extra_libraries ?? []).map(normalizeModPath));

      // Step 3: Find missing and dead-weight
      const missing: string[] = [];
      for (const t of transSet) {
        if (!bootSet.has(t) && !extraSet.has(t)) {
          // Skip chezscheme itself
          if (t === 'chezscheme' || t.startsWith('chezscheme/')) continue;
          missing.push(t);
        }
      }

      const deadWeight: string[] = [];
      for (const b of bootSet) {
        if (!transSet.has(b) && !extraSet.has(b)) {
          deadWeight.push(b);
        }
      }

      // Step 4: Report
      const sections: string[] = [];
      sections.push('Boot Library Audit');
      sections.push(`Build script: ${build_script}`);
      sections.push(`Entry module: ${entry_module}`);
      sections.push(`Boot libraries: ${bootLibraries.length}`);
      sections.push(`Transitive imports: ${transitiveImports.length}`);
      sections.push('');

      if (transitiveImports.length === 0) {
        sections.push('WARNING: Could not resolve transitive imports.');
        sections.push('This may mean the entry module path is incorrect or the Jerboa environment is not set up.');
        if (result.stderr) {
          sections.push('');
          sections.push('Error output:');
          sections.push(result.stderr.trim());
        }
        if (result.stdout && result.stdout.includes('ERROR')) {
          sections.push(result.stdout.trim());
        }
        sections.push('');
        sections.push('Boot libraries found in build script:');
        for (const b of bootLibraries.sort()) {
          sections.push(`  ${b}`);
        }
      } else if (missing.length === 0 && deadWeight.length === 0) {
        sections.push('All transitive imports are present in the boot library list. No issues found.');
      } else {
        if (missing.length > 0) {
          sections.push(`MISSING LIBRARIES (${missing.length}):`);
          sections.push('These are transitively imported but NOT in the boot file.');
          sections.push('The static binary will crash at runtime when these are needed.');
          sections.push('');
          for (const m of missing.sort()) {
            sections.push(`  ${m}`);
          }
          sections.push('');
          sections.push('Add these to your build script\'s library list.');
          sections.push('');
        }

        if (deadWeight.length > 0) {
          sections.push(`DEAD-WEIGHT LIBRARIES (${deadWeight.length}):`);
          sections.push('These are in the boot file but NOT transitively imported.');
          sections.push('They increase binary size without being used.');
          sections.push('');
          for (const d of deadWeight.sort()) {
            sections.push(`  ${d}`);
          }
          sections.push('');
        }
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n').trimEnd() }],
        isError: missing.length > 0,
      };
    },
  );
}
