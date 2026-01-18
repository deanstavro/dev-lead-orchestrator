import { AgentContext, ConversationMessage } from '../types/index.js';
import { sessionService } from '../services/session.js';
import { githubService } from '../services/github.js';
import { ToolExecutor } from '../tools/executor.js';

interface TestResult {
  name: string;
  passed: boolean;
  output: string;
  duration?: number;
}

export async function runTester(context: AgentContext): Promise<{ passed: boolean; results: TestResult[] }> {
  const { session, payload } = context;
  const { source_repo, issue_number } = payload;

  if (!issue_number) throw new Error('Missing issue_number');

  const repoPath = process.env.REPO_PATH || process.env.GITHUB_WORKSPACE || './source-repo';
  
  console.log(`Running tester for ${source_repo}#${issue_number}`);

  await githubService.postComment(
    source_repo,
    issue_number,
    `🧪 **Running Tests**\n\nVerifying the implementation...`
  );

  const executor = new ToolExecutor(repoPath);
  const results: TestResult[] = [];
  let allPassed = true;

  // Test 1: TypeScript/Type Check
  console.log('Running type check...');
  const typeCheckStart = Date.now();
  const typeCheckResult = await executor.execute('run_command', { command: 'npx tsc --noEmit' });
  results.push({
    name: 'Type Check',
    passed: typeCheckResult.success,
    output: typeCheckResult.success ? 'No type errors' : (typeCheckResult.error || typeCheckResult.output),
    duration: Date.now() - typeCheckStart,
  });
  if (!typeCheckResult.success) allPassed = false;

  // Test 2: Lint Check
  console.log('Running lint check...');
  const lintStart = Date.now();
  const lintResult = await executor.execute('run_command', { command: 'npm run lint' });
  results.push({
    name: 'Lint',
    passed: lintResult.success,
    output: lintResult.success ? 'No lint errors' : (lintResult.error || lintResult.output),
    duration: Date.now() - lintStart,
  });
  // Lint failures are warnings, not blockers
  // if (!lintResult.success) allPassed = false;

  // Test 3: Build
  console.log('Running build...');
  const buildStart = Date.now();
  const buildResult = await executor.execute('run_command', { command: 'npm run build' });
  results.push({
    name: 'Build',
    passed: buildResult.success,
    output: buildResult.success ? 'Build successful' : (buildResult.error || buildResult.output),
    duration: Date.now() - buildStart,
  });
  if (!buildResult.success) allPassed = false;

  // Test 4: Unit Tests
  console.log('Running unit tests...');
  const testStart = Date.now();
  const testResult = await executor.execute('run_command', { command: 'npm test' });
  results.push({
    name: 'Unit Tests',
    passed: testResult.success,
    output: testResult.output || testResult.error || 'No output',
    duration: Date.now() - testStart,
  });
  if (!testResult.success) allPassed = false;

  // Save test results to session
  const testMessage: ConversationMessage = {
    role: 'assistant',
    content: `Test results: ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`,
    timestamp: new Date().toISOString(),
    metadata: { phase: 'testing', results },
  };
  await sessionService.addMessage(session.id, testMessage);
  await sessionService.updateMetadata(session.id, { testResults: results, testsPassed: allPassed });

  // Format results for GitHub comment
  const resultLines = results.map(r => {
    const icon = r.passed ? '✅' : '❌';
    const duration = r.duration ? ` (${(r.duration / 1000).toFixed(1)}s)` : '';
    return `${icon} **${r.name}**${duration}`;
  });

  const detailsSection = results
    .filter(r => !r.passed)
    .map(r => `<details>\n<summary>${r.name} output</summary>\n\n\`\`\`\n${r.output.slice(0, 2000)}\n\`\`\`\n</details>`)
    .join('\n\n');

  if (allPassed) {
    await sessionService.updatePhase(session.id, 'testing');
    
    await githubService.postComment(
      source_repo,
      issue_number,
      `🧪 **Test Results**\n\n${resultLines.join('\n')}\n\n---\n\n✅ **All tests passed!**\n\nReady to create a pull request.`
    );
  } else {
    await githubService.postComment(
      source_repo,
      issue_number,
      `🧪 **Test Results**\n\n${resultLines.join('\n')}\n\n${detailsSection}\n\n---\n\n❌ **Some tests failed.**\n\nThe implementation may need fixes. Review the errors above.`
    );
  }

  return { passed: allPassed, results };
}

