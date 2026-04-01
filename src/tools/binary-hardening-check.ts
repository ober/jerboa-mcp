import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: 2 * 1024 * 1024 });
    return { stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '' };
  }
}

interface HardeningResult {
  property: string;
  status: 'pass' | 'fail' | 'unknown';
  detail: string;
  remediation?: string;
}

export function registerBinaryHardeningCheckTool(server: McpServer): void {
  server.registerTool(
    'jerboa_binary_hardening_check',
    {
      title: 'Check Binary Hardening Properties',
      description:
        'Verify ELF binary security hardening: PIE (position-independent executable), ' +
        'Full RELRO (BIND_NOW), stack canaries (__stack_chk_fail), NX stack, ' +
        'CET/IBT (PT_GNU_PROPERTY), and FORTIFY_SOURCE. ' +
        'Returns a structured pass/fail report per property with remediation advice. ' +
        'Requires readelf and nm to be on PATH (standard binutils).',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        binary_path: z.string().describe('Path to the ELF binary or shared library to inspect'),
      },
    },
    async ({ binary_path }) => {
      const results: HardeningResult[] = [];

      // 1. PIE — check ELF type is ET_DYN (shared object / PIE executable)
      const fileInfo = await run('file', [binary_path]);
      const readelfHeader = await run('readelf', ['-h', binary_path]);
      {
        const elfType = readelfHeader.stdout.match(/Type:\s+(\S+)/)?.[1] ?? '';
        const isPie = elfType === 'DYN' || fileInfo.stdout.includes('pie executable');
        results.push({
          property: 'PIE',
          status: isPie ? 'pass' : elfType ? 'fail' : 'unknown',
          detail: elfType ? `ELF Type: ${elfType}` : fileInfo.stdout.split('\n')[0] ?? 'unknown',
          remediation: isPie
            ? undefined
            : 'Compile with -fPIE -pie (gcc/clang) or pass --enable-pie to Chez configure.',
        });
      }

      // 2. RELRO — check for GNU_RELRO segment and BIND_NOW flag
      const readelfDyn = await run('readelf', ['-d', binary_path]);
      {
        const hasRelro =
          readelfDyn.stdout.includes('RELRO') ||
          (await run('readelf', ['-l', binary_path])).stdout.includes('GNU_RELRO');
        const hasBindNow =
          readelfDyn.stdout.includes('BIND_NOW') || readelfDyn.stdout.includes('(FLAGS).*BIND_NOW');
        const fullRelro = hasRelro && hasBindNow;
        results.push({
          property: 'Full RELRO',
          status: fullRelro ? 'pass' : hasRelro ? 'fail' : 'fail',
          detail: hasRelro
            ? hasBindNow
              ? 'GNU_RELRO + BIND_NOW present'
              : 'GNU_RELRO present but BIND_NOW missing (partial RELRO only)'
            : 'No GNU_RELRO segment found',
          remediation: fullRelro
            ? undefined
            : 'Link with -Wl,-z,relro,-z,now for full RELRO.',
        });
      }

      // 3. Stack canaries — check for __stack_chk_fail reference
      const nmUndefined = await run('nm', ['-u', binary_path]);
      const nmAll = await run('nm', [binary_path]);
      {
        const hasCanary =
          nmUndefined.stdout.includes('__stack_chk_fail') ||
          nmAll.stdout.includes('__stack_chk_fail');
        results.push({
          property: 'Stack Canaries',
          status: hasCanary ? 'pass' : 'fail',
          detail: hasCanary
            ? '__stack_chk_fail reference found'
            : 'No __stack_chk_fail reference — stack canaries not enabled',
          remediation: hasCanary ? undefined : 'Compile with -fstack-protector-strong.',
        });
      }

      // 4. NX stack — check GNU_STACK segment flags (RW = NX, RWE = no NX)
      const readelfSegments = await run('readelf', ['-l', binary_path]);
      {
        const stackLine = readelfSegments.stdout
          .split('\n')
          .find((l) => l.includes('GNU_STACK'));
        let nxStatus: 'pass' | 'fail' | 'unknown' = 'unknown';
        let nxDetail = 'GNU_STACK segment not found';
        if (stackLine) {
          // Flags column: RW = NX enabled, RWE = executable stack
          const flagsMatch = stackLine.match(/\b(RWE|RW|RE|R|W|E)\s*$/);
          const flags = flagsMatch?.[1] ?? stackLine.trim().split(/\s+/).pop() ?? '';
          if (flags.includes('E')) {
            nxStatus = 'fail';
            nxDetail = `GNU_STACK flags: ${flags} — stack is executable`;
          } else {
            nxStatus = 'pass';
            nxDetail = `GNU_STACK flags: ${flags} — stack is non-executable`;
          }
        }
        results.push({
          property: 'NX Stack',
          status: nxStatus,
          detail: nxDetail,
          remediation:
            nxStatus === 'fail'
              ? 'Link without -z execstack; ensure no assembly objects mark stack executable.'
              : undefined,
        });
      }

      // 5. CET / IBT — check PT_GNU_PROPERTY note for IBT/SHSTK
      const readelfNotes = await run('readelf', ['--notes', binary_path]);
      {
        const hasIbt =
          readelfNotes.stdout.includes('IBT') ||
          readelfNotes.stdout.includes('SHSTK') ||
          readelfNotes.stdout.includes('GNU_PROPERTY_X86_FEATURE_1_IBT') ||
          readelfNotes.stdout.includes('PT_GNU_PROPERTY');
        results.push({
          property: 'CET/IBT',
          status: hasIbt ? 'pass' : 'unknown',
          detail: hasIbt
            ? 'IBT/SHSTK property found in PT_GNU_PROPERTY'
            : 'No CET property detected (not necessarily an error — CET requires CPU+kernel+compiler support)',
          remediation: undefined,
        });
      }

      // 6. FORTIFY_SOURCE — check for __*_chk symbols
      {
        const hasFortify =
          nmAll.stdout.includes('_chk') ||
          nmUndefined.stdout.includes('__memcpy_chk') ||
          nmUndefined.stdout.includes('__sprintf_chk') ||
          nmUndefined.stdout.includes('__strcpy_chk') ||
          nmUndefined.stdout.includes('__printf_chk');
        results.push({
          property: 'FORTIFY_SOURCE',
          status: hasFortify ? 'pass' : 'unknown',
          detail: hasFortify
            ? 'FORTIFY_SOURCE __*_chk symbols found'
            : 'No FORTIFY_SOURCE symbols detected (may not apply to this binary type)',
          remediation: undefined,
        });
      }

      // Format report
      const passed = results.filter((r) => r.status === 'pass').length;
      const failed = results.filter((r) => r.status === 'fail').length;
      const unknown = results.filter((r) => r.status === 'unknown').length;

      const lines: string[] = [
        `Binary hardening report: ${binary_path}`,
        `Summary: ${passed} pass, ${failed} fail, ${unknown} unknown`,
        '',
      ];

      for (const r of results) {
        const icon = r.status === 'pass' ? '✓' : r.status === 'fail' ? '✗' : '?';
        lines.push(`${icon} ${r.property}: ${r.detail}`);
        if (r.remediation) {
          lines.push(`  → ${r.remediation}`);
        }
      }

      const anyFail = failed > 0;
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: anyFail,
      };
    },
  );
}
