import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const HIERARCHY_TEXT = `R6RS/Chez Scheme Condition Type Hierarchy
==========================================

&condition (base type)
├── &serious
│   ├── &error
│   │   ├── &i/o
│   │   │   ├── &i/o-read
│   │   │   ├── &i/o-write
│   │   │   ├── &i/o-invalid-position
│   │   │   ├── &i/o-filename (has filename field)
│   │   │   │   ├── &i/o-file-protection
│   │   │   │   ├── &i/o-file-is-read-only
│   │   │   │   ├── &i/o-file-already-exists
│   │   │   │   └── &i/o-file-does-not-exist
│   │   │   ├── &i/o-port (has port field)
│   │   │   │   └── &i/o-decoding
│   │   │   │       └── &i/o-encoding
│   │   │   └── &i/o-port-scheme-file-info
│   │   └── (Chez extensions)
│   │       ├── &implementation-restriction
│   │       └── &lexical
│   └── &violation
│       ├── &assertion
│       ├── &non-continuable
│       ├── &no-infinities (Chez)
│       └── &no-nans (Chez)
├── &warning
├── &message (mixin, has message field)
├── &irritants (mixin, has irritants field)
├── &who (mixin, has who field)
├── &continuation (Chez)
├── &source-position (Chez, has filename/line/column)
└── &format (Chez, format string conditions)

Jerboa/Prelude Additional Conditions:
├── &jerboa-error (base for Jerboa errors)
│   ├── &type-error (type mismatch)
│   ├── &import-error (module not found)
│   └── &syntax-error (parse/syntax failure)

Usage:
  (guard (e [(&error? e) (condition/message e)]
            [(&assertion-violation? e) "assertion failed"]
            [else "unknown error"])
    ...)

  (condition? e)           ; any condition?
  (&serious? e)            ; serious condition?
  (condition/message e)    ; extract message
  (condition/irritants e)  ; extract irritants`;

export function registerErrorHierarchyTool(server: McpServer): void {
  server.registerTool(
    'jerboa_error_hierarchy',
    {
      title: 'Error/Condition Type Hierarchy',
      description:
        'Display the Chez Scheme / R6RS condition type hierarchy. ' +
        'Shows the inheritance tree of condition types: &condition, &serious, &error, ' +
        '&violation, &assertion, &message, &irritants, &who, &warning, etc.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        jerboa_home: z.string().optional().describe('Path to Jerboa home directory (unused, for consistency)'),
      },
    },
    async (_args) => {
      return {
        content: [
          {
            type: 'text' as const,
            text: HIERARCHY_TEXT,
          },
        ],
      };
    },
  );
}
