import { EventPayload } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';

export async function handlePostMerge(payload: EventPayload): Promise<void> {
  const { source_repo, issue_number, pr_number } = payload;

  if (!source_repo) {
    throw new Error('Missing required field: source_repo');
  }

  console.log(`Post-merge monitoring for ${source_repo} PR#${pr_number}`);

  // If there's a linked issue, mark the session as completed
  if (issue_number) {
    const session = await sessionService.getSession(source_repo, issue_number);
    
    if (session && session.status === 'active') {
      await sessionService.updateStatus(session.id, 'completed');
      await sessionService.updatePhase(session.id, 'completed');

      await githubService.postComment(
        source_repo,
        issue_number,
        `🎉 **Agent Session Complete**\n\nThe related PR #${pr_number} has been merged.\n\nSession summary:\n- Started: ${session.created_at}\n- Phases completed: clarifying → scoping → designing → planning → merged\n- Total messages: ${session.conversation.length}`
      );
    }
  }

  // Future: Could add deployment monitoring, rollback detection, etc.
  console.log('Post-merge monitoring complete');
}

