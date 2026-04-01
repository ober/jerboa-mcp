import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readFile } from 'node:fs/promises';

interface PatchCall {
  index: number;
  lineNumber: number;
  targetFile: string;
  oldString: string;
  newString: string;
  raw: string;
}

interface PatchIssue {
  patchIndex: number;
  lineNumber: number;
  kind: 'not-found' | 'duplicate-match' | 'ordering-dependency';
  message: string;
  context?: string;
}

/**
 * Extract the string value from a Scheme string literal token.
 * Handles basic escape sequences: \n, \t, \\, \".
 */
function unescapeSchemeString(s: string): string {
  return s
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\\\/g, '\\')
    .replace(/\\"/g, '"');
}

/**
 * Minimal Scheme string literal extractor.
 * Reads one double-quoted Scheme string from `src` starting at `pos`.
 * Returns { value, end } or null on failure.
 */
function extractSchemeString(src: string, pos: number): { value: string; end: number } | null {
  if (src[pos] !== '"') return null;
  let i = pos + 1;
  let result = '';
  while (i < src.length) {
    const ch = src[i];
    if (ch === '\\') {
      if (i + 1 < src.length) {
        result += '\\' + src[i + 1];
        i += 2;
      } else {
        i++;
      }
    } else if (ch === '"') {
      return { value: unescapeSchemeString(result), end: i + 1 };
    } else {
      result += ch;
      i++;
    }
  }
  return null;
}

/**
 * Parse all (patch-file! target old new) calls from a Jerboa/Scheme source string.
 */
function parsePatchCalls(source: string): PatchCall[] {
  const patches: PatchCall[] = [];
  const lines = source.split('\n');

  // Build a char-offset → line-number map for reporting
  const lineMap: number[] = new Array(source.length + 1);
  let lineNum = 1;
  for (let i = 0; i < source.length; i++) {
    lineMap[i] = lineNum;
    if (source[i] === '\n') lineNum++;
  }

  const pattern = /\(patch-file!/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(source)) !== null) {
    const startPos = match.index;
    let i = match.index + match[0].length;

    // Skip whitespace
    while (i < source.length && /\s/.test(source[i])) i++;

    // Extract target file (string or symbol)
    let targetFile = '';
    if (source[i] === '"') {
      const r = extractSchemeString(source, i);
      if (!r) continue;
      targetFile = r.value;
      i = r.end;
    } else {
      // Symbol/identifier
      const symEnd = source.slice(i).search(/[\s)]/);
      if (symEnd < 0) continue;
      targetFile = source.slice(i, i + symEnd);
      i += symEnd;
    }

    // Skip whitespace
    while (i < source.length && /\s/.test(source[i])) i++;

    // Extract old string
    const oldResult = extractSchemeString(source, i);
    if (!oldResult) continue;
    i = oldResult.end;

    // Skip whitespace
    while (i < source.length && /\s/.test(source[i])) i++;

    // Extract new string
    const newResult = extractSchemeString(source, i);
    if (!newResult) continue;

    const lineNo = lineMap[startPos] ?? 0;
    const rawEnd = Math.min(newResult.end + 10, source.length);
    const raw = source.slice(startPos, rawEnd).split('\n')[0];

    patches.push({
      index: patches.length,
      lineNumber: lineNo,
      targetFile,
      oldString: oldResult.value,
      newString: newResult.value,
      raw,
    });
  }

  return patches;
}

/**
 * Simulate applying patches in sequence to a virtual file state,
 * detecting ordering bugs and missing matches.
 */
function validatePatches(patches: PatchCall[]): PatchIssue[] {
  const issues: PatchIssue[] = [];

  // Group patches by target file
  const byFile = new Map<string, PatchCall[]>();
  for (const p of patches) {
    const key = p.targetFile;
    if (!byFile.has(key)) byFile.set(key, []);
    byFile.get(key)!.push(p);
  }

  // For each file, simulate the transformations in order
  for (const [targetFile, filePatches] of byFile) {
    // We don't have the actual file contents, so we simulate:
    // Track which old_strings have been "introduced" by previous patches.
    // A patch can only succeed if its old_string was present at patch time.
    // We detect ordering issues when patch B's old_string contains text
    // that is only introduced by a later patch C.

    const introduced: string[] = []; // strings introduced as new_string
    const removed: string[] = [];    // strings removed as old_string

    for (const patch of filePatches) {
      // Check if this patch's old_string was removed by an earlier patch
      const alreadyRemoved = removed.some((r) => r.includes(patch.oldString) || patch.oldString.includes(r));

      if (alreadyRemoved) {
        issues.push({
          patchIndex: patch.index,
          lineNumber: patch.lineNumber,
          kind: 'ordering-dependency',
          message:
            `Patch #${patch.index + 1} (line ${patch.lineNumber}): old_string may have been ` +
            `already consumed by an earlier patch targeting "${targetFile}".`,
          context: patch.oldString.slice(0, 80),
        });
      }

      // Check if old_string contains text that is only introduced by a later patch
      const laterIntroducer = filePatches
        .slice(patch.index + 1)
        .find((later) => later.newString.includes(patch.oldString) || patch.oldString.includes(later.newString.split('\n')[0]));

      if (laterIntroducer) {
        issues.push({
          patchIndex: patch.index,
          lineNumber: patch.lineNumber,
          kind: 'ordering-dependency',
          message:
            `Patch #${patch.index + 1} (line ${patch.lineNumber}): old_string appears to depend on ` +
            `text introduced by a later patch #${laterIntroducer.index + 1} (line ${laterIntroducer.lineNumber}). ` +
            `The match "${patch.oldString.slice(0, 50).replace(/\n/g, '\\n')}..." may not exist at this point.`,
          context: `Later patch introduces: "${laterIntroducer.newString.slice(0, 60).replace(/\n/g, '\\n')}"`,
        });
      }

      // Track what this patch removes and introduces
      removed.push(patch.oldString);
      introduced.push(patch.newString);
    }

    // Check for duplicate old_strings within the same file (second one will silently fail)
    const seen = new Map<string, number>();
    for (const patch of filePatches) {
      const key = patch.oldString;
      if (seen.has(key)) {
        issues.push({
          patchIndex: patch.index,
          lineNumber: patch.lineNumber,
          kind: 'duplicate-match',
          message:
            `Patch #${patch.index + 1} (line ${patch.lineNumber}): duplicate old_string — ` +
            `same string was already used by patch #${(seen.get(key)! + 1)} targeting "${targetFile}". ` +
            `After the first patch applies, this match will fail silently.`,
          context: key.slice(0, 80).replace(/\n/g, '\\n'),
        });
      } else {
        seen.set(key, patch.index);
      }
    }
  }

  return issues;
}

export function registerPatchFileValidatorTool(server: McpServer): void {
  server.registerTool(
    'jerboa_patch_file_validator',
    {
      title: 'Validate patch-file! Ordering',
      description:
        'Analyze a Jerboa build script containing sequential (patch-file! target old new) calls ' +
        'and detect ordering bugs — where a patch\'s old_string depends on text introduced by a ' +
        'later patch, or where duplicate old_strings cause silent failures. ' +
        'Simulates the transformation sequence without needing the actual target file contents. ' +
        'Use before running build scripts with 10+ patch-file! calls.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        file_path: z
          .string()
          .optional()
          .describe('Path to the Jerboa build script (.ss file) to analyze'),
        code: z
          .string()
          .optional()
          .describe('Inline build script source to analyze'),
      },
    },
    async ({ file_path, code }) => {
      let source: string;

      if (file_path) {
        try {
          source = await readFile(file_path, 'utf-8');
        } catch (e) {
          const msg = e instanceof Error ? e.message : 'Unknown error';
          return {
            content: [{ type: 'text' as const, text: `Cannot read file: ${msg}` }],
            isError: true,
          };
        }
      } else if (code) {
        source = code;
      } else {
        return {
          content: [{ type: 'text' as const, text: 'Provide file_path or code.' }],
          isError: true,
        };
      }

      const patches = parsePatchCalls(source);

      if (patches.length === 0) {
        return {
          content: [{ type: 'text' as const, text: 'No (patch-file! ...) calls found.' }],
        };
      }

      const issues = validatePatches(patches);

      const lines: string[] = [];
      lines.push(`Found ${patches.length} patch-file! call(s).`);

      if (issues.length === 0) {
        lines.push('No ordering issues detected.');
      } else {
        lines.push(`${issues.length} potential issue(s) found:\n`);
        for (const issue of issues) {
          lines.push(
            `[${issue.kind}] ${issue.message}`,
          );
          if (issue.context) {
            lines.push(`  Context: ${issue.context}`);
          }
          lines.push('');
        }
      }

      // Summary of patches by file
      const files = new Set(patches.map((p) => p.targetFile));
      if (files.size > 1) {
        lines.push('\nPatches by target file:');
        for (const f of files) {
          const count = patches.filter((p) => p.targetFile === f).length;
          lines.push(`  ${f}: ${count} patch(es)`);
        }
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: issues.length > 0,
      };
    },
  );
}
