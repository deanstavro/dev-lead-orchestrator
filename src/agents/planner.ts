import { AgentContext, ConversationMessage } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';
import { runAgentWithContext } from './with-context.js';

const SYSTEM_PROMPT = `You are a planning agent breaking work into implementation tasks.

Based on the scope and technical design, create a clear implementation plan:
- Break work into small, independently testable tasks
- Order tasks logically (dependencies first)
- Estimate each task (in hours: 1, 2, 4, 8)
- Include specific file paths and code locations

Guidelines:
- Each task should be completable in one sitting
- Reference exact file paths from the codebase
- Include line numbers or function names when helpful
- Be specific about what each task delivers
- Say "PHASE_COMPLETE" when plan is finalized

Output format:
## Implementation Plan

### Phase 1: [Name]
- [ ] **Task 1.1** (Xh): Description
  - File: path/to/file.ts
  - Changes: specific changes needed
- [ ] **Task 1.2** (Xh): Description

### Phase 2: [Name]  
- [ ] **Task 2.1** (Xh): Description

## Total Estimate: Xh

## Parallelization Opportunities
- Tasks X and Y can be done in parallel

## Key Files to Review Before Starting
- path/to/file.ts: why it's important

## Ready to Implement
This ticket is now ready for development.

PHASE_COMPLETE`;

export async function runPlanner(context: AgentContext): Promise<void> {
  const { session, payload } = context;
  const { source_repo, issue_number } = payload;
  const repoPath = process.env.REPO_PATH || process.cwd();

  if (!issue_number) throw new Error('Missing issue_number');

  console.log(`Running planner agent for ${source_repo}#${issue_number}`);
  console.log(`[Planner] Using repo path: ${repoPath}`);

  const userMessage = `Here's the ticket context:

Ticket: ${session.metadata.issue_title}
${session.metadata.issue_body}

---
Scope:
${session.metadata.scope || 'No scope defined'}

---
Design:
${session.metadata.design || 'No design defined'}

---
Please explore the codebase to verify file paths and understand the code structure, then create a detailed implementation plan.
Include specific file paths and be precise about what needs to change.`;

  // Add any planning-phase messages
  const planMessages = session.conversation.filter(
    m => m.metadata?.phase === 'planning'
  );
  
  let fullMessage = userMessage;
  if (planMessages.length > 0) {
    fullMessage += '\n\n---\nPrevious planning discussion:\n' + 
      planMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
  }

  const { response: responseText, toolsUsed, iterationCount } = await runAgentWithContext({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: fullMessage,
    repoPath,
    maxIterations: 6,  // Planner needs to verify file locations
    maxTokens: 2500,
  });

  console.log(`[Planner] Completed after ${iterationCount} iterations, used ${toolsUsed.length} tools`);

  const isComplete = responseText.includes('PHASE_COMPLETE');
  const cleanResponse = responseText.replace('PHASE_COMPLETE', '').trim();

  const assistantMessage: ConversationMessage = {
    role: 'assistant',
    content: cleanResponse,
    timestamp: new Date().toISOString(),
    metadata: { 
      phase: 'planning',
      toolsUsed: toolsUsed.length,
    },
  };
  await sessionService.addMessage(session.id, assistantMessage);

  if (isComplete) {
    await sessionService.updatePhase(session.id, 'completed');
    await sessionService.updateMetadata(session.id, { plan: cleanResponse });

    await githubService.postComment(
      source_repo,
      issue_number,
      `📝 **Implementation Plan**\n\n${cleanResponse}\n\n---\n\n🎉 **All Phases Complete!**\n\nThis ticket has been fully refined and is ready for implementation.\n\n**Summary:**\n- ✅ Clarification\n- ✅ Scoping  \n- ✅ Design\n- ✅ Planning\n\nThe agent session is now complete. Happy coding! 🚀`
    );

    // Remove the agent:start label and add agent:complete
    await githubService.removeLabel(source_repo, issue_number, 'agent:start');
    await githubService.addLabel(source_repo, issue_number, 'agent:complete');
  } else {
    await githubService.postComment(
      source_repo,
      issue_number,
      `📝 **Planning**\n\n${cleanResponse}`
    );
  }
}
