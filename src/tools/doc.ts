import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, buildPreamble, escapeSchemeString, ERROR_MARKER } from '../chez.js';
import { loadCookbook, REPO_COOKBOOK_PATH, RECIPES, type Recipe } from './howto.js';

const INFO_MARKER = 'JERBOA-MCP-INFO:';

const MAX_EXAMPLE_LINES = 12;

/**
 * Score recipes for a given symbol/module pair. Higher is better.
 * Heuristics:
 *   - exact tag match: +5
 *   - module path appears in recipe.imports: +3
 *   - bare symbol appears in recipe.code as its own token: +2
 *   - title contains symbol: +1
 */
function scoreRecipeForSymbol(
  recipe: Recipe,
  symbol: string,
  modulePath: string | undefined,
): number {
  let score = 0;
  const lowerSym = symbol.toLowerCase();

  for (const tag of recipe.tags) {
    if (tag.toLowerCase() === lowerSym) score += 5;
    else if (tag.toLowerCase().includes(lowerSym)) score += 1;
  }

  if (modulePath) {
    for (const imp of recipe.imports) {
      if (imp === modulePath || imp.includes(modulePath)) score += 3;
    }
  }

  // Token boundary check on the code body
  const tokenRe = new RegExp(`(^|[\\s(\\[{])${escapeForRegex(symbol)}([\\s)\\]}]|$)`);
  if (tokenRe.test(recipe.code)) score += 2;

  if (recipe.title.toLowerCase().includes(lowerSym)) score += 1;

  if (recipe.deprecated) score = Math.round(score * 0.2);

  return score;
}

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find a single best-matching recipe whose code demonstrates `symbol`. Returns
 * undefined if nothing scores above zero.
 */
function findUsageExample(symbol: string, modulePath?: string): Recipe | undefined {
  const all: Recipe[] = [...RECIPES, ...loadCookbook(REPO_COOKBOOK_PATH)];
  let best: Recipe | undefined;
  let bestScore = 0;
  for (const r of all) {
    const s = scoreRecipeForSymbol(r, symbol, modulePath);
    if (s > bestScore) {
      bestScore = s;
      best = r;
    }
  }
  return bestScore > 0 ? best : undefined;
}

function trimExampleCode(code: string): string {
  const lines = code.split('\n');
  if (lines.length <= MAX_EXAMPLE_LINES) return code;
  return lines.slice(0, MAX_EXAMPLE_LINES).join('\n') + '\n;; … (truncated)';
}

export function registerDocTool(server: McpServer): void {
  server.registerTool(
    'jerboa_doc',
    {
      title: 'Symbol Documentation',
      description:
        'Look up info about a Jerboa/Chez Scheme symbol: its type (procedure/macro/record/value), ' +
        'arity, and description. Optionally import a module to bring the symbol into scope. ' +
        'Example: symbol "sort" with module_path "(std sort)".',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        symbol: z.string().describe('Symbol name to look up (e.g. "sort", "read-json")'),
        module_path: z
          .string()
          .optional()
          .describe('Module to import for context (e.g. "(std text json)"). If omitted, searches current environment.'),
        jerboa_home: z.string().optional(),
      },
    },
    async ({ symbol, module_path, jerboa_home }) => {
      const escapedSym = escapeSchemeString(symbol);
      const preamble = buildPreamble(module_path ? [module_path] : []);

      const code = `${preamble}

(guard (e [else
           (display "${ERROR_MARKER}\\n")
           (display-condition e (current-output-port))])
  (let ((val (eval '${symbol} (interaction-environment))))
    (cond
      ((procedure? val)
       (display "${INFO_MARKER}kind\\tprocedure\\n")
       (display "${INFO_MARKER}name\\t${escapedSym}\\n")
       ; Try to get arity via procedure-arity if available
       (guard (e2 [else (void)])
         (let ((arity (procedure-arity val)))
           (display "${INFO_MARKER}arity\\t")
           (write arity)
           (newline))))
      ((record-type-descriptor? val)
       (display "${INFO_MARKER}kind\\trecord-type\\n")
       (display "${INFO_MARKER}name\\t")
       (display (record-type-name val))
       (newline)
       (display "${INFO_MARKER}fields\\t")
       (let ((fields (record-type-field-names val)))
         (let loop ((i 0))
           (when (< i (vector-length fields))
             (display (vector-ref fields i))
             (display " ")
             (loop (+ i 1)))))
       (newline))
      (else
       (display "${INFO_MARKER}kind\\tvalue\\n")
       (display "${INFO_MARKER}name\\t${escapedSym}\\n")
       (display "${INFO_MARKER}value\\t")
       (write val)
       (newline)))))
`;

      const result = await runChez(code, { jerboaHome: jerboa_home });

      if (result.timedOut) {
        return { content: [{ type: 'text' as const, text: 'Symbol lookup timed out.' }], isError: true };
      }

      const stdout = result.stdout;

      const errorIdx = stdout.indexOf(ERROR_MARKER);
      if (errorIdx !== -1) {
        const errorMsg = stdout.slice(errorIdx + ERROR_MARKER.length).trim();
        return {
          content: [{ type: 'text' as const, text: `Error looking up "${symbol}":\n${errorMsg}` }],
          isError: true,
        };
      }

      const infoLines = stdout.split('\n').filter((l) => l.startsWith(INFO_MARKER));

      if (infoLines.length === 0) {
        return {
          content: [{ type: 'text' as const, text: `No information found for symbol "${symbol}".` }],
        };
      }

      const info: Record<string, string> = {};
      for (const line of infoLines) {
        const payload = line.slice(INFO_MARKER.length);
        const tabIdx = payload.indexOf('\t');
        if (tabIdx === -1) continue;
        info[payload.slice(0, tabIdx)] = payload.slice(tabIdx + 1).trim();
      }

      const sections: string[] = [`Symbol: ${symbol}`, ''];
      if (info['kind']) sections.push(`Kind: ${info['kind']}`);
      if (info['name'] && info['name'] !== symbol) sections.push(`Name: ${info['name']}`);
      if (info['arity']) sections.push(`Arity: ${info['arity']}`);
      if (info['fields']) sections.push(`Fields: ${info['fields']}`);
      if (info['value']) sections.push(`Value: ${info['value']}`);
      if (module_path) sections.push(`Module: ${module_path}`);

      const example = findUsageExample(symbol, module_path);
      if (example) {
        sections.push('');
        sections.push(`Usage example (cookbook: ${example.id}):`);
        sections.push('```scheme');
        sections.push(trimExampleCode(example.code));
        sections.push('```');
      }

      return { content: [{ type: 'text' as const, text: sections.join('\n') }] };
    },
  );
}
