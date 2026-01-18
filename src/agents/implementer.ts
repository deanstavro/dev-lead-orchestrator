import Anthropic from '@anthropic-ai/sdk';
import { AgentContext, ConversationMessage } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';
import { CODE_TOOLS } from '../tools/definitions.js';
import { ToolExecutor } from '../tools/executor.js';

const anthropic = new Anthropic();

const MAX_ITERATIONS = 50; // Safety limit

const SYSTEM_PROMPT = `You are an expert software developer implementing a feature based on a plan.

Your goal is to:
1. Understand the existing codebase structure
2. Implement the changes described in the plan
3. Make sure the code compiles/builds
4. Run tests to verify your changes work

Guidelines:
- Start by exploring the codebase structure with list_directory
- Read relevant files before modifying them
- Make small, incremental changes
- Run tests frequently to catch issues early
- Use apply_diff for small changes to existing files
- Use write_file for new files or complete rewrites
- Follow existing code patterns and conventions

When you have successfully implemented all changes and tests pass, respond with:
IMPLEMENTATION_COMPLETE

If you encounter a blocker you cannot resolve, respond with:
IMPLEMENTATION_BLOCKED: <reason>`;

export async function runImplementer(context: AgentContext): Promise<void> {
  const { session, payload } = context;
  const { source_repo, issue_number } = payload;

  if (!issue_number) throw new Error('Missing issue_number');

  const repoPath = process.env.REPO_PATH || process.env.GITHUB_WORKSPACE || './source-repo';
  
  console.log(`Running implementer for ${source_repo}#${issue_number}`);
  console.log(`Repository path: ${repoPath}`);

  await githubService.postComment(
    source_repo,
    issue_number,
    `🔧 **Implementation Started**\n\nI'm now implementing the planned changes. This may take a few minutes...\n\nPlan being executed:\n${session.metadata.plan || 'No plan found'}`
  );

  const executor = new ToolExecutor(repoPath);

  // Build initial context from session
  const implementationContext = `
## Task
Implement the following feature based on the plan.

## Issue
Title: ${session.metadata.issue_title || 'N/A'}
Description: ${session.metadata.issue_body || 'N/A'}

## Scope
${session.metadata.scope || 'No scope defined'}

## Technical Design
${session.metadata.design || 'No design defined'}

## Implementation Plan
${session.metadata.plan || 'No plan defined'}

Begin by exploring the codebase, then implement the changes step by step.`;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: implementationContext },
  ];

  let iterations = 0;
  const changedFiles: string[] = [];

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`Implementation iteration ${iterations}/${MAX_ITERATIONS}`);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      tools: CODE_TOOLS,
      messages,
    });

    // Check for completion or blocking
    let isComplete = false;
    let isBlocked = false;
    let blockReason = '';
    let assistantText = '';

    for (const block of response.content) {
      if (block.type === 'text') {
        assistantText += block.text;
        if (block.text.includes('IMPLEMENTATION_COMPLETE')) {
          isComplete = true;
        }
        if (block.text.includes('IMPLEMENTATION_BLOCKED:')) {
          isBlocked = true;
          blockReason = block.text.split('IMPLEMENTATION_BLOCKED:')[1]?.trim() || 'Unknown reason';
        }
      }
    }

    // Process tool calls
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    if (toolUseBlocks.length > 0) {
      // Add assistant message with tool calls
      messages.push({ role: 'assistant', content: response.content });

      // Execute tools and collect results
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const toolUse of toolUseBlocks) {
        console.log(`Executing tool: ${toolUse.name}`, toolUse.input);
        
        const result = await executor.execute(
          toolUse.name,
          toolUse.input as Record<string, unknown>
        );

        // Track file changes
        if (toolUse.name === 'write_file' || toolUse.name === 'apply_diff') {
          const filePath = (toolUse.input as { path: string }).path;
          if (!changedFiles.includes(filePath)) {
            changedFiles.push(filePath);
          }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.success
            ? result.output
            : `Error: ${result.error}\n${result.output}`,
          is_error: !result.success,
        });
      }

      // Add tool results
      messages.push({ role: 'user', content: toolResults });
    } else {
      // No tool calls, just text response
      messages.push({ role: 'assistant', content: response.content });
    }

    // Handle completion
    if (isComplete) {
      console.log('Implementation complete!');
      
      // Save implementation summary
      const summaryMessage: ConversationMessage = {
        role: 'assistant',
        content: `Implementation completed. Changed files: ${changedFiles.join(', ')}`,
        timestamp: new Date().toISOString(),
        metadata: { phase: 'implementing', changedFiles },
      };
      await sessionService.addMessage(session.id, summaryMessage);
      await sessionService.updateMetadata(session.id, { 
        implementedFiles: changedFiles,
        implementationIterations: iterations,
      });

      await githubService.postComment(
        source_repo,
        issue_number,
        `✅ **Implementation Complete**\n\n**Files changed:**\n${changedFiles.map(f => `- \`${f}\``).join('\n')}\n\n**Iterations:** ${iterations}\n\nMoving to testing phase...`
      );

      return;
    }

    // Handle blocking
    if (isBlocked) {
      console.log('Implementation blocked:', blockReason);
      
      await sessionService.updateStatus(session.id, 'paused');
      await sessionService.updateMetadata(session.id, { 
        blockedReason: blockReason,
        implementationIterations: iterations,
      });

      await githubService.postComment(
        source_repo,
        issue_number,
        `⚠️ **Implementation Blocked**\n\n${blockReason}\n\n**Files changed so far:**\n${changedFiles.map(f => `- \`${f}\``).join('\n') || 'None'}\n\nPlease help resolve this blocker and then add the \`agent:resume\` label to continue.`
      );

      return;
    }

    // Check if we've hit the stop reason without tool calls
    if (response.stop_reason === 'end_turn' && toolUseBlocks.length === 0) {
      // Agent stopped without completing or blocking - ask for clarification
      messages.push({
        role: 'user',
        content: 'Please continue with the implementation. If you are done, say IMPLEMENTATION_COMPLETE. If you are stuck, say IMPLEMENTATION_BLOCKED: <reason>.',
      });
    }
  }

  // Hit max iterations
  console.log('Hit max iterations');
  
  await sessionService.updateStatus(session.id, 'paused');
  await githubService.postComment(
    source_repo,
    issue_number,
    `⚠️ **Implementation Paused**\n\nReached maximum iterations (${MAX_ITERATIONS}) without completing.\n\n**Files changed:**\n${changedFiles.map(f => `- \`${f}\``).join('\n') || 'None'}\n\nThe implementation may need manual review.`
  );
}

