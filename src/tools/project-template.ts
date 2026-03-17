import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

interface TemplateFile {
  path: string;
  content: string;
}

interface ProjectTemplate {
  name: string;
  description: string;
  files: (projectName: string, packageName: string) => TemplateFile[];
}

const TEMPLATES: Record<string, ProjectTemplate> = {
  'cli': {
    name: 'CLI Tool with Subcommands',
    description: 'Command-line application with argument parsing and subcommands',
    files: (proj, pkg) => [
      {
        path: 'lib/main.ss',
        content: `(import (jerboa prelude))
(import (std os))

(define (main . args)
  (let ((cmd (if (pair? args) (car args) "help")))
    (cond
      ((equal? cmd "run") (run-command (if (pair? args) (cdr args) '())))
      ((equal? cmd "version") (display "${proj} v0.1.0\\n"))
      (else (display "Usage: ${proj} <run|version>\\n")))))

(define (run-command args)
  (let ((input (if (pair? args) (car args) #f)))
    (if input
      (display (string-append "Processing: " input "\\n"))
      (display "No input specified\\n"))))

(apply main (cdr (command-line)))
`,
      },
      {
        path: 'Makefile',
        content: `.PHONY: build clean test run

build:
\t@echo "No build step needed for script mode"

run:
\tscheme --libdirs lib --script lib/main.ss

test:
\tscheme --libdirs lib --script lib/main-test.ss

clean:
\t@echo "Nothing to clean"
`,
      },
      {
        path: 'lib/main-test.ss',
        content: `(import (jerboa prelude))
(import (std test))

(define main-test
  (test-suite "${proj} tests"
    (test-case "smoke test"
      (check #t => #t))))

(run-tests! main-test)
(test-report-summary!)
`,
      },
    ],
  },
  'http-api': {
    name: 'HTTP API Server',
    description: 'REST API server with JSON endpoints using (std net http)',
    files: (proj, pkg) => [
      {
        path: 'lib/main.ss',
        content: `(import (jerboa prelude))
(import (std net http))
(import (std text json))

(define (json-response status obj)
  (list status '(("Content-Type" . "application/json")) (json->string obj)))

(define (health-handler req)
  (json-response 200 '((status . "ok"))))

(define (echo-handler req)
  (let ((body (http-request-body req)))
    (json-response 200 \`((echo . ,(or (and body (utf8->string body)) ""))))))

(define (main . args)
  (let ((port (if (pair? args) (string->number (car args)) 8080)))
    (display (string-append "Starting server on port " (number->string port) "\\n"))
    (http-serve port
      (lambda (req)
        (let ((path (http-request-path req)))
          (cond
            ((equal? path "/api/health") (health-handler req))
            ((equal? path "/api/echo") (echo-handler req))
            (else (json-response 404 '((error . "Not found"))))))))))

(apply main (cdr (command-line)))
`,
      },
      {
        path: 'Makefile',
        content: `.PHONY: run test clean

run:
\tscheme --libdirs lib --script lib/main.ss

test:
\tscheme --libdirs lib --script lib/main-test.ss

clean:
\t@echo "Nothing to clean"
`,
      },
      {
        path: 'lib/main-test.ss',
        content: `(import (jerboa prelude))
(import (std test))

(define main-test
  (test-suite "${proj} http tests"
    (test-case "smoke"
      (check #t => #t))))

(run-tests! main-test)
(test-report-summary!)
`,
      },
    ],
  },
  'library': {
    name: 'Library Package',
    description: 'Reusable library with public API, internal modules, and tests',
    files: (proj, pkg) => [
      {
        path: 'lib/interface.ss',
        content: `(import (jerboa prelude))
(export hello process)

;; Public API for ${proj}
;; Import this module: (import (${pkg} interface))

(define (hello name)
  (string-append "Hello, " name "!"))

(define (process data)
  ;; TODO: implement
  data)
`,
      },
      {
        path: 'lib/impl.ss',
        content: `(import (jerboa prelude))
(export internal-helper)

;; Internal implementation details
;; Not part of the public API

(define (internal-helper x)
  (* x 2))
`,
      },
      {
        path: 'lib/main-test.ss',
        content: `(import (jerboa prelude))
(import (std test))
(import (${pkg} interface))
(export main-test)

(define main-test
  (test-suite "${proj} tests"
    (test-case "hello"
      (check (hello "World") => "Hello, World!"))))

(run-tests! main-test)
(test-report-summary!)
`,
      },
      {
        path: 'Makefile',
        content: `.PHONY: test clean

test:
\tscheme --libdirs lib --script lib/main-test.ss

clean:
\t@echo "Nothing to clean"
`,
      },
    ],
  },
  'actor-service': {
    name: 'Actor-Based Service',
    description: 'Service using the actor model with message passing',
    files: (proj, pkg) => [
      {
        path: 'lib/worker.ss',
        content: `(import (jerboa prelude))
(import (std actor))
(export start-worker!)

(define (start-worker! id)
  (spawn
    (lambda ()
      (let loop ()
        (let ((msg (receive)))
          (cond
            ((eq? (car msg) 'work)
             (display (string-append "worker " (number->string id) " got: "))
             (display (cadr msg))
             (newline)
             (loop))
            ((eq? (car msg) 'shutdown)
             (display (string-append "worker " (number->string id) " stopping\\n")))))))))
`,
      },
      {
        path: 'lib/main.ss',
        content: `(import (jerboa prelude))
(import (std actor))
(import (${pkg} worker))
(export main)

(define (main . args)
  (display "${proj} starting\\n")
  (let ((workers (map start-worker! '(0 1 2 3))))
    (for-each (lambda (w) (send! w \`(work "hello"))) workers)
    (for-each (lambda (w) (send! w '(shutdown))) workers)))

(apply main (cdr (command-line)))
`,
      },
      {
        path: 'Makefile',
        content: `.PHONY: run test clean

run:
\tscheme --libdirs lib --script lib/main.ss

test:
\tscheme --libdirs lib --script lib/worker-test.ss

clean:
\t@echo "Nothing to clean"
`,
      },
      {
        path: 'lib/worker-test.ss',
        content: `(import (jerboa prelude))
(import (std test))

(define worker-test
  (test-suite "${proj} actor tests"
    (test-case "smoke"
      (check #t => #t))))

(run-tests! worker-test)
(test-report-summary!)
`,
      },
    ],
  },
  'db-crud': {
    name: 'Database CRUD Application',
    description: 'SQLite-backed application with CRUD operations',
    files: (proj, pkg) => [
      {
        path: 'lib/db.ss',
        content: `(import (jerboa prelude))
(import (std db sqlite))
(export connect! close! with-db)

(define *db* #f)

(define (connect! path)
  (set! *db* (sqlite-open path)))

(define (close!)
  (when *db*
    (sqlite-close *db*)
    (set! *db* #f)))

(define (with-db fn)
  (unless *db* (error "Database not initialized"))
  (fn *db*))
`,
      },
      {
        path: 'lib/model.ss',
        content: `(import (jerboa prelude))
(import (std db sqlite))
(import (${pkg} db))
(export create-table! insert-item! list-items get-item delete-item!)

(define (create-table!)
  (with-db (lambda (db)
    (sqlite-exec db
      "CREATE TABLE IF NOT EXISTS items (id INTEGER PRIMARY KEY, name TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP)"))))

(define (insert-item! name)
  (with-db (lambda (db)
    (sqlite-exec db "INSERT INTO items (name) VALUES (?)" name))))

(define (list-items)
  (with-db (lambda (db)
    (sqlite-query db "SELECT id, name, created_at FROM items ORDER BY id"))))

(define (get-item id)
  (with-db (lambda (db)
    (let ((rows (sqlite-query db "SELECT id, name, created_at FROM items WHERE id = ?" id)))
      (if (null? rows) #f (car rows))))))

(define (delete-item! id)
  (with-db (lambda (db)
    (sqlite-exec db "DELETE FROM items WHERE id = ?" id))))
`,
      },
      {
        path: 'lib/main.ss',
        content: `(import (jerboa prelude))
(import (${pkg} db))
(import (${pkg} model))
(export main)

(define (main . args)
  (connect! "app.db")
  (create-table!)
  (insert-item! "First item")
  (insert-item! "Second item")
  (display "All items:\\n")
  (for-each (lambda (item) (display (string-append "  " (object->string item) "\\n")))
    (list-items))
  (close!))

(apply main (cdr (command-line)))
`,
      },
      {
        path: 'Makefile',
        content: `.PHONY: run test clean

run:
\tscheme --libdirs lib --script lib/main.ss

test:
\tscheme --libdirs lib --script lib/model-test.ss

clean:
\trm -f app.db
`,
      },
      {
        path: 'lib/model-test.ss',
        content: `(import (jerboa prelude))
(import (std test))
(import (${pkg} db))
(import (${pkg} model))

(define model-test
  (test-suite "${proj} model tests"
    (test-case "create and query"
      (connect! ":memory:")
      (create-table!)
      (insert-item! "test item")
      (let ((items (list-items)))
        (check (length items) => 1))
      (close!))))

(run-tests! model-test)
(test-report-summary!)
`,
      },
    ],
  },
  'parser': {
    name: 'Parser/Compiler',
    description: 'Language parser with lexer, grammar, and AST',
    files: (proj, pkg) => [
      {
        path: 'lib/lexer.ss',
        content: `(import (jerboa prelude))
(export tokenize token-type token-value make-token)

(define-record-type token
  (make-token type value)
  token?
  (type token-type)
  (value token-value))

(define (tokenize input)
  (let loop ((chars (string->list input)) (tokens '()))
    (cond
      ((null? chars) (reverse tokens))
      ((char-whitespace? (car chars))
       (loop (cdr chars) tokens))
      ((char-numeric? (car chars))
       (let num-loop ((cs (cdr chars)) (digits (list (car chars))))
         (if (and (pair? cs) (char-numeric? (car cs)))
           (num-loop (cdr cs) (cons (car cs) digits))
           (loop cs (cons (make-token 'number (string->number (list->string (reverse digits))))
                         tokens)))))
      ((memv (car chars) '(#\\+ #\\- #\\* #\\/))
       (loop (cdr chars) (cons (make-token 'op (car chars)) tokens)))
      (else (error "Unexpected character" (car chars))))))
`,
      },
      {
        path: 'lib/ast.ss',
        content: `(import (jerboa prelude))
(export make-literal literal-value make-binop binop-op binop-left binop-right)

;; AST node types

(define-record-type literal
  (make-literal value)
  literal?
  (value literal-value))

(define-record-type binop
  (make-binop op left right)
  binop?
  (op binop-op)
  (left binop-left)
  (right binop-right))
`,
      },
      {
        path: 'lib/main.ss',
        content: `(import (jerboa prelude))
(import (${pkg} lexer))
(import (${pkg} ast))
(export main)

(define (main . args)
  (let* ((input (if (pair? args) (car args) "1 + 2"))
         (tokens (tokenize input)))
    (display (string-append "Input: " input "\\n"))
    (display "Tokens: ")
    (display tokens)
    (newline)))

(apply main (cdr (command-line)))
`,
      },
      {
        path: 'Makefile',
        content: `.PHONY: run test clean

run:
\tscheme --libdirs lib --script lib/main.ss "1 + 2"

test:
\tscheme --libdirs lib --script lib/lexer-test.ss

clean:
\t@echo "Nothing to clean"
`,
      },
      {
        path: 'lib/lexer-test.ss',
        content: `(import (jerboa prelude))
(import (std test))
(import (${pkg} lexer))

(define lexer-test
  (test-suite "${proj} lexer tests"
    (test-case "tokenize number"
      (let ((tokens (tokenize "42")))
        (check (length tokens) => 1)
        (check (token-type (car tokens)) => 'number)
        (check (token-value (car tokens)) => 42)))))

(run-tests! lexer-test)
(test-report-summary!)
`,
      },
    ],
  },
  'test-project': {
    name: 'Test-Heavy Project',
    description: 'Project structure optimized for testing with multiple test files',
    files: (proj, pkg) => [
      {
        path: 'lib/core.ss',
        content: `(import (jerboa prelude))
(export process-data transform-item batch-transform)

;; Core module

(define (process-data items)
  (filter (lambda (x) (> x 0)) items))

(define (transform-item x)
  (* x 2))

(define (batch-transform items)
  (map transform-item (process-data items)))
`,
      },
      {
        path: 'lib/util.ss',
        content: `(import (jerboa prelude))
(export safe-divide clamp)

;; Utility functions

(define (safe-divide a b)
  (if (zero? b) #f (/ a b)))

(define (clamp val lo hi)
  (max lo (min hi val)))
`,
      },
      {
        path: 'lib/core-test.ss',
        content: `(import (jerboa prelude))
(import (std test))
(import (${pkg} core))
(export core-test)

(define core-test
  (test-suite "core tests"
    (test-case "process-data filters negatives"
      (check (process-data '(1 -2 3 -4 5)) => '(1 3 5)))
    (test-case "process-data empty list"
      (check (process-data '()) => '()))
    (test-case "transform-item doubles"
      (check (transform-item 5) => 10))
    (test-case "batch-transform end-to-end"
      (check (batch-transform '(1 -2 3)) => '(2 6)))))

(run-tests! core-test)
(test-report-summary!)
`,
      },
      {
        path: 'lib/util-test.ss',
        content: `(import (jerboa prelude))
(import (std test))
(import (${pkg} util))
(export util-test)

(define util-test
  (test-suite "util tests"
    (test-case "safe-divide normal"
      (check (safe-divide 10 2) => 5))
    (test-case "safe-divide by zero"
      (check (safe-divide 10 0) => #f))
    (test-case "clamp within range"
      (check (clamp 5 0 10) => 5))
    (test-case "clamp below"
      (check (clamp -5 0 10) => 0))
    (test-case "clamp above"
      (check (clamp 15 0 10) => 10))))

(run-tests! util-test)
(test-report-summary!)
`,
      },
      {
        path: 'Makefile',
        content: `.PHONY: test clean

test: test-core test-util

test-core:
\tscheme --libdirs lib --script lib/core-test.ss

test-util:
\tscheme --libdirs lib --script lib/util-test.ss

clean:
\t@echo "Nothing to clean"
`,
      },
    ],
  },
};

export function registerProjectTemplateTool(server: McpServer): void {
  server.registerTool(
    'jerboa_project_template',
    {
      title: 'Generate Project from Template',
      description:
        'Generate a complete multi-file Jerboa project from a template. ' +
        'Available templates: cli (CLI tool), http-api (REST server), ' +
        'library (reusable lib with tests), actor-service (actor message passing), ' +
        'db-crud (SQLite CRUD), parser (lexer+grammar+AST), ' +
        'test-project (test-heavy structure). ' +
        'Each template includes a Makefile, source modules under lib/, and tests. ' +
        'Uses scheme --libdirs lib --script for running.',
      annotations: {
        readOnlyHint: false,
        idempotentHint: false,
      },
      inputSchema: {
        template: z
          .enum(['cli', 'http-api', 'library', 'actor-service', 'db-crud', 'parser', 'test-project'])
          .describe('Template type to generate'),
        project_name: z
          .string()
          .describe('Project name (e.g. "my-app"). Used for directory name and display.'),
        output_dir: z
          .string()
          .describe('Parent directory where the project directory will be created'),
        package_name: z
          .string()
          .optional()
          .describe('Package name for Chez imports (default: derived from project_name)'),
        list_templates: z
          .boolean()
          .optional()
          .describe('If true, list available templates instead of generating'),
      },
    },
    async ({ template, project_name, output_dir, package_name, list_templates }) => {
      // List mode
      if (list_templates) {
        const sections: string[] = ['Available project templates:\n'];
        for (const [id, tmpl] of Object.entries(TEMPLATES)) {
          sections.push(`  **${id}** — ${tmpl.name}`);
          sections.push(`    ${tmpl.description}\n`);
        }
        return {
          content: [{ type: 'text' as const, text: sections.join('\n') }],
        };
      }

      const tmpl = TEMPLATES[template];
      if (!tmpl) {
        return {
          content: [{
            type: 'text' as const,
            text: `Unknown template: ${template}. Available: ${Object.keys(TEMPLATES).join(', ')}`,
          }],
          isError: true,
        };
      }

      const pkg = package_name || project_name.replace(/-/g, '_');
      const projectDir = join(output_dir, project_name);

      if (existsSync(projectDir)) {
        return {
          content: [{
            type: 'text' as const,
            text: `Directory already exists: ${projectDir}`,
          }],
          isError: true,
        };
      }

      // Create project directory and files
      try {
        mkdirSync(projectDir, { recursive: true });
        const files = tmpl.files(project_name, pkg);

        for (const file of files) {
          const filePath = join(projectDir, file.path);
          const dir = join(filePath, '..');
          mkdirSync(dir, { recursive: true });
          writeFileSync(filePath, file.content, 'utf-8');
        }

        const sections: string[] = [
          `Created ${tmpl.name} project: ${projectDir}\n`,
          'Files:',
        ];
        for (const file of files) {
          sections.push(`  ${file.path}`);
        }
        sections.push('');
        sections.push('Next steps:');
        sections.push(`  cd ${projectDir}`);
        sections.push('  make test');
        sections.push('');
        sections.push('Run with:');
        sections.push('  scheme --libdirs lib --script lib/main.ss');

        return {
          content: [{ type: 'text' as const, text: sections.join('\n') }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text' as const,
            text: `Failed to create project: ${err instanceof Error ? err.message : String(err)}`,
          }],
          isError: true,
        };
      }
    },
  );
}
