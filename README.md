# Cherry Automation

AI-powered agents that refine GitHub issues through structured phases: clarification, scoping, design, and planning.

## How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│ cherry-frontend │────▶│ GitHub Actions   │────▶│cherry-automation│
│ (your repo)     │     │ repository_dispatch    │ (this repo)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
        │                                                │
        │  1. Add label `agent:start`                    │
        │                                                ▼
        │                                    ┌───────────────────┐
        │                                    │   Orchestrator    │
        │                                    └─────────┬─────────┘
        │                                              │
        │         ┌────────────────────────────────────┼────────────────────────────────────┐
        │         ▼                    ▼               ▼               ▼                    │
        │   ┌──────────┐        ┌──────────┐    ┌──────────┐    ┌──────────┐               │
        │   │Clarifier │───────▶│  Scope   │───▶│ Designer │───▶│ Planner  │               │
        │   └──────────┘        └──────────┘    └──────────┘    └──────────┘               │
        │         │                                                    │                    │
        │         └──────────────── Supabase ──────────────────────────┘                    │
        │                        (session state)                                            │
        │                                                                                   │
        └◀──────────────────────── Comments on issue ◀──────────────────────────────────────┘
```

1. Developer adds `agent:start` label to an issue
2. GitHub Action in source repo triggers `repository_dispatch` to this repo
3. Orchestrator routes event to appropriate handler
4. Agents process the issue through 4 phases, commenting on GitHub
5. Session state persists in Supabase between interactions

---

## Project Structure

```
src/
├── index.ts              # Entry point - parses env vars, calls orchestrator
├── orchestrator.ts       # Routes events to handlers
│
├── handlers/             # Event handlers
│   ├── agent-start.ts    # Creates session, kicks off clarifier
│   ├── agent-stop.ts     # Cancels active session
│   ├── human-response.ts # Routes user comments to active agent
│   ├── qa-review.ts      # Automated PR review
│   └── post-merge.ts     # Marks session complete on merge
│
├── agents/               # AI agents (Claude-powered)
│   ├── clarifier.ts      # Asks questions to understand requirements
│   ├── scope.ts          # Defines acceptance criteria & boundaries
│   ├── designer.ts       # Outlines technical approach
│   └── planner.ts        # Breaks work into tasks with estimates
│
├── services/
│   ├── session.ts        # Supabase CRUD for agent_sessions
│   └── github.ts         # GitHub API (comments, labels)
│
├── supabase/
│   └── client.ts         # Supabase client initialization
│
└── types/
    └── index.ts          # TypeScript interfaces
```

---

## Agents

Each agent is a focused AI that handles one phase of ticket refinement.

| Agent | Purpose | Output |
|-------|---------|--------|
| **Clarifier** | Understands the problem | 2-4 clarifying questions per round |
| **Scope** | Defines boundaries | Acceptance criteria, in/out of scope, complexity |
| **Designer** | Technical approach | Components to modify, architecture decisions, risks |
| **Planner** | Implementation tasks | Ordered task list with hour estimates |

Agents automatically transition to the next phase when complete, or pause to wait for human input.

---

## Handlers

| Handler | Trigger | Action |
|---------|---------|--------|
| `agent-start` | `agent:start` label added | Create session, start clarifier |
| `agent-stop` | `agent:stop` label added | Cancel session |
| `human-response` | Comment on active issue | Route to current phase's agent |
| `qa-review` | PR opened/updated | Automated code review |
| `post-merge` | PR merged | Mark session complete |

---

## Setup

### 1. Database

Run the migration in your Supabase project:

```sql
-- supabase/migrations/001_agent_sessions.sql
```

### 2. GitHub Secrets

Add these secrets to the **cherry-automation** repo:

| Secret | Description |
|--------|-------------|
| `GH_PAT` | GitHub PAT with `repo` scope |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |

### 3. Source Repo Workflow

Copy `.github/workflows/on-label.yml` to your source repo (e.g., `cherry-frontend`).

Update the `repository` field to point to your automation repo:

```yaml
repository: YOUR-ORG/cherry-automation
```

### 4. Labels

Create these labels in your source repo:

- `agent:start` - Triggers agent session
- `agent:stop` - Cancels agent session  
- `agent:complete` - Added when all phases finish

---

## Usage

1. Create an issue in your source repo
2. Add the `agent:start` label
3. Agent posts clarifying questions as a comment
4. Reply to answer questions
5. Agent progresses through phases automatically
6. When complete, `agent:complete` label is added

To stop an agent mid-session, add the `agent:stop` label.

---

## Development

```bash
# Install dependencies
npm install

# Type check
npm run type-check

# Run locally (requires env vars)
EVENT_TYPE=agent_start EVENT_PAYLOAD='{}' npm start
```

### Environment Variables

```bash
GITHUB_TOKEN=ghp_xxx
ANTHROPIC_API_KEY=sk-ant-xxx
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJxxx
```

---

## Architecture Decisions

- **GitHub Actions over server**: Free, no cold starts for async work, built-in secrets
- **Supabase for state**: Already in stack, structured data, queryable history
- **Phase-based agents**: Each agent has focused responsibility, easier to tune prompts
- **Conversation persistence**: Full history enables context-aware responses across sessions

