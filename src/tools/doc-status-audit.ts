import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile, access } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { getJerboaHome } from '../chez.js';

interface RawClaim {
  ref: string;
  kind: 'file' | 'module';
  line: number;
  context: string;
}

interface VerifiedClaim {
  ref: string;
  kind: 'file' | 'module';
  contextLine: number;
  contextText: string;
  exists: boolean;
  resolvedPath?: string;
  triedPaths?: string[];
}

const STATUS_KEYWORDS = [
  'done',
  'complete',
  'completed',
  'implemented',
  'shipped',
  'finished',
  'closed',
  'merged',
  'ready',
  'landed',
];

/**
 * Matches status markers: [x] checkbox, ✓ / ✅ / 🎉, or any of the keywords
 * above as a whole word (case-insensitive).
 */
const STATUS_RE = new RegExp(
  `(?:\\[\\s*x\\s*\\]|✓|✅|🎉|\\b(?:${STATUS_KEYWORDS.join('|')})\\b)`,
  'i',
);

const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;

const FILE_EXT_LIST = [
  'ss',
  'sls',
  'ts',
  'tsx',
  'js',
  'jsx',
  'c',
  'h',
  'cpp',
  'hpp',
  'rs',
  'py',
  'sh',
  'json',
  'toml',
  'yaml',
  'yml',
  'mk',
];

/**
 * Match a path-like token ending in one of the known extensions. Avoids
 * matching when preceded by a word char, `.`, or `/` so we do not pick up
 * fragments out of larger tokens like `mod.path.ss.gz`.
 */
const FILE_PATH_RE = new RegExp(
  `(?<![\\w./])((?:\\.\\.?\\/)?(?:[\\w\\-]+/)*[\\w\\-]+\\.(?:${FILE_EXT_LIST.join('|')}))\\b`,
  'g',
);

/**
 * Match a module spec like `(std sort)` or `(jerboa core)`. Only well-known
 * heads are considered — any noun-phrase parenthetical would match a generic
 * `\(...\)` regex.
 */
const MODULE_HEADS = new Set(['std', 'jerboa', 'user', 'app', 'core', 'lib', 'srfi']);
const MODULE_SPEC_RE = /\(([a-z][\w\-]*(?:\s+[a-z][\w\-]*)+)\)/g;

function extractClaims(markdown: string): RawClaim[] {
  const lines = markdown.split('\n');
  const claims: RawClaim[] = [];

  let currentSection: { line: number; text: string; isComplete: boolean } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      const text = headingMatch[2];
      const isComplete = STATUS_RE.test(text);
      currentSection = { line: lineNum, text, isComplete };
      // Extract refs from the heading itself when complete
      if (isComplete) {
        for (const m of text.matchAll(FILE_PATH_RE)) {
          claims.push({ ref: m[1], kind: 'file', line: lineNum, context: text });
        }
      }
      continue;
    }

    const lineHasStatus = STATUS_RE.test(line);
    const inCompleteSection = currentSection?.isComplete ?? false;
    if (!lineHasStatus && !inCompleteSection) continue;

    const ctx = lineHasStatus
      ? line.trim()
      : `(in "${currentSection?.text}") ${line.trim()}`;

    for (const m of line.matchAll(FILE_PATH_RE)) {
      claims.push({ ref: m[1], kind: 'file', line: lineNum, context: ctx });
    }
    for (const m of line.matchAll(MODULE_SPEC_RE)) {
      const head = m[1].split(/\s+/)[0];
      if (MODULE_HEADS.has(head)) {
        claims.push({
          ref: '(' + m[1] + ')',
          kind: 'module',
          line: lineNum,
          context: ctx,
        });
      }
    }
  }

  return claims;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function moduleCandidatePaths(libRoot: string, moduleSpec: string): string[] {
  const inner = moduleSpec.startsWith('(')
    ? moduleSpec.slice(1, -1).trim()
    : moduleSpec.trim();
  const parts = inner.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return [];
  const dirs = parts.slice(0, -1);
  const last = parts[parts.length - 1];
  const baseDir = join(libRoot, ...dirs);
  return [
    join(baseDir, last + '.sls'),
    join(baseDir, last + '.ss'),
    join(baseDir, last, last + '.sls'),
    join(baseDir, last, 'main.sls'),
  ];
}

async function verifyClaim(
  claim: RawClaim,
  baseDir: string,
  jerboaHome: string,
): Promise<VerifiedClaim> {
  if (claim.kind === 'file') {
    const candidate = claim.ref.startsWith('/')
      ? claim.ref
      : resolve(baseDir, claim.ref);
    if (await fileExists(candidate)) {
      return {
        ref: claim.ref,
        kind: 'file',
        contextLine: claim.line,
        contextText: claim.context,
        exists: true,
        resolvedPath: candidate,
      };
    }
    return {
      ref: claim.ref,
      kind: 'file',
      contextLine: claim.line,
      contextText: claim.context,
      exists: false,
      triedPaths: [candidate],
    };
  }

  const libRoot = join(jerboaHome, 'lib');
  const candidates = moduleCandidatePaths(libRoot, claim.ref);
  for (const p of candidates) {
    if (await fileExists(p)) {
      return {
        ref: claim.ref,
        kind: 'module',
        contextLine: claim.line,
        contextText: claim.context,
        exists: true,
        resolvedPath: p,
      };
    }
  }
  return {
    ref: claim.ref,
    kind: 'module',
    contextLine: claim.line,
    contextText: claim.context,
    exists: false,
    triedPaths: candidates,
  };
}

export function registerDocStatusAuditTool(server: McpServer): void {
  server.registerTool(
    'jerboa_doc_status_audit',
    {
      title: 'Doc Implementation-Status Audit',
      description:
        'Parse a markdown file for "Done", "Complete", "Implemented", ✓, [x], etc. status markers ' +
        'and verify the file paths and module specs claimed in those passages still exist on disk. ' +
        'Status markers in headings cause every reference inside the section to be checked. Catches ' +
        'the common drift where a roadmap or design doc says a module is shipped but the file has ' +
        'since been renamed, deleted, or never landed. Reports per-claim resolution with the ' +
        'context line so the doc can be updated.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().describe('Path to the markdown file to audit'),
        project_path: z
          .string()
          .optional()
          .describe('Base directory for relative file references (defaults to the markdown file\'s dir)'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Jerboa home for resolving module specs like (std sort)'),
      },
    },
    async ({ file_path, project_path, jerboa_home }) => {
      let markdown: string;
      try {
        markdown = await readFile(file_path, 'utf-8');
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Cannot read file: ${file_path}` }],
          isError: true,
        };
      }

      const baseDir = project_path ?? dirname(file_path);
      const home = getJerboaHome(jerboa_home);

      const rawClaims = extractClaims(markdown);

      // De-duplicate by (kind, ref) — keep first occurrence's location
      const seen = new Set<string>();
      const unique: RawClaim[] = [];
      for (const c of rawClaims) {
        const key = c.kind + ':' + c.ref;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(c);
      }

      if (unique.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No status-marked file or module references found.',
            },
          ],
        };
      }

      const verified = await Promise.all(unique.map((c) => verifyClaim(c, baseDir, home)));
      const failed = verified.filter((c) => !c.exists);
      const ok = verified.filter((c) => c.exists);

      const lines: string[] = [];
      lines.push(`Doc status audit: ${file_path}`);
      lines.push(`  ${verified.length} claim(s) — ${ok.length} resolved, ${failed.length} missing`);
      lines.push('');

      if (failed.length > 0) {
        lines.push('Missing references:');
        for (const c of failed) {
          lines.push(`  ✗ ${c.kind} "${c.ref}"  (line ${c.contextLine})`);
          const ctx = c.contextText.length > 140 ? c.contextText.slice(0, 137) + '...' : c.contextText;
          lines.push(`      claim: ${ctx}`);
          if (c.triedPaths) {
            for (const p of c.triedPaths.slice(0, 4)) lines.push(`      tried: ${p}`);
          }
        }
        lines.push('');
      }

      if (ok.length > 0) {
        lines.push('Resolved references:');
        for (const c of ok) {
          lines.push(`  ✓ ${c.kind} "${c.ref}"  →  ${c.resolvedPath}`);
        }
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: failed.length > 0,
      };
    },
  );
}
