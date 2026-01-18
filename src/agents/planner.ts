import Anthropic from '@anthropic-ai/sdk';
import { AgentContext, ConversationMessage } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `You are a planning agent breaking work into implementation tasks.

Based on the scope and technical design, create a clear implementation plan:
- Break work into small, independently testable tasks
- Order tasks logically (dependencies first)
- Estimate each task (in hours: 1, 2, 4, 8)
- Identify which tasks could be parallelized

Guidelines:
- Each task should be completable in one sitting
- Include testing as part of relevant tasks
- Be specific about what each task delivers
- Say "PHASE_COMPLETE" when plan is finalized

Output format:
## Implementation Plan

### Phase 1: [Name]
- [ ] **Task 1.1** (Xh): Description
- [ ] **Task 1.2** (Xh): Description

### Phase 2: [Name]  
- [ ] **Task 2.1** (Xh): Description

## Total Estimate: Xh

## Parallelization Opportunities
- Tasks X and Y can be done in parallel

## Ready to Implement
This ticket is now ready for development.

PHASE_COMPLETE`;

export async function runPlanner(context: AgentContext): Promise<void> {
  const { session, payload } = context;
  const { source_repo, issue_number } = payload;

  if (!issue_number) throw new Error('Missing issue_number');

  console.log(`Running planner agent for ${source_repo}#${issue_number}`);

  const messages: { role: 'user' | 'assistant'; content: string }[] = [
    {
      role: 'user',
      content: `Here's the ticket context:

Ticket: ${session.metadata.issue_title}
${session.metadata.issue_body}

---
Scope:
${session.metadata.scope || 'No scope defined'}

---
Design:
${session.metadata.design || 'No design defined'}

---
Please create an implementation plan.`,
    },
  ];

  // Add any planning-phase messages
  const planMessages = session.conversation.filter(
    m => m.metadata?.phase === 'planning'
  );
  for (const msg of planMessages) {
    messages.push({
      role: msg.role === 'user' ? 'user' : 'assistant',
      content: msg.content,
    });
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages,
  });

  const responseText = response.content[0].type === 'text'
    ? response.content[0].text
    : 'Unable to generate response';

  const isComplete = responseText.includes('PHASE_COMPLETE');
  const cleanResponse = responseText.replace('PHASE_COMPLETE', '').trim();

  const assistantMessage: ConversationMessage = {
    role: 'assistant',
    content: cleanResponse,
    timestamp: new Date().toISOString(),
    metadata: { phase: 'planning' },
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

