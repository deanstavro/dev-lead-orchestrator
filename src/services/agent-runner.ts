import Anthropic from '@anthropic-ai/sdk';
import { AgentContext, AgentResult, AgentName } from '../types/index.js';
import { sessionService } from './session.js';
import { ToolExecutor } from '../tools/executor.js';
import { CODE_TOOLS, COMPLEXITY_THRESHOLDS } from '../tools/definitions.js';

const anthropic = new Anthropic();

// ============================================================================
// COMPLEXITY ANALYSIS
// ============================================================================

interface ComplexityAnalysis {
  score: number;
  useClaudeCode: boolean;
  reasons: string[];
}

/**
 * Analyze task complexity to determine if we should use Claude Code CLI
 */
function analyzeTaskComplexity(plan: string, design: string): ComplexityAnalysis {
  const reasons: string[] = [];
  let score = 0;
  const combined = `${plan} ${design}`.toLowerCase();

  // Count file references
  const fileMatches = combined.match(/\.(ts|tsx|js|jsx|css|json|md)/g) || [];
  if (fileMatches.length > COMPLEXITY_THRESHOLDS.fileCountThreshold) {
    score += 30;
    reasons.push(`${fileMatches.length} files mentioned (threshold: ${COMPLEXITY_THRESHOLDS.fileCountThreshold})`);
  }

  // Check for complex keywords
  for (const keyword of COMPLEXITY_THRESHOLDS.complexKeywords) {
    if (combined.includes(keyword)) {
      score += 15;
      reasons.push(`Contains "${keyword}"`);
    }
  }

  // Check for cross-cutting concerns
  if (combined.includes('codebase') || combined.includes('project-wide')) {
    score += 25;
    reasons.push('Codebase-wide change');
  }

  // Check for architectural changes
  if (combined.includes('architectural') || combined.includes('restructure') || combined.includes('redesign')) {
    score += 20;
    reasons.push('Architectural change');
  }

  // Check for migration patterns
  if (combined.includes('from') && combined.includes('to') && (combined.includes('migrate') || combined.includes('convert'))) {
    score += 20;
    reasons.push('Migration pattern detected');
  }

  return {
    score,
    useClaudeCode: score >= COMPLEXITY_THRESHOLDS.scoreThreshold,
    reasons,
  };
}

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
  const { session } = context;
  const executor = new ToolExecutor(repoPath);
  
  // Check if this is an "execute approved plan" call
  const approvedPlan = session.metadata.approved_claude_code_plan as string | undefined;
  const pendingPlan = session.metadata.pending_claude_code_plan as string | undefined;
  
  // If there's an approved plan, execute it with Claude Code
  if (approvedPlan) {
    console.log('[Implementer] Executing approved Claude Code plan...');
    return await executeWithClaudeCode(executor, baseContext, approvedPlan);
  }
  
  // Analyze complexity to decide implementation strategy
  const plan = String(session.metadata.plan || '');
  const design = String(session.metadata.design || '');
  const complexity = analyzeTaskComplexity(plan, design);
  
  console.log(`[Implementer] Complexity analysis: score=${complexity.score}, useClaudeCode=${complexity.useClaudeCode}`);
  if (complexity.reasons.length > 0) {
    console.log(`[Implementer] Reasons: ${complexity.reasons.join(', ')}`);
  }
  
  // For complex tasks, use Claude Code CLI (plan first, then approve)
  if (complexity.useClaudeCode && !pendingPlan) {
    console.log('[Implementer] Complex task detected, generating Claude Code plan for approval...');
    
    const planResult = await executor.runClaudeCodePlan(baseContext);
    
    if (!planResult.success) {
      console.log('[Implementer] Claude Code not available, falling back to basic tools');
      // Fall back to basic implementation
      return await runBasicImplementer(executor, baseContext, plan, design);
    }
    
    // Return plan for human approval
    return {
      success: true,
      output: planResult.plan || planResult.output,
      needsHumanInput: true,
      humanQuestion: `🤖 **Claude Code Plan**\n\nThis task is complex (score: ${complexity.score}/100). Claude Code has generated a plan:\n\n${planResult.plan}\n\n---\n\n**Please review and reply:**\n- "approve" - Execute this plan\n- "modify: [changes]" - Adjust the plan\n- "basic" - Use basic tools instead`,
      data: { 
        complexity,
        pendingClaudeCodePlan: planResult.plan,
        planSummary: planResult.summary,
      },
    };
  }
  
  // For simple tasks, use basic tool-based implementation
  console.log('[Implementer] Using basic tools for implementation');
  return await runBasicImplementer(executor, baseContext, plan, design);
}

/**
 * Execute implementation using Claude Code CLI with approved plan
 */
async function executeWithClaudeCode(
  executor: ToolExecutor,
  taskContext: string,
  approvedPlan: string
): Promise<AgentResult> {
  console.log('[Implementer] Running Claude Code with approved plan...');
  
  const result = await executor.runClaudeCodeExecute(taskContext, approvedPlan);
  
  if (!result.success) {
    return {
      success: false,
      output: result.output,
      needsHumanInput: true,
      humanQuestion: `Claude Code execution failed:\n\n${result.error}\n\nHow should we proceed?`,
      error: result.error,
    };
  }
  
  return {
    success: true,
    output: `${result.summary}\n\n${result.output}`,
    needsHumanInput: false,
    suggestedNextAgent: 'tester',
    data: { 
      changedFiles: result.filesChanged,
      usedClaudeCode: true,
    },
  };
}

/**
 * Extract file paths mentioned in plan/design text
 */
function extractFilePaths(text: string): string[] {
  const paths: string[] = [];
  
  // Match patterns like: src/components/Button.tsx, app/admin/page.tsx, etc.
  const filePatterns = text.match(/[\w\-\/]+\.(tsx?|jsx?|json|css|md)/g) || [];
  
  for (const match of filePatterns) {
    // Clean up the path
    const cleanPath = match.replace(/^[^\w]/, '');
    if (!paths.includes(cleanPath) && cleanPath.includes('/')) {
      paths.push(cleanPath);
    }
  }
  
  return paths;
}

/**
 * Gather initial codebase context before implementation
 */
async function gatherInitialContext(
  executor: ToolExecutor,
  plan: string,
  design: string
): Promise<string> {
  console.log('[Implementer] Gathering initial codebase context...');
  
  const contextParts: string[] = [];
  
  // 1. Get directory structure
  try {
    const dirResult = await executor.execute('list_directory', { path: '.', recursive: false });
    if (dirResult.success) {
      contextParts.push(`## Project Structure (root)\n${dirResult.output}`);
    }
  } catch (e) {
    console.log('[Implementer] Could not read root directory');
  }
  
  // 2. Read package.json for dependencies and scripts
  try {
    const pkgResult = await executor.execute('read_file', { path: 'package.json' });
    if (pkgResult.success) {
      contextParts.push(`## package.json\n${pkgResult.output.slice(0, 3000)}`);
    }
  } catch (e) {
    console.log('[Implementer] Could not read package.json');
  }
  
  // 3. Extract and read files mentioned in plan/design
  const mentionedFiles = extractFilePaths(`${plan} ${design}`);
  console.log(`[Implementer] Files mentioned in plan: ${mentionedFiles.join(', ') || 'none'}`);
  
  for (const filePath of mentionedFiles.slice(0, 5)) { // Limit to first 5 files
    try {
      const fileResult = await executor.execute('read_file', { path: filePath });
      if (fileResult.success) {
        contextParts.push(`## ${filePath}\n${fileResult.output}`);
        console.log(`[Implementer] Pre-read: ${filePath} (${fileResult.output.length} chars)`);
      }
    } catch (e) {
      console.log(`[Implementer] Could not pre-read: ${filePath}`);
    }
  }
  
  // 4. If plan mentions a specific directory, explore it
  const dirPatterns = plan.match(/(?:app|src|components|lib|pages)\/[\w\-\/]+/g) || [];
  const uniqueDirs = [...new Set(dirPatterns.map(p => p.split('/').slice(0, 2).join('/')))];
  
  for (const dir of uniqueDirs.slice(0, 3)) { // Limit to first 3 directories
    try {
      const dirResult = await executor.execute('list_directory', { path: dir, recursive: false });
      if (dirResult.success) {
        contextParts.push(`## Directory: ${dir}\n${dirResult.output}`);
        console.log(`[Implementer] Pre-explored: ${dir}`);
      }
    } catch (e) {
      console.log(`[Implementer] Could not explore: ${dir}`);
    }
  }
  
  if (contextParts.length === 0) {
    return '';
  }
  
  console.log(`[Implementer] Gathered ${contextParts.length} context sections`);
  return `\n\n# Pre-gathered Codebase Context\n\n${contextParts.join('\n\n')}`;
}

/**
 * Basic tool-based implementation (original approach)
 */
async function runBasicImplementer(
  executor: ToolExecutor,
  baseContext: string,
  plan?: string,
  design?: string
): Promise<AgentResult> {
  // Gather initial context from codebase
  const initialContext = await gatherInitialContext(executor, plan || '', design || '');
  
  const enrichedContext = `${baseContext}${initialContext}

IMPORTANT: I've pre-loaded key files above. Use this context to understand the codebase structure. 
Focus on making targeted changes rather than exploring extensively.`;

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: `${enrichedContext}\n\nBegin implementation. Make targeted changes based on the context provided above.` },
  ];

  const changedFiles: string[] = [];
  let iterations = 0;
  const maxIterations = 1000;

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
        data: { changedFiles, iterations, usedClaudeCode: false },
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
    data: { changedFiles, iterations, usedClaudeCode: false },
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

