import { EventPayload } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';
import { runPRCreator } from '../agents/pr-creator.js';

export async function handleCreatePR(payload: EventPayload): Promise<void> {
  const { source_repo, issue_number } = payload;

  if (!issue_number || !source_repo) {
    throw new Error('Missing required fields: source_repo, issue_number');
  }

  console.log(`Creating PR for ${source_repo}#${issue_number}`);

  const session = await sessionService.getSession(source_repo, issue_number);

  if (!session) {
    await githubService.postComment(
      source_repo,
      issue_number,
      '❌ No agent session found for this issue.'
    );
    return;
  }

  await runPRCreator({
    session,
    payload,
    githubToken: process.env.GITHUB_TOKEN!,
  });
}

