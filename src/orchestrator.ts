import { EventPayload } from './types/index.js';
import { handleAgentStart } from './handlers/agent-start.js';
import { handleAgentStop } from './handlers/agent-stop.js';
import { handleHumanResponse } from './handlers/human-response.js';
import { handleQAReview } from './handlers/qa-review.js';
import { handlePostMerge } from './handlers/post-merge.js';
import { handleImplement } from './handlers/implement.js';
import { handleTest } from './handlers/test.js';
import { handleCreatePR } from './handlers/create-pr.js';
import { handleTeamLead, handleTeamLeadHumanResponse } from './handlers/team-lead.js';
import { sessionService } from './services/session.js';

export async function orchestrator(eventType: string, payload: EventPayload): Promise<void> {
  console.log(`Orchestrating event: ${eventType}`, { payload });

  switch (eventType) {
    // Team Lead mode (default) - handles everything autonomously
    case 'agent_start':
      await handleTeamLead(payload);
      break;

    // Legacy pipeline mode - manual phase triggers
    case 'agent_start_pipeline':
      await handleAgentStart(payload);
      break;

    case 'agent_stop':
      await handleAgentStop(payload);
      break;

    case 'human_response': {
      // Check if this is a Team Lead session
      if (payload.issue_number && payload.source_repo) {
        const session = await sessionService.getSession(payload.source_repo, payload.issue_number);
        if (session?.metadata.mode === 'team-lead') {
          await handleTeamLeadHumanResponse(payload);
          break;
        }
      }
      await handleHumanResponse(payload);
      break;
    }

    case 'agent_implement':
      await handleImplement(payload);
      break;

    case 'agent_test':
      await handleTest(payload);
      break;

    case 'agent_create_pr':
      await handleCreatePR(payload);
      break;

    case 'qa_review':
      await handleQAReview(payload);
      break;

    case 'post_merge_monitor':
      await handlePostMerge(payload);
      break;

    default:
      console.warn(`Unknown event type: ${eventType}`);
  }
}