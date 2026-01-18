import Anthropic from '@anthropic-ai/sdk';

// READ-ONLY tools for context-gathering agents (Clarifier, Scope, Designer, Planner)
export const READ_ONLY_TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file to understand existing code, configs, or documentation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to repository root (e.g., "src/components/Button.tsx", "package.json")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories to explore the codebase structure.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to repository root. Use "." for root.',
        },
        recursive: {
          type: 'boolean',
          description: 'If true, list all files recursively (default: false). Use sparingly on large directories.',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for text or patterns in the codebase. Use to find relevant files, components, or patterns.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Text or regex pattern to search for (e.g., "useState", "export function", "TODO")',
        },
        file_glob: {
          type: 'string',
          description: 'Optional glob pattern to filter files (e.g., "*.ts", "*.tsx", "*.json")',
        },
      },
      required: ['pattern'],
    },
  },
];

// Full tool definitions for Implementer (includes read + write + commands)
export const CODE_TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read the contents of a file. Use this to understand existing code before making changes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to repository root (e.g., "src/components/Button.tsx")',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates the file if it doesn\'t exist, overwrites if it does.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to repository root',
        },
        content: {
          type: 'string',
          description: 'The full content to write to the file',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories in a path. Use this to explore the codebase structure.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Directory path relative to repository root. Use "." for root.',
        },
        recursive: {
          type: 'boolean',
          description: 'If true, list all files recursively (default: false)',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_code',
    description: 'Search for text or patterns in the codebase. Returns matching lines with file paths.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: {
          type: 'string',
          description: 'Text or regex pattern to search for',
        },
        file_glob: {
          type: 'string',
          description: 'Optional glob pattern to filter files (e.g., "*.ts", "src/**/*.tsx")',
        },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'run_command',
    description: 'Run a shell command. Use for npm scripts, tests, builds. Commands are run from repo root.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'The command to run (e.g., "npm test", "npm run build")',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'apply_diff',
    description: 'Apply a targeted edit to a file. Better than write_file for small changes to large files.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'File path relative to repository root',
        },
        original: {
          type: 'string',
          description: 'The exact original text to find (must match exactly)',
        },
        replacement: {
          type: 'string',
          description: 'The text to replace it with',
        },
      },
      required: ['path', 'original', 'replacement'],
    },
  },
];

// Whitelist of allowed commands for safety
export const ALLOWED_COMMANDS = [
  'npm test',
  'npm run test',
  'npm run build',
  'npm run lint',
  'npm run type-check',
  'npm run typecheck',
  'npm install',
  'npm ci',
  'npx tsc --noEmit',
  'npx eslint',
  'npx prettier',
];

// Files/directories the agent should not modify
export const PROTECTED_PATHS = [
  '.env',
  '.env.local',
  '.env.production',
  '.git',
  'node_modules',
  'package-lock.json',
  '.github/workflows', // Don't let it modify CI
];

