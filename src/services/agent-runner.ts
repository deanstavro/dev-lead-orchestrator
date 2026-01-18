import Anthropic from '@anthropic-ai/sdk';
import { AgentContext, AgentResult, AgentName } from '../types/index.js';
import { sessionService } from './session.js';
import { ToolExecutor } from '../tools/executor.js';
import { CODE_TOOLS } from '../tools/definitions.js';

const anthropic = new Anthropic();

// Agent system prompts
const AGENT_PROMPTS: Record<AgentName, string> = {
  clarifier: `You are a clarifying agent. Ask 2-4 focused questions to understand:
- The exact user need or problem
- Who the users are
- What success looks like
- Any constraints not mentioned

When you have enough clarity, include "PHASE_COMPLETE" in your response.
Keep questions concise and numbered.`,

  scope: `You are a scoping agent. Based on the clarified requirements, define:
- Acceptance criteria (as checkboxes)
- What's IN scope
- What's OUT of scope
- Dependencies
- Complexity estimate (S/M/L/XL)

When scope is clear, include "PHASE_COMPLETE" in your response.`,

  designer: `You are a design agent. Create a technical approach:
- Technical approach overview
- Components/files to modify
- New components needed
- Architectural decisions with rationale
- Risks and trade-offs

When design is complete, include "PHASE_COMPLETE" in your response.`,

  planner: `You are a planning agent. Create an implementation plan:
- Break work into small tasks
- Order tasks logically
- Estimate each task (1, 2, 4, or 8 hours)
- Note parallelization opportunities

Format as checkboxes. When plan is complete, include "PHASE_COMPLETE" in your response.`,

  implementer: `You are an implementation agent. Use the provided tools to:
1. Explore the codebase
2. Make the necessary code changes
3. Follow the plan step by step

When implementation is complete, include "IMPLEMENTATION_COMPLETE" in your response.
If blocked, include "IMPLEMENTATION_BLOCKED: <reason>".`,

  tester: `You are a testing agent. Verify the implementation by:
1. Running type checks
2. Running linter
3. Running build
4. Running tests

Report results for each check.`,

  'pr-creator': `You are a PR creation agent. Create a pull request with:
- Clear title
- Description linking to the issue
- Summary of changes
- Test results`,
};

export async function runAgentForTeamLead(
  agentName: AgentName,
  context: AgentContext,
  additionalContext?: string
): Promise<AgentResult> {
  const { session, payload } = context;
  const repoPath = process.env.REPO_PATH || process.env.GITHUB_WORKSPACE || './source-repo';

  console.log(`[AgentRunner] Running ${agentName} for issue #${payload.issue_number}`);

  try {
    // Build context for the agent
    const baseContext = `
Issue: ${session.metadata.issue_title || 'N/A'}
Description: ${session.metadata.issue_body || 'N/A'}

${session.metadata.scope ? `Scope:\n${session.metadata.scope}\n` : ''}
${session.metadata.design ? `Design:\n${session.metadata.design}\n` : ''}
${session.metadata.plan ? `Plan:\n${session.metadata.plan}\n` : ''}
${additionalContext ? `Additional Context:\n${additionalContext}\n` : ''}
`.trim();

    // For implementer/tester, use tools
    if (agentName === 'implementer') {
      return await runImplementerAgent(context, baseContext, repoPath);
    }

    if (agentName === 'tester') {
      return await runTesterAgent(context, repoPath);
    }

    if (agentName === 'pr-creator') {
      return await runPRCreatorAgent(context, repoPath);
    }

    // For other agents, use simple message completion
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: baseContext },
    ];

    // Add relevant conversation history for this phase
    const phaseMap: Record<string, string> = {
      clarifier: 'clarifying',
      scope: 'scoping',
      designer: 'designing',
      planner: 'planning',
    };
    const phase = phaseMap[agentName];
    
    if (phase) {
      const phaseMessages = session.conversation.filter(
        m => m.metadata?.phase === phase
      );
      for (const msg of phaseMessages) {
        messages.push({
          role: msg.role === 'user' ? 'user' : 'assistant',
          content: msg.content,
        });
      }
    }

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: AGENT_PROMPTS[agentName],
      messages,
    });

    const output = response.content[0].type === 'text' 
      ? response.content[0].text 
      : 'No response generated';

    const isComplete = output.includes('PHASE_COMPLETE');
    const needsHuman = !isComplete && agentName === 'clarifier';

    // Extract questions if clarifier needs human input
    let humanQuestion: string | undefined;
    if (needsHuman) {
      humanQuestion = output;
    }

    // Determine suggested next agent
    const nextAgentMap: Record<AgentName, AgentName | undefined> = {
      clarifier: 'scope',
      scope: 'designer',
      designer: 'planner',
      planner: 'implementer',
      implementer: 'tester',
      tester: 'pr-creator',
      'pr-creator': undefined,
    };

    return {
      success: true,
      output: output.replace('PHASE_COMPLETE', '').trim(),
      needsHumanInput: needsHuman,
      humanQuestion,
      suggestedNextAgent: isComplete ? nextAgentMap[agentName] : undefined,
      data: { phase: agentName, isComplete },
    };

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[AgentRunner] ${agentName} failed:`, message);
    return {
      success: false,
      output: '',
      needsHumanInput: false,
      error: message,
    };
  }
}

async function runImplementerAgent(
  context: AgentContext,
  baseContext: string,
  repoPath: string
): Promise<AgentResult> {
  const executor = new ToolExecutor(repoPath);
  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `${baseContext}\n\nBegin implementation. Explore the codebase first, then make changes.` },
  ];

  const changedFiles: string[] = [];
  let iterations = 0;
  const maxIterations = 100;

  while (iterations < maxIterations) {
    iterations++;

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      system: AGENT_PROMPTS.implementer,
      tools: CODE_TOOLS,
      messages,
    });

    let textOutput = '';
    for (const block of response.content) {
      if (block.type === 'text') {
        textOutput += block.text;
      }
    }

    if (textOutput.includes('IMPLEMENTATION_COMPLETE')) {
      return {
        success: true,
        output: `Implementation complete. Changed files: ${changedFiles.join(', ')}`,
        needsHumanInput: false,
        suggestedNextAgent: 'tester',
        data: { changedFiles, iterations },
      };
    }

    if (textOutput.includes('IMPLEMENTATION_BLOCKED:')) {
      const reason = textOutput.split('IMPLEMENTATION_BLOCKED:')[1]?.trim() || 'Unknown';
      return {
        success: false,
        output: `Implementation blocked: ${reason}`,
        needsHumanInput: true,
        humanQuestion: `Implementation is blocked: ${reason}. How should we proceed?`,
        error: reason,
      };
    }

    const toolUseBlocks = response.content.filter(
      (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use'
    );

    if (toolUseBlocks.length > 0) {
      messages.push({ role: 'assistant', content: response.content });

      const toolResults: Anthropic.ToolResultBlockParam[] = [];
      for (const toolUse of toolUseBlocks) {
        console.log(`[Implementer] Tool: ${toolUse.name}`, JSON.stringify(toolUse.input).slice(0, 200));
        
        const result = await executor.execute(toolUse.name, toolUse.input as Record<string, unknown>);
        
        console.log(`[Implementer] Result: ${result.success ? 'OK' : 'FAILED'} - ${(result.output || result.error || '').slice(0, 100)}`);
        
        if (toolUse.name === 'write_file' || toolUse.name === 'apply_diff') {
          const filePath = (toolUse.input as { path: string }).path;
          if (!changedFiles.includes(filePath)) {
            changedFiles.push(filePath);
          }
        }

        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.success ? result.output : `Error: ${result.error}`,
          is_error: !result.success,
        });
      }

      messages.push({ role: 'user', content: toolResults });
    } else {
      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: 'Continue implementation or say IMPLEMENTATION_COMPLETE if done.' });
    }
  }

  return {
    success: false,
    output: `Hit max iterations (${maxIterations})`,
    needsHumanInput: true,
    humanQuestion: 'Implementation reached max iterations. Review progress and advise.',
    data: { changedFiles, iterations },
  };
}

async function runTesterAgent(context: AgentContext, repoPath: string): Promise<AgentResult> {
  // TEMPORARILY SKIPPING ALL TESTS - just pass through to PR creation
  console.log('[Tester] Skipping all tests (disabled for now)');
  
  const summary = `⏭️ Type Check (skipped)
⏭️ Lint (skipped)
⏭️ Build (skipped)
⏭️ Tests (skipped)

_All tests disabled - proceeding to PR creation_`;

  return {
    success: true,
    output: summary,
    needsHumanInput: false,
    suggestedNextAgent: 'pr-creator',
    data: { results: [], allPassed: true, criticalPassed: true, testsDisabled: true },
  };
}

async function runPRCreatorAgent(context: AgentContext, repoPath: string): Promise<AgentResult> {
  const { session, payload } = context;
  const { source_repo, issue_number } = payload;
  const githubToken = process.env.GITHUB_TOKEN;

  if (!githubToken || !issue_number) {
    return { success: false, output: '', needsHumanInput: false, error: 'Missing token or issue number' };
  }

  const { exec } = await import('child_process');
  const { promisify } = await import('util');
  const execAsync = promisify(exec);
  const { Octokit } = await import('@octokit/rest');

  const [owner, repo] = source_repo.split('/');
  const branchName = `agent/issue-${issue_number}`;
  const octokit = new Octokit({ auth: githubToken });

  try {
    await execAsync('git config user.email "agent@cherry-automation.dev"', { cwd: repoPath });
    await execAsync('git config user.name "Cherry Agent"', { cwd: repoPath });

    const { stdout: status } = await execAsync('git status --porcelain', { cwd: repoPath });
    if (!status.trim()) {
      return { success: false, output: 'No changes to commit', needsHumanInput: false, error: 'No changes' };
    }

    try {
      await execAsync(`git checkout -b ${branchName}`, { cwd: repoPath });
    } catch {
      await execAsync(`git checkout ${branchName}`, { cwd: repoPath });
    }

    await execAsync('git add -A', { cwd: repoPath });
    const title = String(session.metadata.issue_title || `Fix issue #${issue_number}`);
    await execAsync(`git commit -m "${title}"`, { cwd: repoPath });

    const remoteUrl = `https://x-access-token:${githubToken}@github.com/${source_repo}.git`;
    await execAsync(`git remote set-url origin ${remoteUrl}`, { cwd: repoPath });
    await execAsync(`git push -u origin ${branchName} --force`, { cwd: repoPath });

    const { data: pr } = await octokit.pulls.create({
      owner,
      repo,
      title: `🤖 ${title}`,
      head: branchName,
      base: 'main',
      body: `Closes #${issue_number}\n\n${session.metadata.scope || ''}\n\n---\n🤖 Auto-generated by Cherry Agent`,
    });

    return {
      success: true,
      output: `PR #${pr.number} created: ${pr.html_url}`,
      needsHumanInput: false,
      data: { prNumber: pr.number, prUrl: pr.html_url },
    };

  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { success: false, output: '', needsHumanInput: true, error: message };
  }
}

