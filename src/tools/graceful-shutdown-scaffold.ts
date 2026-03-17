import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerGracefulShutdownScaffoldTool(server: McpServer): void {
  server.registerTool(
    'jerboa_graceful_shutdown_scaffold',
    {
      title: 'Graceful Shutdown Scaffold',
      description:
        'Generate graceful shutdown patterns for long-running Jerboa services. ' +
        'Produces signal handler registration, shutdown coordination across threads, ' +
        'resource cleanup with dynamic-wind, and proper exit codes.',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        service_name: z
          .string()
          .describe('Name for the service'),
        components: z
          .array(z.string())
          .describe('Service components that need cleanup (e.g. "http-server", "db-pool", "worker-threads")'),
        has_actors: z
          .boolean()
          .optional()
          .describe('Include actor system shutdown (default: false)'),
      },
    },
    async ({ service_name, components, has_actors }) => {
      const sections: string[] = [];

      sections.push(`;;; ${service_name} — Graceful shutdown framework`);
      sections.push('(import (jerboa prelude))');
      sections.push('(import (std os signal))');
      if (has_actors) {
        sections.push('(import (std actor))');
      }
      sections.push('');

      sections.push('(export');
      sections.push('  start-service!');
      sections.push('  shutdown!');
      sections.push('  with-shutdown-hook)');
      sections.push('');

      // Shutdown state
      sections.push(';;; Shutdown coordination');
      sections.push('(define *shutdown-requested* #f)');
      sections.push('(define *cleanup-hooks* \'())');
      sections.push('(define *shutdown-mutex* (make-mutex))');
      sections.push('');

      // Register cleanup hook
      sections.push(';;; Register a cleanup function to run during shutdown');
      sections.push('(define (register-cleanup! name thunk)');
      sections.push('  (with-mutex *shutdown-mutex*');
      sections.push('    (lambda ()');
      sections.push('      (set! *cleanup-hooks*');
      sections.push('        (cons (cons name thunk) *cleanup-hooks*)))))');
      sections.push('');

      // Convenience wrapper
      sections.push(';;; Convenience: start a component and register its cleanup');
      sections.push('(define (with-shutdown-hook name start-fn cleanup-fn)');
      sections.push('  (let ((result (start-fn)))');
      sections.push('    (register-cleanup! name (lambda () (cleanup-fn result)))');
      sections.push('    result))');
      sections.push('');

      // Shutdown function
      sections.push(';;; Execute shutdown sequence');
      sections.push('(define (shutdown! (exit-code 0))');
      sections.push('  (with-mutex *shutdown-mutex*');
      sections.push('    (lambda ()');
      sections.push('      (when (not *shutdown-requested*)');
      sections.push('        (set! *shutdown-requested* #t)');
      sections.push('');
      sections.push(`        (display "${service_name}: Initiating graceful shutdown...\\n")`);
      sections.push('');

      // Shutdown each component
      for (const comp of components) {
        sections.push(`        ;; Stop ${comp}`);
        sections.push(`        (display "Stopping ${comp}...\\n")`);
      }
      sections.push('');

      sections.push('        ;; Run registered cleanup hooks in reverse order');
      sections.push('        (for-each');
      sections.push('          (lambda (hook)');
      sections.push('            (let ((name (car hook))');
      sections.push('                  (cleanup (cdr hook)))');
      sections.push('              (display (string-append "Cleanup: " (symbol->string name) "\\n"))');
      sections.push('              (guard (e [else');
      sections.push('                        (display (string-append "Cleanup failed for " (symbol->string name) "\\n"))])');
      sections.push('                (cleanup))))');
      sections.push('          *cleanup-hooks*)');
      sections.push('');

      if (has_actors) {
        sections.push('        ;; Shutdown actor system');
        sections.push('        (display "Stopping actor system...\\n")');
        sections.push('        ;; (actor-system-shutdown!)');
        sections.push('');
      }

      sections.push(`        (display "${service_name}: Shutdown complete.\\n")`);
      sections.push('        (exit exit-code)))))');
      sections.push('');

      // Signal handlers
      sections.push(';;; Install signal handlers');
      sections.push('(define (install-signal-handlers!)');
      sections.push('  ;; SIGTERM — graceful shutdown (e.g. from systemd, docker)');
      sections.push('  (signal-handler-set! (signal-name->number "SIGTERM")');
      sections.push('    (lambda (sig)');
      sections.push(`      (display "${service_name}: Received SIGTERM\\n")`);
      sections.push('      (shutdown!)))');
      sections.push('');
      sections.push('  ;; SIGINT — Ctrl+C');
      sections.push('  (signal-handler-set! (signal-name->number "SIGINT")');
      sections.push('    (lambda (sig)');
      sections.push(`      (display "${service_name}: Received SIGINT\\n")`);
      sections.push('      (shutdown!))))');
      sections.push('');

      // Main service starter
      sections.push(';;; Start service with signal handlers and shutdown coordination');
      sections.push('(define (start-service! main-fn)');
      sections.push(`  (display "${service_name}: Starting...\\n")`);
      sections.push('');
      sections.push('  ;; Install signal handlers');
      sections.push('  (install-signal-handlers!)');
      sections.push('');
      sections.push('  ;; Run main function with cleanup guarantee');
      sections.push('  (dynamic-wind');
      sections.push('    (lambda () (void))');
      sections.push('    (lambda ()');
      sections.push('      (guard (e [else');
      sections.push(`        (display "${service_name}: Fatal error\\n")`);
      sections.push('        (shutdown! 1)])');
      sections.push('        (main-fn)))');
      sections.push('    (lambda () (shutdown! 0))))');
      sections.push('');

      // Example usage
      sections.push(`;;; Example usage for ${service_name}:`);
      sections.push(';;;');
      sections.push(';;; (start-service!');
      sections.push(';;;   (lambda ()');

      for (const comp of components) {
        sections.push(`;;;     (with-shutdown-hook '${comp.replace(/[^a-zA-Z0-9]/g, '-')}`);
        sections.push(`;;;       (lambda () (start-${comp.replace(/[^a-zA-Z0-9]/g, '-')}!))`);
        sections.push(`;;;       (lambda (instance) (stop-${comp.replace(/[^a-zA-Z0-9]/g, '-')}! instance)))`);
      }

      sections.push(';;;');
      sections.push(';;;     ;; Block until shutdown');
      sections.push(';;;     (thread-join! (current-thread))))');

      const code = sections.join('\n');

      const output = [
        `## Graceful Shutdown Scaffold: ${service_name}`,
        '',
        `Components: ${components.join(', ')}`,
        `Actor system: ${has_actors ? 'yes' : 'no'}`,
        '',
        '```scheme',
        code,
        '```',
        '',
        '### Features',
        '- SIGTERM/SIGINT signal handling via (std os signal)',
        '- Registered cleanup hooks (run in reverse order)',
        '- Thread-safe shutdown coordination with mutex',
        '- dynamic-wind for guaranteed cleanup',
        '- Error-tolerant cleanup (catches and logs failures)',
        '',
        '**Note**: Verify signal handler API with `jerboa_module_exports (std os signal)`.',
      ];

      return {
        content: [{ type: 'text' as const, text: output.join('\n') }],
      };
    },
  );
}
