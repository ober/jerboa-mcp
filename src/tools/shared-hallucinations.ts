export const KNOWN_HALLUCINATIONS: Record<string, string> = {
  'symbol<?': 'generic string comparison (string<? (symbol->string a) (symbol->string b))',
  'hash-has-key?': 'hash-key?',
  'string-contains?': 'string-contains',
  'define-struct': 'defstruct',
  'string-map': '(list->string (map f (string->list s)))',
  'environment-bound?': 'this function does not exist',
  'time->seconds': '(time-second (current-time))',
  'thread-sleep!': "(sleep (make-time 'time-duration 0 seconds))",
  'thread-yield': "(sleep (make-time 'time-duration 0 0))",
  'read-line': 'get-line',
  'process-status': 'Use (std misc process) API',
  'user-info-home': '(getenv "HOME")',
  'the-environment': '(interaction-environment)',
  'condition/report-string': '(with-output-to-string (lambda () (display-condition c)))',
  'force-output': 'flush-output-port',
  'make-class-type': 'defstruct or defclass',
  'string-subst': 'string-replace',
  'random-integer': 'random',
  'open-fd-pair': 'this function does not exist',
  'make-equal-hashtable': 'make-hash-table',
  'hash-table-set!': 'hash-put!',
  'arithmetic-shift': 'bitwise-arithmetic-shift or ash',
  'pregexp-match': '(std text regex) API',
};

export function injectHallucinationHints(errorMsg: string): string {
  let result = errorMsg;
  // Match Unbound identifier or variable errors
  const extractIdentifierMatch = errorMsg.match(/(?:unbound identifier|variable|not bound) ([^\s]+)/i);
  if (extractIdentifierMatch && extractIdentifierMatch[1]) {
    const ident = extractIdentifierMatch[1].replace(/['`.]/g, ''); // Clean up quotes if present
    if (KNOWN_HALLUCINATIONS[ident]) {
      result += `\n\nHint: Did you mean \`${KNOWN_HALLUCINATIONS[ident]}\`? \`${ident}\` is a known hallucination.`;
    }
  } else {
    // Fallback: just scan the error message for any known hallucinated identifier
    for (const [hallucination, suggestion] of Object.entries(KNOWN_HALLUCINATIONS)) {
      if (errorMsg.includes(hallucination)) {
        result += `\n\nHint: Did you mean \`${suggestion}\`? \`${hallucination}\` is a known hallucination.`;
        break; // Only append one hint
      }
    }
  }
  return result;
}
