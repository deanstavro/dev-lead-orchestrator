import * as fs from 'fs/promises';
import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { ALLOWED_COMMANDS, PROTECTED_PATHS } from './definitions.js';

const execAsync = promisify(exec);

export interface ToolResult {
  success: boolean;
  output: string;
  error?: string;
}

export class ToolExecutor {
  private repoPath: string;
  private maxOutputLength = 10000; // Limit output to avoid token explosion

  constructor(repoPath: string) {
    this.repoPath = repoPath;
  }

  async execute(toolName: string, input: Record<string, unknown>): Promise<ToolResult> {
    try {
      switch (toolName) {
        case 'read_file':
          return await this.readFile(input.path as string);
        case 'write_file':
          return await this.writeFile(input.path as string, input.content as string);
        case 'list_directory':
          return await this.listDirectory(input.path as string, input.recursive as boolean);
        case 'search_code':
          return await this.searchCode(input.pattern as string, input.file_glob as string);
        case 'run_command':
          return await this.runCommand(input.command as string);
        case 'apply_diff':
          return await this.applyDiff(input.path as string, input.original as string, input.replacement as string);
        default:
          return { success: false, output: '', error: `Unknown tool: ${toolName}` };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { success: false, output: '', error: message };
    }
  }

  private resolvePath(relativePath: string): string {
    // Prevent directory traversal
    const resolved = path.resolve(this.repoPath, relativePath);
    if (!resolved.startsWith(this.repoPath)) {
      throw new Error('Path traversal not allowed');
    }
    return resolved;
  }

  private isProtectedPath(relativePath: string): boolean {
    return PROTECTED_PATHS.some(
      (protected_) =>
        relativePath === protected_ ||
        relativePath.startsWith(protected_ + '/') ||
        relativePath.startsWith(protected_ + '\\')
    );
  }

  private truncateOutput(output: string): string {
    if (output.length > this.maxOutputLength) {
      return output.slice(0, this.maxOutputLength) + '\n... (output truncated)';
    }
    return output;
  }

  async readFile(filePath: string): Promise<ToolResult> {
    const fullPath = this.resolvePath(filePath);
    const content = await fs.readFile(fullPath, 'utf-8');
    return {
      success: true,
      output: this.truncateOutput(content),
    };
  }

  async writeFile(filePath: string, content: string): Promise<ToolResult> {
    if (this.isProtectedPath(filePath)) {
      return { success: false, output: '', error: `Cannot modify protected path: ${filePath}` };
    }

    const fullPath = this.resolvePath(filePath);
    
    // Ensure directory exists
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    
    return {
      success: true,
      output: `Successfully wrote ${content.length} characters to ${filePath}`,
    };
  }

  async listDirectory(dirPath: string, recursive = false): Promise<ToolResult> {
    const fullPath = this.resolvePath(dirPath);

    if (recursive) {
      const entries = await this.listRecursive(fullPath, dirPath);
      return {
        success: true,
        output: this.truncateOutput(entries.join('\n')),
      };
    }

    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const output = entries
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .map((e) => (e.isDirectory() ? `${e.name}/` : e.name))
      .sort()
      .join('\n');

    return {
      success: true,
      output: this.truncateOutput(output),
    };
  }

  private async listRecursive(fullPath: string, relativePath: string): Promise<string[]> {
    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const results: string[] = [];

    for (const entry of entries) {
      // Skip hidden files and node_modules
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

      const entryRelative = path.join(relativePath, entry.name);
      
      if (entry.isDirectory()) {
        results.push(entryRelative + '/');
        const subEntries = await this.listRecursive(
          path.join(fullPath, entry.name),
          entryRelative
        );
        results.push(...subEntries);
      } else {
        results.push(entryRelative);
      }
    }

    return results;
  }

  async searchCode(pattern: string, fileGlob?: string): Promise<ToolResult> {
    // Use grep for searching (available in GitHub Actions runner)
    let command = `grep -rn "${pattern.replace(/"/g, '\\"')}" --include="*.ts" --include="*.tsx" --include="*.js" --include="*.jsx" --include="*.json" --include="*.css" --include="*.html"`;
    
    if (fileGlob) {
      command = `grep -rn "${pattern.replace(/"/g, '\\"')}" --include="${fileGlob}"`;
    }

    try {
      const { stdout } = await execAsync(command, {
        cwd: this.repoPath,
        maxBuffer: 1024 * 1024, // 1MB buffer
      });
      return {
        success: true,
        output: this.truncateOutput(stdout),
      };
    } catch (error) {
      // grep returns exit code 1 when no matches found
      if ((error as { code?: number }).code === 1) {
        return { success: true, output: 'No matches found' };
      }
      throw error;
    }
  }

  async runCommand(command: string): Promise<ToolResult> {
    // Security: Only allow whitelisted commands
    const isAllowed = ALLOWED_COMMANDS.some(
      (allowed) => command === allowed || command.startsWith(allowed + ' ')
    );

    if (!isAllowed) {
      return {
        success: false,
        output: '',
        error: `Command not allowed. Allowed commands: ${ALLOWED_COMMANDS.join(', ')}`,
      };
    }

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.repoPath,
        maxBuffer: 1024 * 1024 * 5, // 5MB buffer for test output
        timeout: 300000, // 5 minute timeout
      });

      const output = stdout + (stderr ? `\nSTDERR:\n${stderr}` : '');
      return {
        success: true,
        output: this.truncateOutput(output),
      };
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; message: string };
      return {
        success: false,
        output: this.truncateOutput(execError.stdout || ''),
        error: execError.stderr || execError.message,
      };
    }
  }

  async applyDiff(filePath: string, original: string, replacement: string): Promise<ToolResult> {
    if (this.isProtectedPath(filePath)) {
      return { success: false, output: '', error: `Cannot modify protected path: ${filePath}` };
    }

    const fullPath = this.resolvePath(filePath);
    const content = await fs.readFile(fullPath, 'utf-8');

    if (!content.includes(original)) {
      return {
        success: false,
        output: '',
        error: 'Original text not found in file. Make sure it matches exactly (including whitespace).',
      };
    }

    // Only replace first occurrence
    const newContent = content.replace(original, replacement);
    await fs.writeFile(fullPath, newContent, 'utf-8');

    return {
      success: true,
      output: `Successfully applied diff to ${filePath}`,
    };
  }
}

