import Anthropic from '@anthropic-ai/sdk';
import { AgentContext, ConversationMessage } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';

const anthropic = new Anthropic();

const SYSTEM_PROMPT = `You are a clarifying agent helping to refine software development tickets.

Your role is to ask thoughtful questions to understand:
- The exact user need or problem being solved
- Who the users are and their context
- What success looks like
- Any constraints or requirements not mentioned

Guidelines:
- Ask 2-4 focused questions at a time, not more
- Be concise and direct
- Number your questions for easy reference
- If you have enough clarity, say "PHASE_COMPLETE" at the end of your message
- Don't ask about implementation details yet - that's for later phases

When you determine you have sufficient clarity (usually after 1-3 exchanges), end your message with:
PHASE_COMPLETE`;

export async function runClarifier(context: AgentContext): Promise<void> {
  const { session, payload } = context;
  const { source_repo, issue_number } = payload;

  if (!issue_number) throw new Error('Missing issue_number');

  console.log(`Running clarifier for ${source_repo}#${issue_number}`);

  // Build conversation history for Claude
  const messages: { role: 'user' | 'assistant'; content: string }[] = [];

  // Add initial context as first user message
  const initialContext = `Ticket Title: ${session.metadata.issue_title || 'N/A'}
  
Ticket Description:
${session.metadata.issue_body || 'No description provided'}`;

  if (session.conversation.length === 0) {
    messages.push({ role: 'user', content: initialContext });
  } else {
    // Add the initial context, then conversation history
    messages.push({ role: 'user', content: initialContext });
    
    for (const msg of session.conversation) {
      messages.push({
        role: msg.role === 'user' ? 'user' : 'assistant',
        content: msg.content,
      });
    }
  }

  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 1024,
    system: SYSTEM_PROMPT,
    messages,
  });

  const responseText = response.content[0].type === 'text' 
    ? response.content[0].text 
    : 'Unable to generate response';

  // Check if phase is complete
  const isComplete = responseText.includes('PHASE_COMPLETE');
  const cleanResponse = responseText.replace('PHASE_COMPLETE', '').trim();

  // Save assistant message to conversation
  const assistantMessage: ConversationMessage = {
    role: 'assistant',
    content: cleanResponse,
    timestamp: new Date().toISOString(),
    metadata: { phase: 'clarifying' },
  };
  await sessionService.addMessage(session.id, assistantMessage);

  if (isComplete) {
    // Transition to scoping phase
    await sessionService.updatePhase(session.id, 'scoping');
    
    await githubService.postComment(
      source_repo,
      issue_number,
      `${cleanResponse}\n\n---\n\n✅ **Clarification Complete**\n\nMoving to **Scoping Phase**. I'll now define the boundaries and acceptance criteria for this work.`
    );

    // Import and run scope agent
    const { runScope } = await import('./scope.js');
    const updatedSession = await sessionService.getSession(source_repo, issue_number);
    if (updatedSession) {
      await runScope({ ...context, session: updatedSession });
    }
  } else {
    await githubService.postComment(
      source_repo,
      issue_number,
      `🤔 **Clarifying Questions**\n\n${cleanResponse}`
    );
  }
}

