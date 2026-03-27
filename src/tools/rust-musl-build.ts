import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';

interface BuildResult {
  success: boolean;
  toolchain: string;
  target: string;
  outputPath?: string;
  errors: string[];
  warnings: string[];
}

function runCommand(
  cmd: string,
  args: string[],
  options?: { cwd?: string; env?: Record<string, string>; timeout?: number },
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      {
        timeout: options?.timeout ?? 300_000,
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, ...options?.env },
        cwd: options?.cwd,
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

export function registerRustMuslBuildTool(server: McpServer): void {
  server.registerTool(
    'jerboa_rust_musl_build',
    {
      title: 'Rust musl Build',
      description:
        'Automates building Rust static libraries for the musl target (x86_64-unknown-linux-musl). ' +
        'Detects the rustup-managed toolchain, verifies the musl target is installed, sets CC=musl-gcc, ' +
        'and runs cargo build --release. Reports the output .a path and any missing dependencies. ' +
        'Use this when integrating a Rust crate as a static library into a Chez Scheme musl binary.',
      annotations: { readOnlyHint: false, idempotentHint: false },
      inputSchema: {
        crate_path: z.string().describe('Path to the Rust crate directory (containing Cargo.toml)'),
        target: z.string().optional().describe('Rust target triple (default: x86_64-unknown-linux-musl)'),
        release: z.coerce.boolean().optional().describe('Build in release mode (default: true)'),
        features: z.array(z.string()).optional().describe('Cargo features to enable'),
        lib_type: z.enum(['staticlib', 'cdylib']).optional().describe('Crate type to build (default: staticlib)'),
        dry_run: z.coerce.boolean().optional().describe('Only check prerequisites, do not build (default: false)'),
      },
    },
    async ({ crate_path, target, release, features, lib_type, dry_run }) => {
      const rustTarget = target ?? 'x86_64-unknown-linux-musl';
      const isRelease = release !== false;
      const sections: string[] = [];
      const errors: string[] = [];

      sections.push(`Rust musl Build: ${crate_path}`);
      sections.push(`Target: ${rustTarget}`);
      sections.push('');

      // Step 1: Verify Cargo.toml exists
      const cargoToml = join(crate_path, 'Cargo.toml');
      try {
        await access(cargoToml, constants.R_OK);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Error: Cargo.toml not found at ${cargoToml}` }],
          isError: true,
        };
      }

      // Read Cargo.toml for package name
      let packageName = 'unknown';
      try {
        const toml = await readFile(cargoToml, 'utf-8');
        const nameMatch = toml.match(/\[package\][^[]*name\s*=\s*"([^"]+)"/s);
        if (nameMatch) packageName = nameMatch[1];
      } catch { /* ignore */ }
      sections.push(`Package: ${packageName}`);

      // Step 2: Detect rustup toolchain
      const toolchainResult = await runCommand('rustup', ['show', 'active-toolchain'], { timeout: 10_000 });
      if (toolchainResult.exitCode !== 0) {
        errors.push('rustup not found or not configured. Install via: curl --proto \'=https\' --tlsv1.2 -sSf https://sh.rustup.rs | sh');
      } else {
        const toolchain = toolchainResult.stdout.trim().split(' ')[0];
        sections.push(`Toolchain: ${toolchain}`);
      }

      // Step 3: Check musl target is installed
      const targetResult = await runCommand('rustup', ['target', 'list', '--installed'], { timeout: 10_000 });
      if (targetResult.exitCode === 0) {
        const installed = targetResult.stdout.trim().split('\n');
        if (!installed.includes(rustTarget)) {
          errors.push(`Target ${rustTarget} not installed. Run: rustup target add ${rustTarget}`);
        } else {
          sections.push(`Target ${rustTarget}: installed`);
        }
      }

      // Step 4: Check for musl-gcc
      const muslGccResult = await runCommand('which', ['musl-gcc'], { timeout: 5_000 });
      if (muslGccResult.exitCode !== 0) {
        errors.push('musl-gcc not found. Install: sudo apt install musl-tools (Debian/Ubuntu) or equivalent.');
      } else {
        sections.push(`musl-gcc: ${muslGccResult.stdout.trim()}`);
      }

      // Step 5: Check crate type in Cargo.toml
      try {
        const toml = await readFile(cargoToml, 'utf-8');
        const expectedType = lib_type ?? 'staticlib';
        if (!toml.includes(`"${expectedType}"`)) {
          errors.push(`Cargo.toml may be missing crate-type = ["${expectedType}"] in [lib]. Check and add if needed.`);
        }
      } catch { /* ignore */ }

      if (errors.length > 0) {
        sections.push('');
        sections.push('Prerequisites missing:');
        for (const e of errors) {
          sections.push(`  - ${e}`);
        }
        if (dry_run) {
          return { content: [{ type: 'text' as const, text: sections.join('\n') }], isError: true };
        }
        sections.push('');
        sections.push('Attempting build anyway...');
      }

      if (dry_run) {
        sections.push('');
        sections.push('Dry run: all prerequisites satisfied. Ready to build.');
        return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
      }

      // Step 6: Run cargo build
      const cargoArgs = ['build', '--target', rustTarget];
      if (isRelease) cargoArgs.push('--release');
      if (features && features.length > 0) {
        cargoArgs.push('--features', features.join(','));
      }

      sections.push('');
      sections.push(`Running: cargo ${cargoArgs.join(' ')}`);

      const buildResult = await runCommand('cargo', cargoArgs, {
        cwd: crate_path,
        env: { CC: 'musl-gcc' },
        timeout: 300_000,
      });

      if (buildResult.exitCode !== 0) {
        sections.push('');
        sections.push('BUILD FAILED');
        sections.push('');
        const output = [buildResult.stdout, buildResult.stderr].filter(Boolean).join('\n');
        sections.push(output.trim());
        return { content: [{ type: 'text' as const, text: sections.join('\n') }], isError: true };
      }

      // Step 7: Find the output .a file
      const profile = isRelease ? 'release' : 'debug';
      const libName = `lib${packageName.replace(/-/g, '_')}.a`;
      const outputPath = join(crate_path, 'target', rustTarget, profile, libName);

      try {
        await access(outputPath, constants.R_OK);
        sections.push('');
        sections.push('BUILD SUCCEEDED');
        sections.push(`Output: ${outputPath}`);
        sections.push('');
        sections.push('Next steps:');
        sections.push(`  1. Link into Chez static binary: add ${outputPath} to your link command`);
        sections.push(`  2. Register symbols: add Sforeign_symbol entries for each exported function`);
        sections.push(`  3. Use jerboa_static_symbol_audit to verify all symbols are registered`);
      } catch {
        sections.push('');
        sections.push('BUILD SUCCEEDED but output file not found at expected path.');
        sections.push(`Expected: ${outputPath}`);
        sections.push('Check target/ directory for the actual output.');
      }

      // Show any warnings from build
      if (buildResult.stderr) {
        const warnings = buildResult.stderr.split('\n').filter(l => l.includes('warning'));
        if (warnings.length > 0) {
          sections.push('');
          sections.push(`Warnings (${warnings.length}):`);
          for (const w of warnings.slice(0, 20)) {
            sections.push(`  ${w.trim()}`);
          }
        }
      }

      return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
    },
  );
}
