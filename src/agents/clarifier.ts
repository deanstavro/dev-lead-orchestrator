import { AgentContext, ConversationMessage } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';
import { runAgentWithContext } from './with-context.js';

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
- Reference specific files or patterns you found in the codebase when relevant
- If you have enough clarity, say "PHASE_COMPLETE" at the end of your message
- Don't ask about implementation details yet - that's for later phases

When you determine you have sufficient clarity (usually after 1-3 exchanges), end your message with:
PHASE_COMPLETE`;

export async function runClarifier(context: AgentContext): Promise<void> {
  const { session, payload } = context;
  const { source_repo, issue_number } = payload;
  const repoPath = process.env.REPO_PATH || process.cwd();

  if (!issue_number) throw new Error('Missing issue_number');

  console.log(`Running clarifier for ${source_repo}#${issue_number}`);
  console.log(`[Clarifier] Using repo path: ${repoPath}`);

  // Build conversation history
  let conversationContext = '';
  if (session.conversation.length > 0) {
    conversationContext = '\n---\nPrevious discussion:\n' + 
      session.conversation.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
  }

  const userMessage = `Ticket Title: ${session.metadata.issue_title || 'N/A'}
  
Ticket Description:
${session.metadata.issue_body || 'No description provided'}
${conversationContext}

Please explore the codebase to understand the project context, then ask clarifying questions about this ticket.`;

  const { response: responseText, toolsUsed, iterationCount } = await runAgentWithContext({
    systemPrompt: SYSTEM_PROMPT,
    userMessage,
    repoPath,
    maxIterations: 5,
    maxTokens: 1500,
  });

  console.log(`[Clarifier] Completed after ${iterationCount} iterations, used ${toolsUsed.length} tools`);

  // Check if phase is complete
  const isComplete = responseText.includes('PHASE_COMPLETE');
  const cleanResponse = responseText.replace('PHASE_COMPLETE', '').trim();

  // Save assistant message to conversation
  const assistantMessage: ConversationMessage = {
    role: 'assistant',
    content: cleanResponse,
    timestamp: new Date().toISOString(),
    metadata: { 
      phase: 'clarifying',
      toolsUsed: toolsUsed.length,
    },
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
      `🔍 **Clarifying Questions**\n\n${cleanResponse}`
    );
  }
}
