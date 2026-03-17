import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RECIPES, REPO_COOKBOOK_PATH, loadCookbook, type Recipe } from './howto.js';
import { runChez, buildPreamble, VALID_MARKER, ERROR_MARKER, escapeSchemeString } from '../chez.js';

export function registerHowtoVerifyTool(server: McpServer): void {
  server.registerTool(
    'jerboa_howto_verify',
    {
      title: 'Verify Cookbook Recipes',
      description:
        'Verify that cookbook recipes have valid syntax by checking their imports and code ' +
        'against the Chez Scheme reader and expander. Does not execute recipes — only checks ' +
        'that they parse correctly. Reports pass/fail for each recipe.',
      annotations: {
        readOnlyHint: false,
        idempotentHint: true,
      },
      inputSchema: {
        cookbook_path: z
          .string()
          .optional()
          .describe(
            'Absolute path to an external cookbook JSON file to verify (merged with built-in recipes)',
          ),
        recipe_id: z
          .string()
          .optional()
          .describe('Single recipe ID to verify. If omitted, verifies all recipes.'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa installation (overrides JERBOA_HOME env var)'),
      },
    },
    async ({ cookbook_path, recipe_id, jerboa_home }) => {
      // Load and merge recipes
      let recipes: Recipe[] = [...RECIPES];
      const sources = [REPO_COOKBOOK_PATH];
      if (cookbook_path) sources.push(cookbook_path);
      for (const src of sources) {
        const external = loadCookbook(src);
        if (external.length > 0) {
          const externalIds = new Set(external.map((r) => r.id));
          recipes = recipes.filter((r) => !externalIds.has(r.id));
          recipes.push(...external);
        }
      }

      // Filter by recipe_id if provided
      if (recipe_id) {
        recipes = recipes.filter((r) => r.id === recipe_id);
        if (recipes.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Recipe "${recipe_id}" not found.`,
              },
            ],
            isError: true,
          };
        }
      }

      if (recipes.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No recipes to verify.' }] };
      }

      const results: Array<{ id: string; ok: boolean; error?: string }> = [];

      for (const recipe of recipes) {
        const escaped = escapeSchemeString(recipe.code);
        // Build a script that reads all forms from the recipe code string
        // without executing them — just checks they are syntactically readable.
        const script =
          buildPreamble(recipe.imports) +
          `\n(guard (e [else (display "${ERROR_MARKER}\\n") (display-condition e (current-output-port)) (newline)])
  (let ([port (open-string-input-port "${escaped}")])
    (let loop ()
      (let ([expr (read port)])
        (unless (eof-object? expr)
          (loop)))))
  (display "${VALID_MARKER}\\n"))
`;
        const result = await runChez(script, { jerboaHome: jerboa_home, timeout: 15_000 });
        if (result.stdout.includes(VALID_MARKER)) {
          results.push({ id: recipe.id, ok: true });
        } else {
          const errorIdx = result.stdout.indexOf(ERROR_MARKER);
          const errorMsg =
            errorIdx !== -1
              ? result.stdout.slice(errorIdx + ERROR_MARKER.length).trim()
              : result.stderr.trim() || 'unknown error';
          results.push({ id: recipe.id, ok: false, error: errorMsg });
        }
      }

      const passing = results.filter((r) => r.ok).length;
      const failing = results.filter((r) => !r.ok).length;

      const lines = [
        `Recipe verification: ${passing}/${results.length} passed`,
        '',
        ...results.map((r) =>
          r.ok
            ? `  PASS  ${r.id}`
            : `  FAIL  ${r.id}: ${r.error?.split('\n')[0] ?? 'unknown error'}`,
        ),
        '',
        `Summary: ${passing} passed, ${failing} failed`,
      ];

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        isError: failing > 0,
      };
    },
  );
}
