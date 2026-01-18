import { EventPayload } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';
import { runTeamLead } from '../agents/team-lead.js';

export async function handleTeamLead(payload: EventPayload): Promise<void> {
  const { source_repo, issue_number, issue_title, issue_body, sender } = payload;

  if (!issue_number || !source_repo) {
    throw new Error('Missing required fields: source_repo, issue_number');
  }

  console.log(`[TeamLeadHandler] Starting for ${source_repo}#${issue_number}`);

  // Get or create session
  let session = await sessionService.getSession(source_repo, issue_number);

  if (!session) {
    // Create new session
    session = await sessionService.createSession(source_repo, issue_number, {
      issue_title,
      issue_body,
      started_by: sender,
      mode: 'team-lead',
    });

    await githubService.postComment(
      source_repo,
      issue_number,
      `🤖 **Team Lead Agent Started**\n\nI'll manage this ticket through completion. I have a team of specialist agents I can delegate to:\n\n- 🔍 Clarifier - Understanding requirements\n- 📋 Scope - Defining boundaries\n- 🏗️ Designer - Technical approach\n- 📝 Planner - Implementation tasks\n- 🔧 Implementer - Writing code\n- 🧪 Tester - Verifying changes\n- 🚀 PR Creator - Opening pull request\n\nAnalyzing the ticket now...`
    );
  } else if (session.status === 'paused') {
    // Resume paused session
    await sessionService.updateStatus(session.id, 'active');
    
    await githubService.postComment(
      source_repo,
      issue_number,
      `🤖 **Team Lead Agent Resumed**\n\nContinuing from where we left off...`
    );
  } else if (session.status === 'completed') {
    await githubService.postComment(
      source_repo,
      issue_number,
      `✅ This ticket has already been completed. Remove the \`agent:complete\` label and add \`agent:start\` again if you want to re-process.`
    );
    return;
  }

  // Run the Team Lead
  const result = await runTeamLead({
    session,
    payload,
    githubToken: process.env.GITHUB_TOKEN!,
  });

  console.log(`[TeamLeadHandler] Finished with status: ${result.status}`);
  console.log(`[TeamLeadHandler] Delegations: ${result.delegations.length}`);
}

export async function handleTeamLeadHumanResponse(payload: EventPayload): Promise<void> {
  const { source_repo, issue_number, comment_body, comment_author } = payload;

  if (!issue_number || !source_repo || !comment_body) {
    throw new Error('Missing required fields');
  }

  console.log(`[TeamLeadHandler] Processing human response for ${source_repo}#${issue_number}`);

  const session = await sessionService.getSession(source_repo, issue_number);

  if (!session) {
    console.log('No session found for this issue');
    return;
  }

  if (session.status !== 'active' && session.status !== 'paused') {
    console.log(`Session is ${session.status}, ignoring response`);
    return;
  }

  // Check if this is a Team Lead managed session
  if (session.metadata.mode !== 'team-lead') {
    console.log('Not a Team Lead session, delegating to regular handler');
    const { handleHumanResponse } = await import('./human-response.js');
    await handleHumanResponse(payload);
    return;
  }

  // Add human response to conversation
  await sessionService.addMessage(session.id, {
    role: 'user',
    content: comment_body,
    timestamp: new Date().toISOString(),
    metadata: { author: comment_author, phase: 'team-lead' },
  });

  // Update metadata with response
  await sessionService.updateMetadata(session.id, {
    lastHumanResponse: comment_body,
    lastHumanResponseAt: new Date().toISOString(),
  });

  // Ensure session is active
  if (session.status === 'paused') {
    await sessionService.updateStatus(session.id, 'active');
  }

  // Re-run Team Lead with updated context
  const updatedSession = await sessionService.getSession(source_repo, issue_number);
  if (!updatedSession) return;

  await githubService.postComment(
    source_repo,
    issue_number,
    `🤖 **Team Lead**: Got it, continuing...`
  );

  await runTeamLead({
    session: updatedSession,
    payload,
    githubToken: process.env.GITHUB_TOKEN!,
  });
}

