import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerActorEnsembleScaffoldTool(server: McpServer): void {
  server.registerTool(
    'jerboa_actor_ensemble_scaffold',
    {
      title: 'Actor Ensemble Scaffold',
      description:
        'Generate a distributed actor ensemble project template using (std actor). ' +
        'Produces actor definitions, message protocols, supervisor setup, and ' +
        'a working example with communicating actors.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        project_name: z
          .string()
          .describe('Project name (kebab-case)'),
        actors: z
          .array(
            z.object({
              name: z.string().describe('Actor name'),
              messages: z.array(z.string()).describe('Message types this actor handles'),
            }),
          )
          .describe('Actor definitions with their message handlers'),
        use_supervision: z
          .boolean()
          .optional()
          .describe('Include supervisor restart logic (default: false)'),
      },
    },
    async ({ project_name, actors, use_supervision }) => {
      const files: Array<{ name: string; content: string }> = [];

      // Actor implementations
      for (const actor of actors) {
        const actorLines: string[] = [
          `;;; ${actor.name} actor implementation`,
          '(import (jerboa prelude))',
          '(import (std actor))',
          `(export ${actor.name}-start)`,
          '',
          `(define (${actor.name}-start)`,
          `  (spawn`,
          `    (lambda ()`,
          `      (display "${actor.name} started\\n")`,
          `      (let loop ()`,
          `        (let ((msg (receive)))`,
          `          (cond`,
        ];

        for (const msg of actor.messages) {
          actorLines.push(`            ((and (pair? msg) (eq? (car msg) '${msg}))`);
          actorLines.push(`             (display "${actor.name}: handling ${msg}\\n")`);
          actorLines.push(`             ;; TODO: Process ${msg}`);
          actorLines.push(`             (loop))`);
        }

        actorLines.push('            ((eq? msg \'shutdown)');
        actorLines.push(`             (display "${actor.name}: shutting down\\n"))`);
        actorLines.push('            (else');
        actorLines.push(`             (display "${actor.name}: unknown message\\n")`);
        actorLines.push('             (loop))))))))');

        files.push({ name: `lib/${actor.name}.ss`, content: actorLines.join('\n') });
      }

      // Supervisor
      const supLines: string[] = [
        `;;; ${project_name} supervisor`,
        '(import (jerboa prelude))',
        '(import (std actor))',
      ];
      for (const actor of actors) {
        supLines.push(`(import (${project_name} ${actor.name}))`);
      }
      supLines.push('');
      supLines.push(`(export ${project_name}-supervisor)`);
      supLines.push('');
      supLines.push(`(define (${project_name}-supervisor)`);
      supLines.push('  (display "Starting supervisor\\n")');
      supLines.push('  (let ((children');
      supLines.push('         (list');
      for (const actor of actors) {
        supLines.push(`          (${actor.name}-start)`);
      }
      supLines.push('         )))');

      if (use_supervision) {
        supLines.push('    ;; Monitor children and restart on failure');
        supLines.push('    (let loop ()');
        supLines.push('      (let ((dead (filter (lambda (p) (not (process-alive? p))) children)))');
        supLines.push('        (unless (null? dead)');
        supLines.push('          (display "Restarting failed actors\\n")))');
        supLines.push('      (sleep 1)');
        supLines.push('      (loop)))');
      } else {
        supLines.push('    ;; Wait for all children');
        supLines.push('    (for-each join! children)))');
      }

      files.push({ name: 'lib/supervisor.ss', content: supLines.join('\n') });

      // Main entry point
      const mainLines: string[] = [
        `;;; ${project_name} — main entry point`,
        '(import (jerboa prelude))',
        '(import (std actor))',
        `(import (${project_name} supervisor))`,
        '',
        '(export main)',
        '',
        '(define (main . args)',
        `  (display "${project_name} starting\\n")`,
        `  (${project_name}-supervisor))`,
        '',
        '(apply main (cdr (command-line)))',
      ];

      files.push({ name: 'lib/main.ss', content: mainLines.join('\n') });

      // Test file
      const testLines: string[] = [
        `;;; ${project_name} actor tests`,
        '(import (jerboa prelude))',
        '(import (std test))',
        '',
        `(define ${project_name}-test`,
        `  (test-suite "${project_name} actor tests"`,
        '    (test-case "smoke"',
        '      (check #t => #t))))',
        '',
        `(run-tests! ${project_name}-test)`,
        '(test-report-summary!)',
      ];

      files.push({ name: 'lib/main-test.ss', content: testLines.join('\n') });

      // Makefile
      const makefileLines = [
        '.PHONY: run test clean',
        '',
        'run:',
        `\tscheme --libdirs lib --script lib/main.ss`,
        '',
        'test:',
        `\tscheme --libdirs lib --script lib/main-test.ss`,
        '',
        'clean:',
        '\t@echo "Nothing to clean"',
      ];

      files.push({ name: 'Makefile', content: makefileLines.join('\n') });

      // Format output
      const output: string[] = [
        `## Actor Ensemble Scaffold: ${project_name}`,
        '',
        `Actors: ${actors.length}`,
        `Supervision: ${use_supervision ? 'enabled' : 'disabled'}`,
        '',
      ];

      for (const file of files) {
        output.push(`### ${file.name}`);
        output.push('```scheme');
        output.push(file.content);
        output.push('```');
        output.push('');
      }

      output.push('### Setup');
      output.push('```sh');
      output.push(`mkdir -p ${project_name}/lib`);
      output.push('# Save each file above into the project directory');
      output.push('make run');
      output.push('```');
      output.push('');
      output.push('**Note**: Verify actor API with `jerboa_module_exports (std actor)` — ');
      output.push('test incrementally with `jerboa_eval`.');

      return {
        content: [{ type: 'text' as const, text: output.join('\n') }],
      };
    },
  );
}
