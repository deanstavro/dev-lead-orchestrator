import { EventPayload } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';
import { runClarifier } from '../agents/clarifier.js';

export async function handleAgentStart(payload: EventPayload): Promise<void> {
  const { source_repo, issue_number, issue_title, issue_body, sender } = payload;

  if (!issue_number || !source_repo) {
    throw new Error('Missing required fields: source_repo, issue_number');
  }

  console.log(`Starting agent session for ${source_repo}#${issue_number}`);

  // Check for existing session
  let session = await sessionService.getSession(source_repo, issue_number);

  if (session && session.status === 'active') {
    console.log('Session already active, resuming...');
    await githubService.postComment(
      source_repo,
      issue_number,
      '🤖 Agent session is already active. Continuing from where we left off...'
    );
  } else {
    // Create new session
    session = await sessionService.createSession(source_repo, issue_number, {
      issue_title,
      issue_body,
      started_by: sender,
    });

    await githubService.postComment(
      source_repo,
      issue_number,
      `🤖 **Agent Session Started**\n\nI'll help refine this ticket through a few phases:\n1. **Clarifying** - Understanding the requirements\n2. **Scoping** - Defining boundaries and acceptance criteria\n3. **Designing** - Technical approach\n4. **Planning** - Breaking into tasks\n\nLet me start by asking some clarifying questions...`
    );
  }

  // Run the clarifier agent
  await runClarifier({
    session,
    payload,
    githubToken: process.env.GITHUB_TOKEN!,
  });
}

