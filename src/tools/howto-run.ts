import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { RECIPES, REPO_COOKBOOK_PATH, loadCookbook, type Recipe } from './howto.js';
import { runChez, buildPreamble } from '../chez.js';

export function registerHowtoRunTool(server: McpServer): void {
  server.registerTool(
    'jerboa_howto_run',
    {
      title: 'Run Cookbook Recipe',
      description:
        'Execute a cookbook recipe to verify it works in the current Chez/Jerboa environment. ' +
        'Takes a recipe ID, extracts its imports and code, and runs it with a timeout. ' +
        'Reports success/failure with output or error. ' +
        'Useful for validating recipes before recommending them.',
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        recipe_id: z
          .string()
          .describe('The cookbook recipe ID to execute (e.g. "json-parse", "sort-list")'),
        cookbook_path: z
          .string()
          .optional()
          .describe('Path to an additional cookbook JSON file to merge'),
        jerboa_home: z
          .string()
          .optional()
          .describe('Path to Jerboa installation (overrides JERBOA_HOME env var)'),
      },
    },
    async ({ recipe_id, cookbook_path, jerboa_home }) => {
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

      // Find recipe
      const recipe = recipes.find((r) => r.id === recipe_id);
      if (!recipe) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Recipe "${recipe_id}" not found. Use jerboa_howto to search for recipes.`,
            },
          ],
          isError: true,
        };
      }

      if (recipe.deprecated) {
        const supersededMsg = recipe.superseded_by
          ? ` Superseded by: "${recipe.superseded_by}".`
          : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `Recipe "${recipe_id}" is deprecated.${supersededMsg} Try jerboa_howto to find an alternative.`,
            },
          ],
          isError: true,
        };
      }

      // Build and run the script
      const script = buildPreamble(recipe.imports) + '\n' + recipe.code;
      const result = await runChez(script, {
        jerboaHome: jerboa_home,
        timeout: 10_000,
      });

      const sections: string[] = [`## Recipe: ${recipe.title} (\`${recipe.id}\`)\n`];

      if (result.timedOut) {
        sections.push('### Execution: TIMEOUT (10s)\n');
        sections.push('The recipe timed out during execution.');
        return {
          content: [{ type: 'text' as const, text: sections.join('\n') }],
          isError: true,
        };
      }

      if (result.exitCode !== 0) {
        const error = (result.stderr.trim() || result.stdout.trim()) || 'unknown error';
        sections.push('### Execution: ERROR\n');
        sections.push('```\n' + error + '\n```');
        return {
          content: [{ type: 'text' as const, text: sections.join('\n') }],
          isError: true,
        };
      }

      const output = result.stdout.trim();
      sections.push('### Execution: SUCCESS\n');
      if (output) {
        sections.push('Output:\n```\n' + output + '\n```');
      } else {
        sections.push('(no output)');
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
