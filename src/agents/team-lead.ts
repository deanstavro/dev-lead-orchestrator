import Anthropic from '@anthropic-ai/sdk';
import { AgentContext, AgentResult, AgentName, Delegation, ConversationMessage } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';
import { runAgentForTeamLead } from '../services/agent-runner.js';

const anthropic = new Anthropic();

const MAX_ITERATIONS = 25;
const DELEGATABLE_AGENTS: AgentName[] = ['clarifier', 'scope', 'designer', 'planner', 'implementer', 'tester', 'pr-creator'];

const TEAM_LEAD_TOOLS: Anthropic.Tool[] = [
  {
    name: 'delegate_to_agent',
    description: 'Delegate work to a specialist agent. Use this to move the ticket through phases.',
    input_schema: {
      type: 'object' as const,
      properties: {
        agent: {
          type: 'string',
          enum: DELEGATABLE_AGENTS,
          description: 'Which agent to delegate to',
        },
        instructions: {
          type: 'string',
          description: 'Additional context or focus areas for the agent',
        },
      },
      required: ['agent'],
    },
  },
  {
    name: 'ask_human',
    description: 'Ask the human a question when you need clarification or a decision. Use sparingly.',
    input_schema: {
      type: 'object' as const,
      properties: {
        question: {
          type: 'string',
          description: 'The question to ask the human',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'mark_complete',
    description: 'Mark the ticket as fully processed. Use when PR is created or work is done.',
    input_schema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description: 'Summary of what was accomplished',
        },
      },
      required: ['summary'],
    },
  },
  {
    name: 'mark_blocked',
    description: 'Mark the ticket as blocked when you cannot proceed without human intervention.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reason: {
          type: 'string',
          description: 'Why the ticket is blocked',
        },
        attempted: {
          type: 'string',
          description: 'What was attempted before getting blocked',
        },
      },
      required: ['reason'],
    },
  },
  {
    name: 'think',
    description: 'Record your reasoning about what to do next. Use this to plan your approach.',
    input_schema: {
      type: 'object' as const,
      properties: {
        reasoning: {
          type: 'string',
          description: 'Your analysis and reasoning',
        },
      },
      required: ['reasoning'],
    },
  },
];

const SYSTEM_PROMPT = `You are the Team Lead agent managing a software development workflow. Your job is to take a ticket from creation to a merged PR.

## Your Team
You can delegate to these specialist agents:
- **clarifier**: Asks questions to understand requirements (use first if ticket is vague)
- **scope**: Defines acceptance criteria and boundaries
- **designer**: Creates technical design and architecture decisions
- **planner**: Breaks work into implementation tasks
- **implementer**: Writes the actual code
- **tester**: Runs tests to verify the implementation
- **pr-creator**: Creates a pull request with the changes

## Your Process
1. Analyze the ticket and current state
2. Decide what needs to happen next
3. Delegate to the appropriate agent
4. Evaluate the result
5. Continue until done or blocked

## Guidelines
- Start with clarifier only if the ticket is genuinely unclear
- Skip phases that aren't needed (e.g., trivial bugs may not need design)
- If an agent fails, you can retry or try a different approach
- Ask humans only when truly stuck—prefer making reasonable decisions
- Track your reasoning with the think tool
- Mark complete when PR is created successfully

## IMPORTANT: Respect Human Decisions
When a human responds to your question:
- If they say to skip tests or proceed to PR, DO IT. Don't second-guess them.
- If they say to create the PR despite failing tests, delegate to pr-creator immediately.
- If they choose an option you presented, follow their choice exactly.
- The human knows their codebase better than you. Trust their judgment.
- Never re-run a step the human told you to skip.

## Current State
You'll receive the ticket details and any previous work. Analyze and decide the next action.`;

export interface TeamLeadResult {
  status: 'completed' | 'blocked' | 'waiting_for_human';
  summary: string;
  delegations: Delegation[];
  prUrl?: string;
}

export async function runTeamLead(context: AgentContext): Promise<TeamLeadResult> {
  const { session, payload } = context;
  const { source_repo, issue_number } = payload;

  if (!issue_number) throw new Error('Missing issue_number');

  console.log(`[TeamLead] Starting for ${source_repo}#${issue_number}`);

  const delegations: Delegation[] = [];
  const reasoning: string[] = [];

  // Build initial context
  let stateContext = buildStateContext(session, delegations);

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: stateContext },
  ];

  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;
    console.log(`[TeamLead] Iteration ${iterations}/${MAX_ITERATIONS}`);

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: TEAM_LEAD_TOOLS,
      messages,
    });

    // Process response
    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    if (toolUseBlocks.length === 0) {
      // No tool calls, might be a text response—prompt to take action
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: 'Please use a tool to take action. Delegate to an agent, ask a human, or mark the ticket as complete/blocked.' });
      continue;
    }

    messages.push({ role: 'assistant', content: response.content });
    const toolResults: Anthropic.ToolResultBlockParam[] = [];

    for (const toolUse of toolUseBlocks) {
      const input = toolUse.input as Record<string, string>;

      switch (toolUse.name) {
        case 'think': {
          reasoning.push(input.reasoning);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Reasoning recorded. Now take action.',
          });
          break;
        }

        case 'delegate_to_agent': {
          const agentName = input.agent as AgentName;
          console.log(`[TeamLead] Delegating to ${agentName}`);

          // Post status update
          await githubService.postComment(
            source_repo,
            issue_number,
            `🤖 **Team Lead**: Delegating to **${agentName}** agent...${input.instructions ? `\n\n_Focus: ${input.instructions}_` : ''}`
          );

          // Run the agent
          const agentResult = await runAgentForTeamLead(agentName, context, input.instructions);

          // Record delegation
          const delegation: Delegation = {
            agent: agentName,
            input: input.instructions || '',
            output: agentResult,
            timestamp: new Date().toISOString(),
          };
          delegations.push(delegation);

          // Update session with agent output
          if (agentResult.success && agentResult.data) {
            const metadataUpdate: Record<string, unknown> = {};
            if (agentName === 'scope') metadataUpdate.scope = agentResult.output;
            if (agentName === 'designer') metadataUpdate.design = agentResult.output;
            if (agentName === 'planner') metadataUpdate.plan = agentResult.output;
            if (agentName === 'implementer') metadataUpdate.implementedFiles = agentResult.data.changedFiles;
            if (agentName === 'tester') metadataUpdate.testResults = agentResult.data.results;
            if (agentName === 'pr-creator') {
              metadataUpdate.prNumber = agentResult.data.prNumber;
              metadataUpdate.prUrl = agentResult.data.prUrl;
            }
            if (Object.keys(metadataUpdate).length > 0) {
              await sessionService.updateMetadata(session.id, metadataUpdate);
            }
          }

          // Post agent output
          if (agentResult.output) {
            const emoji = agentResult.success ? '✅' : '❌';
            await githubService.postComment(
              source_repo,
              issue_number,
              `${emoji} **${agentName}** result:\n\n${agentResult.output.slice(0, 3000)}`
            );
          }

          // If agent needs human input, surface it
          if (agentResult.needsHumanInput && agentResult.humanQuestion) {
            await githubService.postComment(
              source_repo,
              issue_number,
              `❓ **Question from ${agentName}:**\n\n${agentResult.humanQuestion}\n\n_Reply to this issue to continue._`
            );

            // Save message for when human responds
            const msg: ConversationMessage = {
              role: 'assistant',
              content: agentResult.humanQuestion,
              timestamp: new Date().toISOString(),
              metadata: { phase: 'team-lead', waitingFor: 'human' },
            };
            await sessionService.addMessage(session.id, msg);

            return {
              status: 'waiting_for_human',
              summary: `Waiting for human response to: ${agentResult.humanQuestion}`,
              delegations,
            };
          }

          // Build result for Team Lead
          const resultSummary = agentResult.success
            ? `${agentName} completed successfully. Output: ${agentResult.output.slice(0, 500)}${agentResult.suggestedNextAgent ? `. Suggested next: ${agentResult.suggestedNextAgent}` : ''}`
            : `${agentName} failed: ${agentResult.error || 'Unknown error'}`;

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: resultSummary,
          });

          // If PR was created, we might be done
          if (agentName === 'pr-creator' && agentResult.success) {
            await sessionService.updatePhase(session.id, 'completed');
            await sessionService.updateStatus(session.id, 'completed');
            
            await githubService.postComment(
              source_repo,
              issue_number,
              `🎉 **Team Lead**: All done! PR created successfully.\n\n${agentResult.output}`
            );

            return {
              status: 'completed',
              summary: 'PR created successfully',
              delegations,
              prUrl: agentResult.data?.prUrl as string,
            };
          }

          break;
        }

        case 'ask_human': {
          console.log(`[TeamLead] Asking human: ${input.question}`);
          
          await githubService.postComment(
            source_repo,
            issue_number,
            `❓ **Team Lead needs input:**\n\n${input.question}\n\n_Reply to this issue to continue._`
          );

          const msg: ConversationMessage = {
            role: 'assistant',
            content: input.question,
            timestamp: new Date().toISOString(),
            metadata: { phase: 'team-lead', waitingFor: 'human' },
          };
          await sessionService.addMessage(session.id, msg);

          return {
            status: 'waiting_for_human',
            summary: `Waiting for human response to: ${input.question}`,
            delegations,
          };
        }

        case 'mark_complete': {
          console.log(`[TeamLead] Marking complete: ${input.summary}`);
          
          await sessionService.updatePhase(session.id, 'completed');
          await sessionService.updateStatus(session.id, 'completed');

          await githubService.postComment(
            source_repo,
            issue_number,
            `🎉 **Team Lead**: Ticket complete!\n\n${input.summary}\n\n---\n_Processed in ${iterations} iterations with ${delegations.length} delegations._`
          );

          await githubService.removeLabel(source_repo, issue_number, 'agent:start');
          await githubService.addLabel(source_repo, issue_number, 'agent:complete');

          return {
            status: 'completed',
            summary: input.summary,
            delegations,
          };
        }

        case 'mark_blocked': {
          console.log(`[TeamLead] Marking blocked: ${input.reason}`);
          
          await sessionService.updateStatus(session.id, 'paused');

          await githubService.postComment(
            source_repo,
            issue_number,
            `🚫 **Team Lead**: Blocked\n\n**Reason:** ${input.reason}\n\n${input.attempted ? `**Attempted:** ${input.attempted}` : ''}\n\n_Add the \`agent:start\` label again after resolving the blocker._`
          );

          return {
            status: 'blocked',
            summary: input.reason,
            delegations,
          };
        }

        default:
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: `Unknown tool: ${toolUse.name}`,
            is_error: true,
          });
      }
    }

    if (toolResults.length > 0) {
      messages.push({ role: 'user', content: toolResults });
    }

    // Refresh context for next iteration
    const updatedSession = await sessionService.getSession(source_repo, issue_number);
    if (updatedSession) {
      stateContext = buildStateContext(updatedSession, delegations);
    }
  }

  // Hit max iterations
  await githubService.postComment(
    source_repo,
    issue_number,
    `⚠️ **Team Lead**: Reached maximum iterations (${MAX_ITERATIONS}). Pausing for review.\n\n_${delegations.length} delegations completed._`
  );

  await sessionService.updateStatus(session.id, 'paused');

  return {
    status: 'blocked',
    summary: `Reached max iterations (${MAX_ITERATIONS})`,
    delegations,
  };
}

function buildStateContext(session: any, delegations: Delegation[]): string {
  const recentDelegations = delegations.slice(-5).map(d => 
    `- ${d.agent}: ${d.output.success ? 'Success' : 'Failed'} - ${d.output.output.slice(0, 200)}`
  ).join('\n');

  return `
## Ticket
**Title:** ${session.metadata.issue_title || 'N/A'}
**Description:** ${session.metadata.issue_body || 'N/A'}

## Current State
- **Phase:** ${session.current_phase}
- **Status:** ${session.status}

## Completed Work
${session.metadata.scope ? `**Scope:** Defined ✅` : '**Scope:** Not yet defined'}
${session.metadata.design ? `**Design:** Completed ✅` : '**Design:** Not yet done'}
${session.metadata.plan ? `**Plan:** Created ✅` : '**Plan:** Not yet created'}
${session.metadata.implementedFiles ? `**Implementation:** Files changed: ${(session.metadata.implementedFiles as string[]).join(', ')} ✅` : '**Implementation:** Not yet done'}
${session.metadata.testResults ? `**Tests:** ${session.metadata.testsPassed ? 'Passed ✅' : 'Failed ❌'}` : '**Tests:** Not yet run'}
${session.metadata.prUrl ? `**PR:** ${session.metadata.prUrl} ✅` : '**PR:** Not yet created'}

${recentDelegations ? `## Recent Delegations\n${recentDelegations}` : ''}

## Your Task
Analyze the state and decide what to do next. Use tools to take action.
`.trim();
}

