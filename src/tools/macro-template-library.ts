import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

type PatternType =
  | 'hash-accessors'
  | 'method-delegation'
  | 'validation-guards'
  | 'enum-constants'
  | 'event-handlers'
  | 'type-setters';

const PATTERN_TYPES: PatternType[] = [
  'hash-accessors',
  'method-delegation',
  'validation-guards',
  'enum-constants',
  'event-handlers',
  'type-setters',
];

function generateHashAccessors(prefix: string): string {
  return `; Hash accessor macros for ${prefix} objects
(defrule (def-accessor getter field)
  (define (getter obj) (hash-ref obj (quote field))))

(defrule (def-accessor! setter field)
  (define (setter! obj val) (hash-set! obj (quote field) val)))

(defrule (def-accessors (getter setter) field)
  (begin
    (def-accessor getter field)
    (def-accessor! setter field)))

; Usage:
(def-accessors (get-${prefix}-name set-${prefix}-name!) name)
(def-accessors (get-${prefix}-age  set-${prefix}-age!)  age)

; Expands to:
; (define (get-${prefix}-name obj) (hash-ref obj 'name))
; (define (set-${prefix}-name! obj val) (hash-set! obj 'name val))
; (define (get-${prefix}-age obj) (hash-ref obj 'age))
; (define (set-${prefix}-age! obj val) (hash-set! obj 'age val))`;
}

function generateMethodDelegation(prefix: string): string {
  return `; Method delegation macro for ${prefix}
; Delegates method calls from the outer object to an inner component.
(defrule (def-delegate obj-getter method)
  (define (method self . args)
    (apply (send (obj-getter self) (quote method)) args)))

; Usage (delegate multiple methods):
(def-delegate get-${prefix}-inner process)
(def-delegate get-${prefix}-inner render)
(def-delegate get-${prefix}-inner destroy)

; Expands to:
; (define (process self . args)
;   (apply (send (get-${prefix}-inner self) 'process) args))
; (define (render self . args)
;   (apply (send (get-${prefix}-inner self) 'render) args))
; (define (destroy self . args)
;   (apply (send (get-${prefix}-inner self) 'destroy) args))`;
}

function generateValidationGuards(prefix: string): string {
  return `; Validation guard macro for ${prefix}
; Wraps a procedure body with a precondition check.
(defrule (def-validated name pred? error-msg body ...)
  (define name
    (lambda args
      (let ((x (car args)))
        (unless (pred? x)
          (error (quote name) error-msg x))
        body ...)))  )

; Usage:
(def-validated ${prefix}-safe-div
  (lambda (x y) (not (zero? y)))
  "Division by zero"
  (/ x y))

(def-validated ${prefix}-safe-sqrt
  (lambda (x) (>= x 0))
  "Cannot take sqrt of negative number"
  (sqrt x))

; Expands to:
; (define ${prefix}-safe-div
;   (lambda args
;     (let ((x (car args)))
;       (unless ((lambda (x y) (not (zero? y))) x)
;         (error '${prefix}-safe-div "Division by zero" x))
;       (/ x y))))`;
}

function generateEnumConstants(prefix: string): string {
  return `; Enum constant definitions for ${prefix}
; Creates symbol constants for an enumeration.
(defrule (def-enum name val ...)
  (begin
    (define val (quote val)) ...))

; Usage:
(def-enum ${prefix}-colors red green blue yellow)
(def-enum ${prefix}-states idle running stopped error)

; Expands to:
; (define red 'red)
; (define green 'green)
; (define blue 'blue)
; (define yellow 'yellow)
;
; (define idle 'idle)
; (define running 'running)
; (define stopped 'stopped)
; (define error 'error)

; For namespaced enum values, use a prefix variant:
(defrule (def-enum/prefix ns val ...)
  (begin
    (define (string->symbol* s) (string->symbol s))
    (define val
      (string->symbol* (string-append (symbol->string (quote ns)) "/" (symbol->string (quote val)))))
    ...))

; (def-enum/prefix ${prefix} red green blue)
; => ${prefix}/red, ${prefix}/green, ${prefix}/blue`;
}

function generateEventHandlers(prefix: string): string {
  return `; Event handler registration macro for ${prefix}
; Registers a named event handler with a lambda body.
(defrule (on-${prefix}-event event-name handler-body ...)
  (register-event-handler! (quote event-name)
    (lambda (event) handler-body ...)))

; Usage:
(on-${prefix}-event button-click
  (display "Button clicked!\\n")
  (update-ui!))

(on-${prefix}-event window-close
  (display "Window closing\\n")
  (save-state!)
  (exit 0))

; Expands to:
; (register-event-handler! 'button-click
;   (lambda (event)
;     (display "Button clicked!\\n")
;     (update-ui!)))
;
; (register-event-handler! 'window-close
;   (lambda (event)
;     (display "Window closing\\n")
;     (save-state!)
;     (exit 0)))

; Note: Requires register-event-handler! to be defined in scope.
; Verify with: jerboa_module_exports (std event) or your event module.`;
}

function generateTypeSetters(prefix: string): string {
  return `; Type-checked setter macros for ${prefix}
; Creates a setter that validates the value type before assignment.
(defrule (def-typed-setter name type? type-name field)
  (define (name obj val)
    (unless (type? val)
      (error (quote name) (string-append "Expected " type-name) val))
    (hash-set! obj (quote field) val)))

; Usage:
(def-typed-setter set-${prefix}-count! integer? "integer" count)
(def-typed-setter set-${prefix}-label! string? "string" label)
(def-typed-setter set-${prefix}-active! boolean? "boolean" active)

; Expands to:
; (define (set-${prefix}-count! obj val)
;   (unless (integer? val)
;     (error 'set-${prefix}-count! "Expected integer" val))
;   (hash-set! obj 'count val))
;
; (define (set-${prefix}-label! obj val)
;   (unless (string? val)
;     (error 'set-${prefix}-label! "Expected string" val))
;   (hash-set! obj 'label val))
;
; (define (set-${prefix}-active! obj val)
;   (unless (boolean? val)
;     (error 'set-${prefix}-active! "Expected boolean" val))
;   (hash-set! obj 'active val))`;
}

function getTemplate(patternType: PatternType, prefix: string): string {
  switch (patternType) {
    case 'hash-accessors':
      return generateHashAccessors(prefix);
    case 'method-delegation':
      return generateMethodDelegation(prefix);
    case 'validation-guards':
      return generateValidationGuards(prefix);
    case 'enum-constants':
      return generateEnumConstants(prefix);
    case 'event-handlers':
      return generateEventHandlers(prefix);
    case 'type-setters':
      return generateTypeSetters(prefix);
  }
}

export function registerMacroTemplateLibraryTool(server: McpServer): void {
  server.registerTool(
    'jerboa_macro_template_library',
    {
      title: 'Macro Template Library',
      description:
        'Generate reusable macro templates for common Jerboa patterns. ' +
        'Supports: hash-accessors, method-delegation, validation-guards, enum-constants, ' +
        'event-handlers, type-setters. Returns working defrule definitions with examples.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        pattern_type: z
          .enum([
            'hash-accessors',
            'method-delegation',
            'validation-guards',
            'enum-constants',
            'event-handlers',
            'type-setters',
          ])
          .describe(
            'Pattern type: hash-accessors, method-delegation, validation-guards, ' +
              'enum-constants, event-handlers, type-setters',
          ),
        prefix: z
          .string()
          .optional()
          .describe('Naming prefix for the generated definitions (default: "my")'),
      },
    },
    async ({ pattern_type, prefix }) => {
      const resolvedPrefix = prefix ?? 'my';
      const patternType = pattern_type as PatternType;

      if (!PATTERN_TYPES.includes(patternType)) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `Unknown pattern type: ${pattern_type}\n` +
                `Available patterns: ${PATTERN_TYPES.join(', ')}`,
            },
          ],
          isError: true,
        };
      }

      const template = getTemplate(patternType, resolvedPrefix);

      const output = [
        `## Macro Template: ${patternType} (prefix: "${resolvedPrefix}")`,
        '',
        '```scheme',
        template,
        '```',
        '',
        '**Note**: These templates use `defrule` (syntax-rules style). ' +
          'Verify macro hygiene with `jerboa_macro_hygiene_check` and ' +
          'check expansion with `jerboa_expand_macro`.',
      ];

      return { content: [{ type: 'text' as const, text: output.join('\n') }] };
    },
  );
}
