import { EventPayload } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';
import { runImplementer } from '../agents/implementer.js';
import { runTester } from '../agents/tester.js';
import { runPRCreator } from '../agents/pr-creator.js';

export async function handleImplement(payload: EventPayload): Promise<void> {
  const { source_repo, issue_number } = payload;

  if (!issue_number || !source_repo) {
    throw new Error('Missing required fields: source_repo, issue_number');
  }

  console.log(`Starting implementation for ${source_repo}#${issue_number}`);

  let session = await sessionService.getSession(source_repo, issue_number);

  if (!session) {
    await githubService.postComment(
      source_repo,
      issue_number,
      '❌ No agent session found. Please start with the `agent:start` label first to go through clarification, scoping, and design phases.'
    );
    return;
  }

  if (session.current_phase !== 'planning' && session.current_phase !== 'completed') {
    await githubService.postComment(
      source_repo,
      issue_number,
      `❌ Cannot implement yet. Current phase: **${session.current_phase}**\n\nPlease complete all planning phases first.`
    );
    return;
  }

  // Update phase to implementing
  await sessionService.updatePhase(session.id, 'implementing');
  
  // Run the implementer
  await runImplementer({
    session,
    payload,
    githubToken: process.env.GITHUB_TOKEN!,
  });

  // Refresh session to check if implementation completed
  session = await sessionService.getSession(source_repo, issue_number);
  if (!session || session.status !== 'active') {
    console.log('Implementation did not complete successfully, skipping tests');
    return;
  }

  // Run tests automatically after implementation
  console.log('Implementation complete, running tests...');
  const context = {
    session,
    payload,
    githubToken: process.env.GITHUB_TOKEN!,
  };

  const { passed } = await runTester(context);

  if (passed) {
    // Tests passed, create PR
    console.log('Tests passed, creating PR...');
    const updatedSession = await sessionService.getSession(source_repo, issue_number);
    if (updatedSession) {
      await runPRCreator({
        session: updatedSession,
        payload,
        githubToken: process.env.GITHUB_TOKEN!,
      });
    }
  }
}

