import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';
import {
  runChez,
  buildSyntaxCheckScript,
  buildEvalScript,
  stripShebang,
  ERROR_MARKER,
  VALID_MARKER,
} from '../chez.js';

interface CodeBlock {
  lang: string;
  startLine: number; // line where ``` opens
  endLine: number; // line where ``` closes
  source: string;
  imports?: string[]; // imports declared in metadata above the fence
}

interface BlockResult {
  block: CodeBlock;
  status: 'compiled' | 'ran' | 'failed';
  error?: string;
}

const FENCE_RE = /^([ \t]{0,3})(```+|~~~+)\s*([A-Za-z0-9_-]*)?\s*$/;
const IMPORT_META_RE = /^\s*<!--\s*jerboa-imports:\s*(.+?)\s*-->\s*$/;

const ACCEPTED_LANGS = new Set([
  'scheme',
  'jerboa',
  'chez',
  'r6rs',
  'racket', // generous fallback
]);

/**
 * Parse a markdown document and return all fenced code blocks whose lang
 * matches the accepted set. Tracks an `imports` metadata comment of the
 * form `<!-- jerboa-imports: (std sort) (std text json) -->` immediately
 * preceding a block.
 */
function extractBlocks(markdown: string, langs: Set<string>): CodeBlock[] {
  const lines = markdown.split('\n');
  const blocks: CodeBlock[] = [];
  let pendingImports: string[] | undefined;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // Look for an imports-metadata comment near a fence
    const imp = line.match(IMPORT_META_RE);
    if (imp) {
      pendingImports = parseImportsMeta(imp[1]);
      i++;
      continue;
    }

    const fence = line.match(FENCE_RE);
    if (!fence) {
      // Blank line preserves pending imports across one blank line; any
      // other non-fence content clears them.
      if (line.trim() === '') {
        i++;
        continue;
      }
      pendingImports = undefined;
      i++;
      continue;
    }

    const indent = fence[1].length;
    const fenceMarker = fence[2];
    const lang = (fence[3] || '').toLowerCase();
    const startLine = i + 1; // 1-based
    i++;

    if (!langs.has(lang)) {
      // Skip the block content but advance to the closing fence
      while (i < lines.length) {
        const m = lines[i].match(FENCE_RE);
        if (m && m[2].startsWith(fenceMarker) && (m[1]?.length ?? 0) <= indent) {
          i++;
          break;
        }
        i++;
      }
      pendingImports = undefined;
      continue;
    }

    const buf: string[] = [];
    let endLine = startLine;
    while (i < lines.length) {
      const m = lines[i].match(FENCE_RE);
      if (m && m[2].startsWith(fenceMarker) && (m[1]?.length ?? 0) <= indent) {
        endLine = i + 1;
        i++;
        break;
      }
      buf.push(lines[i]);
      i++;
    }

    blocks.push({
      lang,
      startLine,
      endLine,
      source: buf.join('\n'),
      imports: pendingImports,
    });
    pendingImports = undefined;
  }

  return blocks;
}

function parseImportsMeta(raw: string): string[] {
  // Accept either space-separated module paths or paren-delimited list.
  // Examples:
  //   (std sort) (std text json)
  //   :std/sort, :std/text/json
  return raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Detect whether the block already declares its own (import ...) forms,
 * in which case the syntax-check script's auto-imported prelude is
 * sufficient and we should NOT also wrap with default_imports.
 */
function declaresImports(source: string): boolean {
  return /\(\s*import\b/.test(source);
}

async function checkBlock(
  block: CodeBlock,
  defaultImports: string[],
  execute: boolean,
  jerboaHome: string | undefined,
): Promise<BlockResult> {
  const stripped = stripShebang(block.source);
  const blockImports = block.imports ?? [];
  const wrapImports = declaresImports(stripped) ? [] : [...defaultImports, ...blockImports];

  const script = execute
    ? buildEvalScript(stripped, wrapImports)
    : buildSyntaxCheckScript(stripped, wrapImports);

  const result = await runChez(script, { jerboaHome, timeout: 60_000 });

  if (result.timedOut) {
    return { block, status: 'failed', error: 'evaluation timed out' };
  }

  const stdout = result.stdout;

  if (execute) {
    // Eval succeeds even with no result; treat absence of ERROR_MARKER as success.
    const errIdx = stdout.indexOf(ERROR_MARKER);
    if (errIdx !== -1) {
      return {
        block,
        status: 'failed',
        error: stdout.slice(errIdx + ERROR_MARKER.length).trim(),
      };
    }
    if (result.exitCode !== 0) {
      return {
        block,
        status: 'failed',
        error: result.stderr.trim() || stdout.trim(),
      };
    }
    return { block, status: 'ran' };
  }

  if (stdout.includes(VALID_MARKER)) {
    return { block, status: 'compiled' };
  }
  const errIdx = stdout.indexOf(ERROR_MARKER);
  if (errIdx !== -1) {
    return { block, status: 'failed', error: stdout.slice(errIdx + ERROR_MARKER.length).trim() };
  }
  return { block, status: 'failed', error: result.stderr.trim() || stdout.trim() };
}

export function registerDocVerifyTool(server: McpServer): void {
  server.registerTool(
    'jerboa_doc_verify',
    {
      title: 'Verify Markdown Code Blocks',
      description:
        'Extract fenced ```scheme / ```jerboa / ```chez code blocks from a markdown file (or string), ' +
        'run each through the Jerboa compiler, and report per-block status with line numbers. ' +
        'Optionally evaluates each block instead of just compile-checking. ' +
        'Supports per-block imports via an HTML-comment metadata line just before the fence: ' +
        '`<!-- jerboa-imports: (std sort) (std text json) -->`. ' +
        'Catches drift between docs and the actual API as soon as a function is renamed or removed.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z.string().optional().describe('Path to the markdown file to scan'),
        content: z.string().optional().describe('Markdown content as a string (alternative to file_path)'),
        default_imports: z
          .array(z.string())
          .optional()
          .describe('Imports applied to every block that does not declare its own (import ...). Always includes (jerboa prelude).'),
        execute: z
          .boolean()
          .optional()
          .describe('If true, evaluate each block (default: false — only compile-check).'),
        accepted_langs: z
          .array(z.string())
          .optional()
          .describe('Override the default list of accepted fence languages (default: scheme, jerboa, chez, r6rs).'),
        jerboa_home: z.string().optional(),
      },
    },
    async ({ file_path, content, default_imports, execute, accepted_langs, jerboa_home }) => {
      let markdown = content;
      if (file_path && !markdown) {
        try {
          markdown = await readFile(file_path, 'utf-8');
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Cannot read file: ${file_path}` }],
            isError: true,
          };
        }
      }
      if (!markdown) {
        return {
          content: [{ type: 'text' as const, text: 'Provide file_path or content.' }],
          isError: true,
        };
      }

      const langs = new Set((accepted_langs ?? Array.from(ACCEPTED_LANGS)).map((l) => l.toLowerCase()));
      const blocks = extractBlocks(markdown, langs);

      if (blocks.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No matching code blocks found (looked for: ${Array.from(langs).join(', ')}).`,
            },
          ],
        };
      }

      const results = await Promise.all(
        blocks.map((b) => checkBlock(b, default_imports ?? [], execute === true, jerboa_home)),
      );

      const failed = results.filter((r) => r.status === 'failed');
      const ok = results.filter((r) => r.status !== 'failed');

      const lines: string[] = [];
      const label = file_path ?? 'markdown content';
      const verbWord = execute ? 'eval' : 'compile';
      lines.push(`${label}: ${ok.length}/${results.length} blocks ${verbWord}-passed`);
      lines.push('');

      for (const r of results) {
        const fenceLine = r.block.startLine;
        const range = `lines ${fenceLine}–${r.block.endLine}`;
        if (r.status === 'failed') {
          lines.push(`✗ \`${r.block.lang}\` ${range}`);
          if (r.error) {
            for (const e of r.error.split('\n').slice(0, 8)) {
              lines.push(`    ${e}`);
            }
          }
        } else {
          lines.push(`✓ \`${r.block.lang}\` ${range} (${r.status})`);
        }
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: failed.length > 0,
      };
    },
  );
}
