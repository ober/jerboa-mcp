import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { execFile } from 'node:child_process';
import { readFile, writeFile, unlink, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; ok: boolean }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: 8 * 1024 * 1024 });
    return { stdout: stdout ?? '', stderr: stderr ?? '', ok: true };
  } catch (e: unknown) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? err.message ?? '', ok: false };
  }
}

/**
 * Compute pixel-level diff between two PNG screenshots using ImageMagick `compare`.
 * Falls back to a simpler file-size comparison if ImageMagick is not available.
 */
async function computeDiff(
  imagePath1: string,
  imagePath2: string,
  diffOutputPath?: string,
): Promise<{
  pixelCount?: number;
  pixelPercent?: number;
  method: string;
  diffPath?: string;
  error?: string;
}> {
  // Try ImageMagick compare
  const diffPath = diffOutputPath ?? join(tmpdir(), `screenshot-diff-${Date.now()}.png`);
  const args = [
    '-metric', 'AE',         // Absolute error pixel count
    '-fuzz', '5%',           // Tolerate 5% color difference
    imagePath1,
    imagePath2,
    diffPath,
  ];

  const result = await run('compare', args);

  // ImageMagick compare prints the pixel count to stderr with AE metric
  const pixelCount = parseInt(result.stderr.trim().split(/\s+/)[0], 10);

  if (!isNaN(pixelCount)) {
    // Get total pixel count from identify
    const identify = await run('identify', ['-format', '%w %h', imagePath1]);
    let totalPixels = 0;
    if (identify.ok) {
      const [w, h] = identify.stdout.trim().split(/\s+/).map(Number);
      totalPixels = (w || 0) * (h || 0);
    }
    const pct = totalPixels > 0 ? (pixelCount / totalPixels) * 100 : 0;
    return {
      pixelCount,
      pixelPercent: Math.round(pct * 100) / 100,
      method: 'imagemagick-AE',
      diffPath: result.ok ? diffPath : undefined,
    };
  }

  // Fallback: file size comparison
  const [stat1, stat2] = await Promise.all([
    readFile(imagePath1),
    readFile(imagePath2),
  ]);

  const sizeDiff = Math.abs(stat1.length - stat2.length);
  const sizePercent = stat1.length > 0 ? (sizeDiff / stat1.length) * 100 : 0;

  return {
    method: 'file-size-fallback',
    pixelPercent: Math.round(sizePercent * 100) / 100,
    error: 'ImageMagick not available — using file-size comparison (less accurate)',
  };
}

export function registerScreenshotDiffTool(server: McpServer): void {
  server.registerTool(
    'jerboa_screenshot_diff',
    {
      title: 'Screenshot Diff (Visual Regression)',
      description:
        'Compute a pixel-level diff between two screenshots to detect visual regressions. ' +
        'Takes two image file paths (PNG/BMP), runs ImageMagick compare with 5% color fuzz, ' +
        'and reports: changed pixel count, percentage of total pixels changed, and optionally ' +
        'saves a diff image highlighting changed regions. ' +
        'Use after fixing flicker/rendering bugs to verify no new visual artifacts. ' +
        'Requires ImageMagick (compare, identify) on PATH for pixel-accurate results; ' +
        'falls back to file-size comparison if unavailable.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        before_path: z.string().describe('Path to the "before" screenshot (PNG or BMP)'),
        after_path: z.string().describe('Path to the "after" screenshot (PNG or BMP)'),
        save_diff: z
          .boolean()
          .optional()
          .describe('Save a diff image to disk highlighting changed pixels (default: false)'),
        diff_output_path: z
          .string()
          .optional()
          .describe('Where to save the diff image (default: auto temp path, only used if save_diff=true)'),
        threshold_percent: z
          .number()
          .optional()
          .describe(
            'Report as failure if changed pixels exceed this percentage (default: 1.0). ' +
            'Set to 0 for strict pixel-perfect comparison.',
          ),
      },
    },
    async ({ before_path, after_path, save_diff, diff_output_path, threshold_percent }) => {
      const threshold = threshold_percent ?? 1.0;

      let tmpDir: string | undefined;
      let diffPath: string | undefined;

      try {
        if (save_diff && !diff_output_path) {
          tmpDir = await mkdtemp(join(tmpdir(), 'screenshot-diff-'));
          diffPath = join(tmpDir, 'diff.png');
        } else if (save_diff && diff_output_path) {
          diffPath = diff_output_path;
        }

        const diff = await computeDiff(before_path, after_path, diffPath);

        const changed = diff.pixelPercent ?? 0;
        const passed = changed <= threshold;

        const lines: string[] = [
          passed ? '✓ PASS' : '✗ FAIL',
          `Before: ${before_path}`,
          `After:  ${after_path}`,
          `Method: ${diff.method}`,
        ];

        if (diff.pixelCount !== undefined) {
          lines.push(`Changed pixels: ${diff.pixelCount}`);
        }
        lines.push(`Changed %: ${changed.toFixed(2)}% (threshold: ${threshold}%)`);

        if (!passed) {
          lines.push('');
          lines.push(`Visual regression detected: ${changed.toFixed(2)}% of pixels changed.`);
        }

        if (diff.diffPath && save_diff) {
          lines.push('');
          lines.push(`Diff image saved: ${diff.diffPath}`);
        }

        if (diff.error) {
          lines.push('');
          lines.push(`Note: ${diff.error}`);
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          isError: !passed,
        };
      } finally {
        // Clean up temp dir if we created one and save_diff is false
        if (tmpDir && !save_diff) {
          try { await unlink(join(tmpDir, 'diff.png')); } catch { /* ignore */ }
        }
      }
    },
  );
}
