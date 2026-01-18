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

export interface ClaudeCodeResult {
  success: boolean;
  output: string;
  plan?: string;
  filesChanged?: string[];
  summary?: string;
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
    // Normalize the repo path (resolve to absolute, ensure consistent format)
    const normalizedRepoPath = path.resolve(this.repoPath);
    
    // Clean the relative path (remove leading slashes, normalize)
    const cleanRelativePath = relativePath.replace(/^\/+/, '').replace(/\.\.\//g, '');
    
    // Resolve the full path
    const resolved = path.resolve(normalizedRepoPath, cleanRelativePath);
    
    // Security check: ensure resolved path is within repo
    if (!resolved.startsWith(normalizedRepoPath + path.sep) && resolved !== normalizedRepoPath) {
      console.error(`Path traversal blocked: ${relativePath} resolved to ${resolved}, repo is ${normalizedRepoPath}`);
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

  /**
   * Run Claude Code CLI to generate a plan (no changes made)
   * Returns a detailed plan of what Claude Code would do
   */
  async runClaudeCodePlan(task: string): Promise<ClaudeCodeResult> {
    const planPrompt = `Analyze this task and create a detailed implementation plan. DO NOT make any changes yet.
List exactly which files you would modify or create, and what changes you would make to each.

Task: ${task}

Output format:
## Files to Modify
- path/to/file1.ts: description of changes
- path/to/file2.ts: description of changes

## New Files to Create
- path/to/new-file.ts: purpose

## Implementation Steps
1. Step one
2. Step two
...

## Estimated Complexity
Simple/Medium/Complex

DO NOT execute any changes. Only provide the plan.`;

    try {
      // Check if Claude Code CLI is available
      try {
        await execAsync('which claude || command -v claude', { cwd: this.repoPath });
      } catch {
        return {
          success: false,
          output: '',
          error: 'Claude Code CLI not installed. Falling back to basic tools.',
        };
      }

      const escapedPrompt = planPrompt.replace(/"/g, '\\"').replace(/\n/g, '\\n');
      const command = `claude --print "${escapedPrompt}"`;

      console.log('[ClaudeCode] Generating plan...');
      
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.repoPath,
        maxBuffer: 1024 * 1024 * 10, // 10MB
        timeout: 300000, // 5 minute timeout for planning
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
      });

      const output = stdout + (stderr ? `\n${stderr}` : '');
      
      // Parse files from the plan
      const filesChanged = this.parseFilesFromPlan(output);

      return {
        success: true,
        output: this.truncateOutput(output),
        plan: output,
        filesChanged,
        summary: this.summarizePlan(output),
      };
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; message: string };
      console.error('[ClaudeCode] Plan generation failed:', execError.message);
      return {
        success: false,
        output: execError.stdout || '',
        error: execError.stderr || execError.message,
      };
    }
  }

  /**
   * Run Claude Code CLI to execute a task (makes actual changes)
   * Should only be called after plan is approved
   */
  async runClaudeCodeExecute(task: string, approvedPlan?: string): Promise<ClaudeCodeResult> {
    try {
      // Check if Claude Code CLI is available
      try {
        await execAsync('which claude || command -v claude', { cwd: this.repoPath });
      } catch {
        return {
          success: false,
          output: '',
          error: 'Claude Code CLI not installed.',
        };
      }

      const executePrompt = approvedPlan 
        ? `Execute this approved plan:\n\n${approvedPlan}\n\nOriginal task: ${task}`
        : task;

      const escapedPrompt = executePrompt.replace(/"/g, '\\"').replace(/\n/g, '\\n');
      
      // --print outputs to stdout, --dangerously-skip-permissions allows autonomous changes
      const command = `claude --print --dangerously-skip-permissions "${escapedPrompt}"`;

      console.log('[ClaudeCode] Executing task...');
      
      const { stdout, stderr } = await execAsync(command, {
        cwd: this.repoPath,
        maxBuffer: 1024 * 1024 * 10, // 10MB
        timeout: 600000, // 10 minute timeout for execution
        env: {
          ...process.env,
          ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
        },
      });

      const output = stdout + (stderr ? `\n${stderr}` : '');
      
      // Try to find which files were modified
      const filesChanged = await this.getModifiedFiles();

      return {
        success: true,
        output: this.truncateOutput(output),
        filesChanged,
        summary: this.summarizeExecution(output, filesChanged),
      };
    } catch (error) {
      const execError = error as { stdout?: string; stderr?: string; message: string };
      console.error('[ClaudeCode] Execution failed:', execError.message);
      return {
        success: false,
        output: execError.stdout || '',
        error: execError.stderr || execError.message,
      };
    }
  }

  /**
   * Get list of modified files using git status
   */
  private async getModifiedFiles(): Promise<string[]> {
    try {
      const { stdout } = await execAsync('git status --porcelain', { cwd: this.repoPath });
      return stdout
        .split('\n')
        .filter(line => line.trim())
        .map(line => line.slice(3).trim()); // Remove status prefix (M, A, etc.)
    } catch {
      return [];
    }
  }

  /**
   * Parse file paths from a Claude Code plan
   */
  private parseFilesFromPlan(plan: string): string[] {
    const files: string[] = [];
    const lines = plan.split('\n');
    
    for (const line of lines) {
      // Match patterns like "- path/to/file.ts:" or "- `path/to/file.ts`"
      const match = line.match(/^-\s+[`"]?([^:`"]+\.[a-z]+)[`"]?:/i);
      if (match) {
        files.push(match[1].trim());
      }
    }
    
    return [...new Set(files)]; // Remove duplicates
  }

  /**
   * Create a brief summary of the plan
   */
  private summarizePlan(plan: string): string {
    const files = this.parseFilesFromPlan(plan);
    const hasNewFiles = plan.toLowerCase().includes('new files to create');
    
    let summary = `📋 **Plan Summary**\n`;
    summary += `- Files to modify: ${files.length}\n`;
    if (hasNewFiles) summary += `- Will create new files\n`;
    
    // Extract complexity if present
    const complexityMatch = plan.match(/estimated complexity[:\s]*(simple|medium|complex)/i);
    if (complexityMatch) {
      summary += `- Complexity: ${complexityMatch[1]}\n`;
    }
    
    return summary;
  }

  /**
   * Create a brief summary of execution results
   */
  private summarizeExecution(output: string, filesChanged: string[]): string {
    let summary = `✅ **Claude Code Execution Complete**\n`;
    summary += `- Files changed: ${filesChanged.length}\n`;
    
    if (filesChanged.length > 0) {
      summary += `- Modified:\n`;
      for (const file of filesChanged.slice(0, 10)) {
        summary += `  - ${file}\n`;
      }
      if (filesChanged.length > 10) {
        summary += `  - ... and ${filesChanged.length - 10} more\n`;
      }
    }
    
    return summary;
  }
}

