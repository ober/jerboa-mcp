import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, getJerboaHome } from '../chez.js';

interface ModuleExports {
  module: string;
  platform: string;
  exports: string[];
  error?: string;
}

export function registerSandboxParityTool(server: McpServer): void {
  server.registerTool(
    'jerboa_sandbox_parity',
    {
      title: 'Sandbox Parity Check',
      description:
        'Compares sandbox capabilities across platforms by introspecting the actual Jerboa sandbox ' +
        'modules: (std security sandbox), (std security capsicum), (std security seccomp), ' +
        '(std security landlock), (std security seatbelt). Reports which features are available ' +
        'on each platform, feature parity gaps, and platform-specific capabilities. ' +
        'Helps maintain cross-platform sandbox consistency.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory'),
        show_all_exports: z.coerce.boolean().optional().describe('Show all exports, not just parity differences (default: false)'),
      },
    },
    async ({ jerboa_home, show_all_exports }) => {
      // Modules to check and their platform associations
      const SANDBOX_MODULES: Array<{ module: string; platform: string }> = [
        { module: '(std security sandbox)', platform: 'cross-platform' },
        { module: '(std security seccomp)', platform: 'linux' },
        { module: '(std security landlock)', platform: 'linux' },
        { module: '(std security capsicum)', platform: 'freebsd' },
        { module: '(std security seatbelt)', platform: 'macos' },
        { module: '(std security restrict)', platform: 'cross-platform' },
      ];

      const results: ModuleExports[] = [];

      // Introspect each module
      for (const mod of SANDBOX_MODULES) {
        const script = `
(import (jerboa prelude))
(guard (e [else
           (display "MODULE-NOT-FOUND")
           (newline)])
  (let ([exports (library-exports '${mod.module})])
    (for-each
      (lambda (sym)
        (display (symbol->string sym))
        (newline))
      (sort (lambda (a b) (string<? (symbol->string a) (symbol->string b))) exports))))
`;

        const result = await runChez(script, { jerboaHome: jerboa_home, timeout: 10_000 });

        if (result.exitCode !== 0 || result.stdout.includes('MODULE-NOT-FOUND')) {
          results.push({
            module: mod.module,
            platform: mod.platform,
            exports: [],
            error: 'Module not found or not available on this platform',
          });
        } else {
          const exports = result.stdout.trim().split('\n').filter(Boolean);
          results.push({
            module: mod.module,
            platform: mod.platform,
            exports,
          });
        }
      }

      // Analyze parity
      const sections: string[] = [];
      sections.push('Sandbox Parity Check');
      sections.push('');

      // Summary table
      sections.push('Module Availability:');
      for (const r of results) {
        const status = r.error ? 'NOT AVAILABLE' : `${r.exports.length} exports`;
        sections.push(`  ${r.module} [${r.platform}]: ${status}`);
      }
      sections.push('');

      // Find platform-specific modules (Linux, FreeBSD, macOS)
      const linuxModules = results.filter(r => r.platform === 'linux' && !r.error);
      const freebsdModules = results.filter(r => r.platform === 'freebsd' && !r.error);
      const macosModules = results.filter(r => r.platform === 'macos' && !r.error);
      const crossPlatform = results.filter(r => r.platform === 'cross-platform' && !r.error);

      // Categorize exports by function type
      const categorize = (exports: string[]): Map<string, string[]> => {
        const cats = new Map<string, string[]>();
        for (const exp of exports) {
          let cat = 'other';
          if (exp.includes('preset') || exp.includes('profile')) cat = 'presets';
          else if (exp.includes('sandbox') || exp.includes('enter') || exp.includes('init')) cat = 'lifecycle';
          else if (exp.includes('allow') || exp.includes('deny') || exp.includes('restrict') || exp.includes('cap-')) cat = 'permissions';
          else if (exp.includes('path') || exp.includes('file') || exp.includes('fd')) cat = 'filesystem';
          else if (exp.includes('net') || exp.includes('socket') || exp.includes('connect')) cat = 'network';
          else if (exp.includes('process') || exp.includes('exec') || exp.includes('fork')) cat = 'process';

          if (!cats.has(cat)) cats.set(cat, []);
          cats.get(cat)!.push(exp);
        }
        return cats;
      };

      // Cross-platform comparison
      const allPlatformExports = new Map<string, Set<string>>();
      for (const platform of ['linux', 'freebsd', 'macos']) {
        const mods = results.filter(r => r.platform === platform && !r.error);
        const exports = new Set<string>();
        for (const m of mods) {
          for (const e of m.exports) exports.add(e);
        }
        allPlatformExports.set(platform, exports);
      }

      // Find gaps
      const allExports = new Set<string>();
      for (const [, exports] of allPlatformExports) {
        for (const e of exports) allExports.add(e);
      }

      const gaps: Array<{ feature: string; hasIt: string[]; missingFrom: string[] }> = [];
      for (const exp of allExports) {
        const has: string[] = [];
        const missing: string[] = [];
        for (const platform of ['linux', 'freebsd', 'macos']) {
          if (allPlatformExports.get(platform)?.has(exp)) {
            has.push(platform);
          } else {
            missing.push(platform);
          }
        }
        if (missing.length > 0 && has.length > 0) {
          gaps.push({ feature: exp, hasIt: has, missingFrom: missing });
        }
      }

      if (gaps.length > 0) {
        sections.push(`Parity Gaps (${gaps.length}):`);
        sections.push('Features available on some platforms but not others:');
        sections.push('');
        for (const gap of gaps.sort((a, b) => a.feature.localeCompare(b.feature))) {
          sections.push(`  ${gap.feature}`);
          sections.push(`    Available: ${gap.hasIt.join(', ')}`);
          sections.push(`    Missing: ${gap.missingFrom.join(', ')}`);
        }
        sections.push('');
      } else if (allExports.size > 0) {
        sections.push('No parity gaps found — all features are available on all platforms.');
        sections.push('');
      }

      // Show all exports if requested
      if (show_all_exports) {
        for (const r of results) {
          if (r.error) continue;
          sections.push(`${r.module} [${r.platform}]:`);
          const cats = categorize(r.exports);
          for (const [cat, syms] of [...cats.entries()].sort()) {
            sections.push(`  ${cat}:`);
            for (const sym of syms.sort()) {
              sections.push(`    ${sym}`);
            }
          }
          sections.push('');
        }
      }

      // Cross-platform module analysis
      if (crossPlatform.length > 0) {
        sections.push('Cross-Platform Module:');
        for (const cp of crossPlatform) {
          sections.push(`  ${cp.module}: ${cp.exports.length} exports`);
          if (show_all_exports) {
            for (const exp of cp.exports.sort()) {
              sections.push(`    ${exp}`);
            }
          }
        }
        sections.push('');
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n').trimEnd() }],
      };
    },
  );
}
