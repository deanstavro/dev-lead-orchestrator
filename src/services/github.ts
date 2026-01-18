import { Octokit } from '@octokit/rest';

const githubToken = process.env.GITHUB_TOKEN;

if (!githubToken) {
  throw new Error('Missing GITHUB_TOKEN');
}

const octokit = new Octokit({ auth: githubToken });

export class GitHubService {
  private parseRepo(repo: string): { owner: string; repo: string } {
    const [owner, repoName] = repo.split('/');
    return { owner, repo: repoName };
  }

  async postComment(repo: string, issueNumber: number, body: string): Promise<void> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    
    await octokit.issues.createComment({
      owner,
      repo: repoName,
      issue_number: issueNumber,
      body,
    });
  }

  async getIssue(repo: string, issueNumber: number) {
    const { owner, repo: repoName } = this.parseRepo(repo);
    
    const { data } = await octokit.issues.get({
      owner,
      repo: repoName,
      issue_number: issueNumber,
    });

    return data;
  }

  async getIssueComments(repo: string, issueNumber: number) {
    const { owner, repo: repoName } = this.parseRepo(repo);
    
    const { data } = await octokit.issues.listComments({
      owner,
      repo: repoName,
      issue_number: issueNumber,
    });

    return data;
  }

  async addLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    
    await octokit.issues.addLabels({
      owner,
      repo: repoName,
      issue_number: issueNumber,
      labels: [label],
    });
  }

  async removeLabel(repo: string, issueNumber: number, label: string): Promise<void> {
    const { owner, repo: repoName } = this.parseRepo(repo);
    
    try {
      await octokit.issues.removeLabel({
        owner,
        repo: repoName,
        issue_number: issueNumber,
        name: label,
      });
    } catch (error: unknown) {
      // Ignore if label doesn't exist
      if ((error as { status?: number }).status !== 404) throw error;
    }
  }
}

export const githubService = new GitHubService();

