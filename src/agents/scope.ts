import { AgentContext, ConversationMessage } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';
import { runAgentWithContext } from './with-context.js';

const SYSTEM_PROMPT = `You are a scoping agent defining the boundaries of software work.

Based on the clarified requirements, you need to:
- Define clear acceptance criteria
- Identify what's IN scope and OUT of scope
- Note any dependencies or prerequisites
- Estimate complexity (S/M/L/XL)

Guidelines:
- Be specific and measurable in acceptance criteria
- Use bullet points for clarity
- Reference actual files and components from the codebase
- Identify specific files that will need changes
- If you need more info to scope properly, ask specific questions
- When scope is clear, say "PHASE_COMPLETE" at the end

Output format when complete:
## Acceptance Criteria
- [ ] Criterion 1
- [ ] Criterion 2

## In Scope
- Item 1

## Out of Scope
- Item 1

## Files to Modify
- path/to/file.ts: what changes

## Dependencies
- None / List them

## Complexity: S/M/L/XL

PHASE_COMPLETE`;

export async function runScope(context: AgentContext): Promise<void> {
  const { session, payload } = context;
  const { source_repo, issue_number } = payload;
  const repoPath = process.env.REPO_PATH || process.cwd();

  if (!issue_number) throw new Error('Missing issue_number');

  console.log(`Running scope agent for ${source_repo}#${issue_number}`);
  console.log(`[Scope] Using repo path: ${repoPath}`);

  // Build context from entire conversation
  const conversationSummary = session.conversation
    .map(m => `${m.role.toUpperCase()}: ${m.content}`)
    .join('\n\n');

  const userMessage = `Here's the ticket and clarification discussion so far:

Ticket: ${session.metadata.issue_title}
${session.metadata.issue_body}

---
Clarification Discussion:
${conversationSummary}

---
Please explore the codebase to understand the structure and existing code, then define the scope for this work.
Be specific about which files and components will need changes.`;

  // Add any scoping-phase messages
  const scopeMessages = session.conversation.filter(
    m => m.metadata?.phase === 'scoping'
  );
  
  let fullMessage = userMessage;
  if (scopeMessages.length > 0) {
    fullMessage += '\n\n---\nPrevious scoping discussion:\n' + 
      scopeMessages.map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');
  }

  const { response: responseText, toolsUsed, iterationCount } = await runAgentWithContext({
    systemPrompt: SYSTEM_PROMPT,
    userMessage: fullMessage,
    repoPath,
    maxIterations: 5,
    maxTokens: 2000,
  });

  console.log(`[Scope] Completed after ${iterationCount} iterations, used ${toolsUsed.length} tools`);

  const isComplete = responseText.includes('PHASE_COMPLETE');
  const cleanResponse = responseText.replace('PHASE_COMPLETE', '').trim();

  const assistantMessage: ConversationMessage = {
    role: 'assistant',
    content: cleanResponse,
    timestamp: new Date().toISOString(),
    metadata: { 
      phase: 'scoping',
      toolsUsed: toolsUsed.length,
    },
  };
  await sessionService.addMessage(session.id, assistantMessage);

  if (isComplete) {
    await sessionService.updatePhase(session.id, 'designing');
    await sessionService.updateMetadata(session.id, { scope: cleanResponse });

    await githubService.postComment(
      source_repo,
      issue_number,
      `📋 **Scope Defined**\n\n${cleanResponse}\n\n---\n\n✅ **Scoping Complete**\n\nMoving to **Design Phase**. I'll now outline the technical approach.`
    );

    const { runDesigner } = await import('./designer.js');
    const updatedSession = await sessionService.getSession(source_repo, issue_number);
    if (updatedSession) {
      await runDesigner({ ...context, session: updatedSession });
    }
  } else {
    await githubService.postComment(
      source_repo,
      issue_number,
      `📋 **Scoping**\n\n${cleanResponse}`
    );
  }
}
