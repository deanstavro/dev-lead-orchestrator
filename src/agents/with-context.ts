import Anthropic from '@anthropic-ai/sdk';
import { READ_ONLY_TOOLS } from '../tools/definitions.js';
import { ToolExecutor } from '../tools/executor.js';

const anthropic = new Anthropic();

interface ContextGatheringOptions {
  systemPrompt: string;
  userMessage: string;
  repoPath: string;
  maxIterations?: number;  // Max tool-use iterations (default: 5)
  maxTokens?: number;
}

interface ContextGatheringResult {
  response: string;
  toolsUsed: { tool: string; input: Record<string, unknown> }[];
  iterationCount: number;
}

/**
 * Runs an agent with read-only codebase access.
 * The agent can explore the codebase to gather context before responding.
 * 
 * Flow:
 * 1. Agent receives prompt and can use read-only tools
 * 2. Agent explores codebase as needed (up to maxIterations)
 * 3. Agent produces final text response
 */
export async function runAgentWithContext(
  options: ContextGatheringOptions
): Promise<ContextGatheringResult> {
  const {
    systemPrompt,
    userMessage,
    repoPath,
    maxIterations = 5,
    maxTokens = 2000,
  } = options;

  const executor = new ToolExecutor(repoPath);
  const toolsUsed: { tool: string; input: Record<string, unknown> }[] = [];
  
  // Enhanced system prompt that encourages codebase exploration
  const enhancedSystemPrompt = `${systemPrompt}

## Codebase Access
You have READ-ONLY access to the codebase. Before responding, you SHOULD explore the code to:
- Understand the project structure (list_directory with ".")
- Read relevant files (package.json, key components, configs)
- Search for patterns or existing implementations (search_code)

This helps you give accurate, context-aware responses instead of generic advice.

Guidelines for exploration:
- Start by listing the root directory to understand the project structure
- Read package.json to understand dependencies and scripts
- Look at existing similar code to match patterns
- Don't read every file - be targeted in what you explore
- After gathering enough context, provide your response`;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: userMessage },
  ];

  let iterationCount = 0;

  while (iterationCount < maxIterations) {
    iterationCount++;
    console.log(`[Agent] Iteration ${iterationCount}/${maxIterations}`);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system: enhancedSystemPrompt,
      tools: READ_ONLY_TOOLS,
      messages,
    });

    // Check if agent wants to use tools
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    // If no tool use, agent is done - extract final response
    if (toolUseBlocks.length === 0) {
      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );
      
      return {
        response: textBlock?.text || 'No response generated',
        toolsUsed,
        iterationCount,
      };
    }

    // Process tool calls
    messages.push({ role: 'assistant', content: response.content });
    
    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    
    for (const toolUse of toolUseBlocks) {
      const input = toolUse.input as Record<string, unknown>;
      console.log(`[Agent] Tool: ${toolUse.name}`, input);
      
      toolsUsed.push({ tool: toolUse.name, input });
      
      const result = await executor.execute(toolUse.name, input);
      
      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: result.success ? result.output : `Error: ${result.error}`,
        is_error: !result.success,
      });
      
      console.log(`[Agent] ${toolUse.name} result: ${result.success ? 'OK' : 'ERROR'}`);
    }
    
    messages.push({ role: 'user', content: toolResults });

    // Check if we've hit stop_reason end_turn with text
    if (response.stop_reason === 'end_turn') {
      const textBlock = response.content.find(
        (block): block is Anthropic.TextBlock => block.type === 'text'
      );
      if (textBlock?.text) {
        return {
          response: textBlock.text,
          toolsUsed,
          iterationCount,
        };
      }
    }
  }

  // Max iterations reached - make one final call without tools to get response
  console.log('[Agent] Max iterations reached, requesting final response');
  
  const finalResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens,
    system: systemPrompt, // Use original prompt without tool instructions
    messages: [
      ...messages,
      { 
        role: 'user', 
        content: 'Please provide your final response now based on the context you\'ve gathered.' 
      },
    ],
  });

  const textBlock = finalResponse.content.find(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  );

  return {
    response: textBlock?.text || 'No response generated',
    toolsUsed,
    iterationCount,
  };
}

