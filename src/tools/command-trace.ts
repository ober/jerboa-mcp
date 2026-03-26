import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { runChez, escapeSchemeString, buildPreamble, RESULT_MARKER, ERROR_MARKER } from '../chez.js';
import { readFile } from 'node:fs/promises';

export function registerCommandTraceTool(server: McpServer): void {
  server.registerTool(
    'jerboa_command_trace',
    {
      title: 'Command Dispatch Trace',
      description:
        'Traces the dispatch path for a given editor command name. Analyzes the cmd-* function ' +
        'definition to show which cond/match branches exist, what predicates they test ' +
        '(terminal-buffer?, shell-buffer?, etc.), and which branch would fire for a given ' +
        'buffer type. Helps diagnose "why does command X do nothing?" issues without manual ' +
        'REPL probing.',
      annotations: { readOnlyHint: true, idempotentHint: true },
      inputSchema: {
        command_name: z.string().describe('Command name to trace (e.g. "backward-delete-char", "save-buffer", "indent-line")'),
        source_file: z.string().optional().describe('Source file containing the command definition (auto-detected if omitted)'),
        project_path: z.string().optional().describe('Project root to search for the command definition'),
        buffer_type: z.string().optional().describe('Buffer type to trace for (e.g. "terminal", "shell", "text", "scheme")'),
      },
    },
    async ({ command_name, source_file, project_path, buffer_type }) => {
      const cmdFn = `cmd-${command_name}`;

      // Step 1: Find the command definition
      let content: string | null = null;
      let foundFile: string | null = null;

      if (source_file) {
        try {
          content = await readFile(source_file, 'utf-8');
          foundFile = source_file;
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Cannot read file: ${source_file}` }],
            isError: true,
          };
        }
      } else if (project_path) {
        // Search for the command in project files
        const { readdir, stat } = await import('node:fs/promises');
        const { join } = await import('node:path');
        const SKIP = new Set(['.git', 'node_modules', 'dist', '.jerboa', '__pycache__']);

        const searchDir = async (dir: string): Promise<void> => {
          if (content) return;
          let entries: string[];
          try { entries = await readdir(dir); } catch { return; }
          for (const entry of entries) {
            if (content) return;
            if (entry.startsWith('.') || SKIP.has(entry)) continue;
            const full = join(dir, entry);
            try {
              const info = await stat(full);
              if (info.isDirectory()) { await searchDir(full); }
              else if (entry.endsWith('.ss') || entry.endsWith('.sls') || entry.endsWith('.scm')) {
                const text = await readFile(full, 'utf-8');
                if (text.includes(`(def (${cmdFn} `) || text.includes(`(def ${cmdFn} `) ||
                    text.includes(`(define (${cmdFn} `) || text.includes(`(define ${cmdFn} `)) {
                  content = text;
                  foundFile = full;
                }
              }
            } catch { /* skip */ }
          }
        };

        await searchDir(project_path);
      }

      if (!content || !foundFile) {
        return {
          content: [{
            type: 'text' as const,
            text: `Command "${cmdFn}" not found.${project_path ? ` Searched in ${project_path}` : ' Provide source_file or project_path.'}`,
          }],
          isError: true,
        };
      }

      // Step 2: Extract the command definition
      const lines = content.split('\n');
      let defStart = -1;
      for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trimStart();
        if (trimmed.includes(`(def (${cmdFn} `) || trimmed.includes(`(def ${cmdFn} `) ||
            trimmed.includes(`(define (${cmdFn} `) || trimmed.includes(`(define ${cmdFn} `)) {
          defStart = i;
          break;
        }
      }

      if (defStart === -1) {
        return {
          content: [{ type: 'text' as const, text: `Found file ${foundFile} but cannot locate ${cmdFn} definition.` }],
          isError: true,
        };
      }

      // Extract the full form
      let depth = 0;
      let defEnd = defStart;
      for (let i = defStart; i < lines.length; i++) {
        for (const ch of lines[i]) {
          if (ch === '(' || ch === '[') depth++;
          else if (ch === ')' || ch === ']') depth--;
        }
        defEnd = i;
        if (depth <= 0) break;
      }

      const defLines = lines.slice(defStart, defEnd + 1);
      const defText = defLines.join('\n');

      // Step 3: Analyze branches
      const branches: Array<{
        line: number;
        predicate: string;
        body: string;
      }> = [];

      // Find cond/match/case branches
      const condRegex = /\[\s*\(([^)]+)\)/g;
      const predicateRegex = /\b(terminal-buffer\?|shell-buffer\?|text-buffer\?|scheme-buffer\?|minibuffer\?|read-only\?|buffer-modified\?|special-buffer\?)\b/g;

      const allPredicates = new Set<string>();

      for (let i = 0; i < defLines.length; i++) {
        const line = defLines[i];
        const absLine = defStart + i + 1;

        // Find predicates used
        let predMatch;
        while ((predMatch = predicateRegex.exec(line)) !== null) {
          allPredicates.add(predMatch[1]);
        }
        predicateRegex.lastIndex = 0;

        // Find cond branches
        const condMatch = /\[\s*\(([^)]+\??)\s+/.exec(line);
        if (condMatch) {
          // Get the body (next few lines)
          const bodyLines = defLines.slice(i, Math.min(i + 3, defLines.length));
          branches.push({
            line: absLine,
            predicate: condMatch[1].trim(),
            body: bodyLines.map(l => l.trimStart()).join(' ').slice(0, 100),
          });
        }

        // Find else clause
        if (line.trimStart().startsWith('[else') || line.trimStart().startsWith('(else')) {
          branches.push({
            line: absLine,
            predicate: 'else',
            body: defLines.slice(i, Math.min(i + 2, defLines.length)).map(l => l.trimStart()).join(' ').slice(0, 100),
          });
        }
      }

      // Step 4: Build report
      const sections: string[] = [];
      sections.push(`Command Trace: ${cmdFn}`);
      sections.push(`File: ${foundFile}:${defStart + 1}`);
      sections.push(`Lines: ${defStart + 1}-${defEnd + 1} (${defEnd - defStart + 1} lines)`);
      sections.push('');

      // Parameters
      const paramMatch = defText.match(/\(def[ine]*\s+\(?\s*\S+\s+([^)]*)\)/);
      if (paramMatch) {
        sections.push(`Parameters: ${paramMatch[1].trim() || '(none)'}`);
        sections.push('');
      }

      // Predicates used
      if (allPredicates.size > 0) {
        sections.push('Predicates checked:');
        for (const pred of [...allPredicates].sort()) {
          sections.push(`  ${pred}`);
        }
        sections.push('');
      }

      // Dispatch branches
      if (branches.length > 0) {
        sections.push(`Dispatch branches (${branches.length}):`);
        sections.push('');
        for (let i = 0; i < branches.length; i++) {
          const b = branches[i];
          const marker = buffer_type && b.predicate.includes(buffer_type) ? ' <<< MATCHES' : '';
          sections.push(`  ${i + 1}. [${b.predicate}]${marker}`);
          sections.push(`     L${b.line}: ${b.body}...`);
        }
        sections.push('');
      } else {
        sections.push('No cond/match branches detected (may use direct implementation).');
        sections.push('');
      }

      // Show the definition source
      sections.push('Source:');
      for (let i = 0; i < defLines.length; i++) {
        sections.push(`  ${defStart + i + 1}: ${defLines[i]}`);
      }

      if (buffer_type) {
        sections.push('');
        sections.push(`Buffer type filter: "${buffer_type}"`);
        const matching = branches.filter(b => b.predicate.includes(buffer_type));
        if (matching.length > 0) {
          sections.push(`Matching branch: [${matching[0].predicate}] at L${matching[0].line}`);
        } else {
          const elseBranch = branches.find(b => b.predicate === 'else');
          if (elseBranch) {
            sections.push(`No specific branch for "${buffer_type}". Falls through to [else] at L${elseBranch.line}`);
          } else {
            sections.push(`No branch matches "${buffer_type}" and no else clause. Command may silently do nothing!`);
          }
        }
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );
}
