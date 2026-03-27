import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export function registerDbPatternScaffoldTool(server: McpServer): void {
  server.registerTool(
    'jerboa_db_pattern_scaffold',
    {
      title: 'Database Pattern Scaffold',
      description:
        'Generate database access patterns with connection management, transactions, and error ' +
        'handling. Supports SQLite via (std db sqlite) and PostgreSQL via (std db postgresql).',
      annotations: {
        readOnlyHint: true,
        idempotentHint: true,
      },
      inputSchema: {
        db_type: z
          .enum(['sqlite', 'postgresql'])
          .describe('Database type'),
        tables: z
          .array(
            z.object({
              name: z.string().describe('Table name'),
              columns: z.array(
                z.object({
                  name: z.string().describe('Column name'),
                  type: z.string().describe('SQL type (TEXT, INTEGER, etc.)'),
                  primary_key: z.coerce.boolean().optional(),
                }),
              ).describe('Column definitions'),
            }),
          )
          .describe('Table definitions'),
        use_pool: z
          .boolean()
          .optional()
          .describe('Include connection pooling comments (default: true)'),
      },
    },
    async ({ db_type, tables, use_pool }) => {
      const withPool = use_pool !== false;
      const sections: string[] = [];

      // Imports
      sections.push(`;;; Database access layer — ${db_type}`);
      sections.push('(import (jerboa prelude))');
      if (db_type === 'sqlite') {
        sections.push('(import (std db sqlite))');
      } else {
        sections.push('(import (std db postgresql))');
      }
      sections.push('');

      // Exports
      sections.push('(export');
      sections.push('  connect!');
      sections.push('  disconnect!');
      sections.push('  with-transaction');
      for (const table of tables) {
        sections.push(`  create-${table.name}-table!`);
        sections.push(`  insert-${table.name}!`);
        sections.push(`  get-${table.name}`);
        sections.push(`  list-${table.name}s`);
        sections.push(`  update-${table.name}!`);
        sections.push(`  delete-${table.name}!`);
      }
      sections.push(')');
      sections.push('');

      // Connection management
      sections.push(';;; Connection management');
      sections.push('(define *conn* #f)');
      sections.push('');

      if (db_type === 'sqlite') {
        sections.push('(define (connect! db-path)');
        sections.push('  (set! *conn* (sqlite-open db-path)))');
      } else {
        sections.push('(define (connect! host port db user password)');
        sections.push('  (set! *conn* (postgresql-connect');
        sections.push('    host: host port: port db: db user: user password: password)))');
      }
      sections.push('');
      sections.push('(define (disconnect!)');
      sections.push('  (when *conn*');
      if (db_type === 'sqlite') {
        sections.push('    (sqlite-close *conn*)');
      } else {
        sections.push('    (postgresql-close *conn*)');
      }
      sections.push('    (set! *conn* #f)))');
      sections.push('');

      if (withPool) {
        sections.push(';;; NOTE: For production use, consider a connection pool wrapper');
        sections.push(';;; that manages multiple connections for concurrent access.');
        sections.push('');
      }

      // Transaction wrapper
      sections.push(';;; Transaction wrapper with rollback on error');
      sections.push('(define (with-transaction thunk)');
      if (db_type === 'sqlite') {
        sections.push('  (sqlite-exec *conn* "BEGIN")');
        sections.push('  (guard (e [else');
        sections.push('            (sqlite-exec *conn* "ROLLBACK")');
        sections.push('            (raise e)])');
        sections.push('    (let ((result (thunk *conn*)))');
        sections.push('      (sqlite-exec *conn* "COMMIT")');
        sections.push('      result)))');
      } else {
        sections.push('  (postgresql-exec *conn* "BEGIN")');
        sections.push('  (guard (e [else');
        sections.push('            (postgresql-exec *conn* "ROLLBACK")');
        sections.push('            (raise e)])');
        sections.push('    (let ((result (thunk *conn*)))');
        sections.push('      (postgresql-exec *conn* "COMMIT")');
        sections.push('      result)))');
      }
      sections.push('');

      // CRUD for each table
      for (const table of tables) {
        const pk = table.columns.find((c) => c.primary_key) || table.columns[0];
        const nonPkCols = table.columns.filter((c) => c !== pk);

        sections.push(`;;; === ${table.name} ===`);
        sections.push('');

        // Create table
        const colDefs = table.columns.map((c) => {
          let def = `${c.name} ${c.type}`;
          if (c.primary_key) def += ' PRIMARY KEY';
          return def;
        }).join(', ');

        sections.push(`(define (create-${table.name}-table! conn)`);
        if (db_type === 'sqlite') {
          sections.push(`  (sqlite-exec conn "CREATE TABLE IF NOT EXISTS ${table.name} (${colDefs})"))`);
        } else {
          sections.push(`  (postgresql-exec conn "CREATE TABLE IF NOT EXISTS ${table.name} (${colDefs})"))`);
        }
        sections.push('');

        // Insert
        const insertCols = nonPkCols.map((c) => c.name).join(', ');
        const insertPlaceholders = db_type === 'sqlite'
          ? nonPkCols.map((_, i) => `?${i + 1}`).join(', ')
          : nonPkCols.map((_, i) => `$${i + 1}`).join(', ');
        const insertParams = nonPkCols.map((c) => c.name).join(' ');

        sections.push(`(define (insert-${table.name}! conn ${insertParams})`);
        if (db_type === 'sqlite') {
          sections.push(`  (sqlite-exec conn "INSERT INTO ${table.name} (${insertCols}) VALUES (${insertPlaceholders})" ${insertParams}))`);
        } else {
          sections.push(`  (postgresql-exec conn "INSERT INTO ${table.name} (${insertCols}) VALUES (${insertPlaceholders})" ${insertParams}))`);
        }
        sections.push('');

        // Get by PK
        const getPh = db_type === 'sqlite' ? '?1' : '$1';
        sections.push(`(define (get-${table.name} conn ${pk.name})`);
        if (db_type === 'sqlite') {
          sections.push(`  (let ((rows (sqlite-query conn "SELECT * FROM ${table.name} WHERE ${pk.name} = ${getPh}" ${pk.name})))`);
        } else {
          sections.push(`  (let ((rows (postgresql-query conn "SELECT * FROM ${table.name} WHERE ${pk.name} = ${getPh}" ${pk.name})))`);
        }
        sections.push('    (if (null? rows) #f (car rows))))');
        sections.push('');

        // List all
        sections.push(`(define (list-${table.name}s conn)`);
        if (db_type === 'sqlite') {
          sections.push(`  (sqlite-query conn "SELECT * FROM ${table.name}"))`);
        } else {
          sections.push(`  (postgresql-query conn "SELECT * FROM ${table.name}"))`);
        }
        sections.push('');

        // Update
        if (nonPkCols.length > 0) {
          const setClauses = db_type === 'sqlite'
            ? nonPkCols.map((c, i) => `${c.name} = ?${i + 1}`).join(', ')
            : nonPkCols.map((c, i) => `${c.name} = $${i + 1}`).join(', ');
          const updatePkPh = db_type === 'sqlite'
            ? `?${nonPkCols.length + 1}`
            : `$${nonPkCols.length + 1}`;
          const updateParams = nonPkCols.map((c) => c.name).join(' ');
          sections.push(`(define (update-${table.name}! conn ${pk.name} ${updateParams})`);
          if (db_type === 'sqlite') {
            sections.push(`  (sqlite-exec conn "UPDATE ${table.name} SET ${setClauses} WHERE ${pk.name} = ${updatePkPh}" ${updateParams} ${pk.name}))`);
          } else {
            sections.push(`  (postgresql-exec conn "UPDATE ${table.name} SET ${setClauses} WHERE ${pk.name} = ${updatePkPh}" ${updateParams} ${pk.name}))`);
          }
        }
        sections.push('');

        // Delete
        sections.push(`(define (delete-${table.name}! conn ${pk.name})`);
        if (db_type === 'sqlite') {
          sections.push(`  (sqlite-exec conn "DELETE FROM ${table.name} WHERE ${pk.name} = ${getPh}" ${pk.name}))`);
        } else {
          sections.push(`  (postgresql-exec conn "DELETE FROM ${table.name} WHERE ${pk.name} = ${getPh}" ${pk.name}))`);
        }
        sections.push('');
      }

      const code = sections.join('\n');

      const output = [
        `## Database Pattern Scaffold: ${db_type}`,
        '',
        `Tables: ${tables.length}`,
        `Connection pooling: ${withPool ? 'comment included' : 'omitted'}`,
        '',
        '```scheme',
        code,
        '```',
        '',
        '### Usage',
        '```scheme',
        db_type === 'sqlite'
          ? '(connect! "my-database.db")'
          : '(connect! "localhost" 5432 "mydb" "user" "password")',
        '',
        '(with-transaction',
        '  (lambda (conn)',
        `    (create-${tables[0]?.name || 'example'}-table! conn)`,
        '    ;; ... more operations',
        '  ))',
        '',
        '(disconnect!)',
        '```',
        '',
        '**Note**: Verify DB API with `jerboa_module_exports (std db sqlite)` — ',
        'the exact function names may vary between Jerboa versions.',
      ];

      return {
        content: [{ type: 'text' as const, text: output.join('\n') }],
      };
    },
  );
}
