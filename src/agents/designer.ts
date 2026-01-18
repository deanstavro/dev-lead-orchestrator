import Anthropic from '@anthropic-ai/sdk';
import { AgentContext, ConversationMessage } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `You are a design agent creating technical solutions for software work.

Based on the clarified requirements and defined scope, you need to:
- Outline the technical approach
- Identify key components/files to change
- Note any architectural decisions
- Highlight risks or trade-offs

Guidelines:
- Keep it high-level but specific enough to guide implementation
- Focus on the "what" and "why", not detailed "how"
- Mention relevant patterns or libraries if applicable
- If you need clarification on technical constraints, ask
- When design is clear, say "PHASE_COMPLETE" at the end

Output format when complete:
## Technical Approach
Brief description of the solution

## Components to Modify
- Component/file 1: what changes
- Component/file 2: what changes

## New Components (if any)
- New component: purpose

## Architectural Decisions
- Decision 1: rationale

## Risks & Trade-offs
- Risk 1: mitigation

PHASE_COMPLETE`;

export async function runDesigner(context: AgentContext): Promise<void> {
  const { session, payload } = context;
  const { source_repo, issue_number } = payload;

  if (!issue_number) throw new Error('Missing issue_number');

  console.log(`Running designer agent for ${source_repo}#${issue_number}`);

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
Please design the technical solution.`,
    },
  ];

  // Add any design-phase messages
  const designMessages = session.conversation.filter(
    m => m.metadata?.phase === 'designing'
  );
  for (const msg of designMessages) {
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
    metadata: { phase: 'designing' },
  };
  await sessionService.addMessage(session.id, assistantMessage);

  if (isComplete) {
    await sessionService.updatePhase(session.id, 'planning');
    await sessionService.updateMetadata(session.id, { design: cleanResponse });

    await githubService.postComment(
      source_repo,
      issue_number,
      `🏗️ **Technical Design**\n\n${cleanResponse}\n\n---\n\n✅ **Design Complete**\n\nMoving to **Planning Phase**. I'll now break this into implementation tasks.`
    );

    const { runPlanner } = await import('./planner.js');
    const updatedSession = await sessionService.getSession(source_repo, issue_number);
    if (updatedSession) {
      await runPlanner({ ...context, session: updatedSession });
    }
  } else {
    await githubService.postComment(
      source_repo,
      issue_number,
      `🏗️ **Design**\n\n${cleanResponse}`
    );
  }
}

