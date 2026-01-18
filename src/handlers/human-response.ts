import { EventPayload, ConversationMessage } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';
import { runClarifier } from '../agents/clarifier.js';
import { runScope } from '../agents/scope.js';
import { runDesigner } from '../agents/designer.js';
import { runPlanner } from '../agents/planner.js';

export async function handleHumanResponse(payload: EventPayload): Promise<void> {
  const { source_repo, issue_number, comment_body, comment_author } = payload;

  if (!issue_number || !source_repo || !comment_body) {
    throw new Error('Missing required fields: source_repo, issue_number, comment_body');
  }

  console.log(`Processing human response for ${source_repo}#${issue_number}`);

  const session = await sessionService.getSession(source_repo, issue_number);

  if (!session) {
    console.log('No active session found for this issue');
    return;
  }

  if (session.status !== 'active') {
    console.log(`Session is ${session.status}, ignoring response`);
    return;
  }

  // Add the human message to conversation history
  const humanMessage: ConversationMessage = {
    role: 'user',
    content: comment_body,
    timestamp: new Date().toISOString(),
    metadata: { author: comment_author },
  };

  await sessionService.addMessage(session.id, humanMessage);

  // Refresh session with updated conversation
  const updatedSession = await sessionService.getSession(source_repo, issue_number);
  if (!updatedSession) throw new Error('Failed to refresh session');

  const context = {
    session: updatedSession,
    payload,
    githubToken: process.env.GITHUB_TOKEN!,
  };

  // Route to appropriate agent based on current phase
  switch (session.current_phase) {
    case 'clarifying':
      await runClarifier(context);
      break;

    case 'scoping':
      await runScope(context);
      break;

    case 'designing':
      await runDesigner(context);
      break;

    case 'planning':
      await runPlanner(context);
      break;

    case 'completed':
      await githubService.postComment(
        source_repo,
        issue_number,
        '✅ This ticket has already been fully processed. All phases are complete!'
      );
      break;

    default:
      console.warn(`Unknown phase: ${session.current_phase}`);
  }
}

