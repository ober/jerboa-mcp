import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readdir, stat } from 'node:fs/promises';
import { join, relative, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getJerboaHome } from '../chez.js';

const execFileAsync = promisify(execFile);

interface SlsFile {
  path: string;
  relPath: string;
  mtimeMs: number;
}

interface ArtifactCheck {
  slsPath: string;
  relPath: string;
  compiledPath: string | null;
  compiledMtime: number | null;
  stale: boolean;
  reason: string;
}

/**
 * Recursively find all .sls files in a directory.
 */
async function findSlsFiles(dir: string): Promise<SlsFile[]> {
  const files: SlsFile[] = [];
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (
        entry.isDirectory() &&
        !entry.name.startsWith('.') &&
        entry.name !== 'node_modules' &&
        entry.name !== 'dist'
      ) {
        files.push(...(await findSlsFiles(fullPath)));
      } else if (entry.isFile() && entry.name.endsWith('.sls')) {
        try {
          const s = await stat(fullPath);
          files.push({ path: fullPath, relPath: fullPath, mtimeMs: s.mtimeMs });
        } catch {
          // skip unreadable
        }
      }
    }
  } catch {
    // skip unreadable directories
  }
  return files;
}

/**
 * Find a compiled artifact (.so or .fasl) for a given .sls file.
 * Searches: same directory, .cache/ subdir, compiled/ subdir.
 */
async function findCompiledArtifact(slsPath: string): Promise<{ path: string; mtimeMs: number } | null> {
  const dir = dirname(slsPath);
  const base = basename(slsPath, '.sls');
  const candidates = [
    join(dir, base + '.so'),
    join(dir, base + '.fasl'),
    join(dir, '.cache', base + '.so'),
    join(dir, '.cache', base + '.fasl'),
    join(dir, 'compiled', base + '.so'),
    join(dir, 'compiled', base + '.fasl'),
  ];

  for (const candidate of candidates) {
    try {
      const s = await stat(candidate);
      return { path: candidate, mtimeMs: s.mtimeMs };
    } catch {
      // not found, try next
    }
  }
  return null;
}

/**
 * Run a git command in the given directory.
 * Returns stdout lines on success, or null if git is not available / not a git repo.
 */
async function runGit(cwd: string, args: string[]): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
      timeout: 5000,
    });
    return stdout
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

/**
 * Find .sls files that are gitignored AND untracked — meaning they compiled
 * but would be silently excluded from commits unless `git add -f` is used.
 *
 * Returns a set of absolute paths for the at-risk files.
 */
async function findGitIgnoredSlsFiles(projectPath: string): Promise<Set<string>> {
  // Files that git knows about (tracked)
  const tracked = await runGit(projectPath, ['ls-files', '--', '*.sls']);
  // Untracked files that are explicitly ignored
  const ignored = await runGit(projectPath, [
    'ls-files',
    '--others',
    '--ignored',
    '--exclude-standard',
    '--',
    '*.sls',
  ]);

  if (!tracked || !ignored) return new Set();

  const trackedSet = new Set(tracked.map((f) => join(projectPath, f)));
  const result = new Set<string>();
  for (const rel of ignored) {
    const abs = join(projectPath, rel);
    if (!trackedSet.has(abs)) {
      result.add(abs);
    }
  }
  return result;
}

/**
 * Format a time difference in human-readable form.
 */
function formatTimeDiff(diffMs: number): string {
  const diffSec = Math.round(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s older`;
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}min older`;
  const diffHrs = Math.round(diffMin / 60);
  if (diffHrs < 24) return `${diffHrs}h older`;
  const diffDays = Math.round(diffHrs / 24);
  return `${diffDays}d older`;
}

export function registerStaleStaticTool(server: McpServer): void {
  server.registerTool(
    'jerboa_stale_static',
    {
      title: 'Stale Compiled Artifact Check',
      description:
        'Compare compiled .so artifacts mtime against source .sls files in a Jerboa project. ' +
        'Detects stale compiled artifacts that may cause unexpected behavior. ' +
        'Also warns when .sls files are gitignored and untracked — a silent failure where files ' +
        'compile and test green but are excluded from commits (fix: git add -f). ' +
        'Reports which compiled files need rebuilding.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        project_path: z.string().describe('Path to the Jerboa project directory'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa home directory (overrides JERBOA_HOME env var)'),
      },
    },
    async ({ project_path, jerboa_home }) => {
      // Verify project_path is a directory
      try {
        const s = await stat(project_path);
        if (!s.isDirectory()) {
          return {
            content: [{ type: 'text' as const, text: `Not a directory: ${project_path}` }],
            isError: true,
          };
        }
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Directory not found: ${project_path}` }],
          isError: true,
        };
      }

      const [slsFiles, gitIgnoredSls] = await Promise.all([
        findSlsFiles(project_path),
        findGitIgnoredSlsFiles(project_path),
      ]);

      if (slsFiles.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No .sls files found in ${project_path}`,
            },
          ],
        };
      }

      const checks: ArtifactCheck[] = [];

      for (const sls of slsFiles) {
        const relPath = relative(project_path, sls.path);
        const artifact = await findCompiledArtifact(sls.path);

        if (!artifact) {
          checks.push({
            slsPath: sls.path,
            relPath,
            compiledPath: null,
            compiledMtime: null,
            stale: true,
            reason: 'no compiled artifact found',
          });
        } else {
          const stale = artifact.mtimeMs < sls.mtimeMs;
          const diffMs = sls.mtimeMs - artifact.mtimeMs;
          const compiledRel = relative(project_path, artifact.path);
          checks.push({
            slsPath: sls.path,
            relPath,
            compiledPath: artifact.path,
            compiledMtime: artifact.mtimeMs,
            stale,
            reason: stale
              ? `compiled/${basename(artifact.path)} is ${formatTimeDiff(diffMs)}`
              : `compiled ${formatTimeDiff(0 - diffMs).replace('older', 'ago').replace('-0s ago', 'recently')}`,
          });
        }
      }

      // Also check $JERBOA_HOME/lib/ for global compiled files
      const jerboaLib = join(getJerboaHome(jerboa_home), 'lib');
      const globalStaleNotes: string[] = [];
      try {
        const libStat = await stat(jerboaLib);
        if (libStat.isDirectory()) {
          globalStaleNotes.push(`\nGlobal lib: ${jerboaLib} (exists — verify not shadowing local builds)`);
        }
      } catch {
        globalStaleNotes.push(`\nGlobal lib: ${jerboaLib} (not found)`);
      }

      const staleChecks = checks.filter((c) => c.stale);
      const okChecks = checks.filter((c) => !c.stale);

      const lines: string[] = [];
      lines.push(`Stale Artifact Check: ${project_path}`);
      lines.push('');

      if (staleChecks.length > 0) {
        lines.push('Stale files (source newer than compiled):');
        for (const c of staleChecks) {
          lines.push(`  STALE: ${c.relPath} (${c.reason})`);
        }
        lines.push('');
      }

      if (okChecks.length > 0) {
        lines.push('Up-to-date:');
        for (const c of okChecks) {
          const compiledRel = c.compiledPath ? relative(project_path, c.compiledPath) : '';
          const age = c.compiledMtime
            ? formatTimeDiff(Date.now() - c.compiledMtime).replace('older', 'ago')
            : 'unknown';
          lines.push(`  OK: ${c.relPath}${compiledRel ? ` (${compiledRel}, ${age})` : ''}`);
        }
        lines.push('');
      }

      if (globalStaleNotes.length > 0) {
        lines.push(...globalStaleNotes);
        lines.push('');
      }

      // Gitignore warning: .sls files that compiled but are excluded from git commits
      const ignoredWithArtifacts = checks.filter(
        (c) => gitIgnoredSls.has(c.slsPath) && c.compiledPath !== null,
      );
      const ignoredWithoutArtifacts = checks.filter(
        (c) => gitIgnoredSls.has(c.slsPath) && c.compiledPath === null,
      );
      if (ignoredWithArtifacts.length > 0 || ignoredWithoutArtifacts.length > 0) {
        lines.push('WARNING: Gitignored .sls files (would be excluded from commits):');
        for (const c of ignoredWithArtifacts) {
          lines.push(
            `  GITIGNORED+COMPILED: ${c.relPath} — has .so artifact but git will not track it`,
          );
        }
        for (const c of ignoredWithoutArtifacts) {
          lines.push(`  GITIGNORED: ${c.relPath} — not tracked by git`);
        }
        lines.push('  Fix: git add -f <file> to force-add past .gitignore');
        lines.push('');
      } else if (gitIgnoredSls.size === 0 && slsFiles.length > 0) {
        // Only note clean state if git is available (gitIgnoredSls not null)
      }

      if (staleChecks.length === 0) {
        lines.push('All compiled artifacts are up to date.');
      } else {
        lines.push('To rebuild: make build');
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}
