import { EventPayload } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';

export async function handleAgentStop(payload: EventPayload): Promise<void> {
  const { source_repo, issue_number, sender } = payload;

  if (!issue_number || !source_repo) {
    throw new Error('Missing required fields: source_repo, issue_number');
  }

  console.log(`Stopping agent session for ${source_repo}#${issue_number}`);

  const session = await sessionService.getSession(source_repo, issue_number);

  if (!session) {
    console.log('No active session found');
    return;
  }

  if (session.status !== 'active') {
    console.log(`Session already ${session.status}`);
    return;
  }

  await sessionService.updateStatus(session.id, 'cancelled');

  await githubService.postComment(
    source_repo,
    issue_number,
    `🛑 **Agent Session Stopped**\n\nSession cancelled by @${sender || 'unknown'}.\n\nTo restart, add the \`agent:start\` label again.`
  );
}

