import { EventPayload } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';
import Anthropic from '@anthropic-ai/sdk';

const anthropic = new Anthropic();

export async function handleQAReview(payload: EventPayload): Promise<void> {
  const { source_repo, pr_number, pr_title, pr_body, diff, issue_number } = payload;

  if (!source_repo || !pr_number) {
    throw new Error('Missing required fields: source_repo, pr_number');
  }

  console.log(`Running QA review for ${source_repo}#${pr_number}`);

  // Get the related session if there's a linked issue
  let sessionContext = '';
  if (issue_number) {
    const session = await sessionService.getSession(source_repo, issue_number);
    if (session) {
      sessionContext = `\n\nRelated ticket context:\n${JSON.stringify(session.metadata, null, 2)}`;
    }
  }

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    messages: [
      {
        role: 'user',
        content: `You are a QA reviewer for a pull request. Review the following PR and provide feedback.

PR Title: ${pr_title || 'N/A'}
PR Description: ${pr_body || 'N/A'}
${sessionContext}

${diff ? `Diff:\n\`\`\`\n${diff}\n\`\`\`` : 'No diff provided'}

Provide a concise QA review covering:
1. **Code Quality**: Any issues with the implementation?
2. **Test Coverage**: Are there sufficient tests?
3. **Edge Cases**: Any potential edge cases not handled?
4. **Security**: Any security concerns?
5. **Recommendation**: Approve, Request Changes, or Comment

Keep your response focused and actionable.`,
      },
    ],
  });

  const reviewContent = message.content[0].type === 'text' 
    ? message.content[0].text 
    : 'Unable to generate review';

  await githubService.postComment(
    source_repo,
    pr_number,
    `🔍 **Automated QA Review**\n\n${reviewContent}`
  );
}

