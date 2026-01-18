import { orchestrator } from './orchestrator.js';

async function main() {
  try {
    const eventType = process.env.EVENT_TYPE;
    const payload = process.env.EVENT_PAYLOAD;

    if (!eventType || !payload) {
      throw new Error('Missing EVENT_TYPE or EVENT_PAYLOAD');
    }

    console.log(`Processing event: ${eventType}`);
    
    const parsedPayload = JSON.parse(payload);
    await orchestrator(eventType, parsedPayload);
    
    console.log('Event processed successfully');
  } catch (error) {
    console.error('Error processing event:', error);
    process.exit(1);
  }
}

main();