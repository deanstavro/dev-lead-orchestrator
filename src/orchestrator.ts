import { EventPayload } from './types/index.js';
import { handleAgentStart } from './handlers/agent-start.js';
import { handleAgentStop } from './handlers/agent-stop.js';
import { handleHumanResponse } from './handlers/human-response.js';
import { handleQAReview } from './handlers/qa-review.js';
import { handlePostMerge } from './handlers/post-merge.js';

export async function orchestrator(eventType: string, payload: EventPayload): Promise<void> {
  console.log(`Orchestrating event: ${eventType}`, { payload });

  switch (eventType) {
    case 'agent_start':
      await handleAgentStart(payload);
      break;

    case 'agent_stop':
      await handleAgentStop(payload);
      break;

    case 'human_response':
      await handleHumanResponse(payload);
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