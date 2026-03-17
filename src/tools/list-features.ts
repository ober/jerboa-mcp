import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { FEATURES_PATH } from './suggest-feature.js';
import type { FeatureSuggestion } from './suggest-feature.js';

const MAX_RESULTS = 10;

export function registerListFeaturesTool(server: McpServer): void {
  server.registerTool(
    'jerboa_list_features',
    {
      title: 'List Feature Suggestions',
      description:
        'Search or list existing feature suggestions. ' +
        'If query is provided, searches by tags, title, and description. ' +
        'If no query, returns all suggestions.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        features_path: z
          .string()
          .optional()
          .describe(
            'Absolute path to a JSON features file. If omitted, reads the jerboa-mcp repo features.json.',
          ),
        query: z
          .string()
          .optional()
          .describe('Search keywords to filter suggestions (e.g. "module batch")'),
        jerboa_version: z
          .string()
          .optional()
          .describe(
            'Filter features by Jerboa version (e.g. "v1.0"). ' +
            "When provided, excludes version-tagged features that don't match. " +
            'Untagged features always pass through. If omitted, shows all.',
          ),
      },
    },
    async ({ features_path: explicitPath, query, jerboa_version }) => {
      const features_path = explicitPath || FEATURES_PATH;

      // Load features
      let features: FeatureSuggestion[] = [];
      try {
        const raw = readFileSync(features_path, 'utf-8');
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          features = parsed;
        }
      } catch {
        // File missing or invalid — treat as empty
      }

      // Filter by jerboa_version if provided (untagged features always included)
      if (jerboa_version) {
        features = features.filter(
          (f) => !f.jerboa_version || f.jerboa_version === jerboa_version,
        );
      }

      if (features.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No feature suggestions found.',
            },
          ],
        };
      }

      // If no query, return all
      if (!query || query.trim().length === 0) {
        const lines = formatFeatures(features);
        return {
          content: [
            {
              type: 'text' as const,
              text: `${features.length} feature suggestion(s):\n\n${lines}`,
            },
          ],
        };
      }

      // Keyword search
      const words = query
        .toLowerCase()
        .split(/\s+/)
        .filter((w) => w.length > 0);

      const scored = features.map((feature) => {
        let score = 0;
        for (const word of words) {
          // Tags: weight 5
          for (const tag of feature.tags) {
            if (tag.includes(word) || word.includes(tag)) score += 5;
          }
          // Title: weight 3
          if (feature.title.toLowerCase().includes(word)) score += 3;
          // Description: weight 1
          if (feature.description.toLowerCase().includes(word)) score += 1;
        }
        return { feature, score };
      });

      const matches = scored
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, MAX_RESULTS);

      if (matches.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `No feature suggestions matching "${query}". There are ${features.length} total suggestion(s).`,
            },
          ],
        };
      }

      const lines = formatFeatures(matches.map((m) => m.feature));
      return {
        content: [
          {
            type: 'text' as const,
            text: `Found ${matches.length} suggestion(s) matching "${query}":\n\n${lines}`,
          },
        ],
      };
    },
  );
}

function formatFeatures(features: FeatureSuggestion[]): string {
  return features
    .map((f) => {
      const votes = f.votes ?? 0;
      const versionTag = f.jerboa_version ? ` [${f.jerboa_version}]` : '';
      const parts = [
        `## ${f.title}${versionTag}`,
        `ID: ${f.id}`,
        `Impact: ${f.impact} | Votes: ${votes}`,
        `Tags: ${f.tags.join(', ')}`,
        `Description: ${f.description}`,
        `Use case: ${f.use_case}`,
        `Example: ${f.example_scenario}`,
        `Token reduction: ${f.estimated_token_reduction}`,
      ];
      return parts.join('\n');
    })
    .join('\n\n');
}
