# Cherry Automation

AI-powered Team Lead agent that autonomously takes GitHub issues from creation to merged PR.

## How It Works

```
┌─────────────────────────────────────────────────────────────────┐
│                         TEAM LEAD                                │
│                    (orchestrating agent)                         │
│                                                                  │
│   "Analyze ticket → Decide next step → Delegate → Evaluate"     │
└─────────────────────────────────┬───────────────────────────────┘
                                  │
          ┌───────────┬───────────┼───────────┬───────────┐
          ▼           ▼           ▼           ▼           ▼
    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐
    │Clarifier │ │  Scope   │ │ Designer │ │Implementer│ │ Tester   │
    └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
                                                              │
                                                              ▼
                                                        ┌──────────┐
                                                        │PR Creator│
                                                        └──────────┘
```

1. Add `agent:start` label to an issue
2. **Team Lead** analyzes the ticket and decides what to do
3. Delegates to specialist agents as needed (can skip phases, loop back)
4. Continues until PR is created or blocked
5. Posts updates as GitHub comments throughout

---

## Team Lead vs Pipeline Mode

### Team Lead Mode (Default)
The Team Lead is an orchestrating agent that:
- **Thinks** about what the ticket needs
- **Delegates** to specialist agents dynamically
- **Evaluates** outputs and decides next steps
- **Adapts** - skips unnecessary phases, loops back if needed

```
Simple bug fix:    Clarifier → Implementer → Tester → PR (skips scope/design)
Complex feature:   Clarifier → Scope → Designer → Planner → Implementer → Tester → PR
Unclear ticket:    Clarifier → (ask human) → Clarifier → Scope → ...
```

### Pipeline Mode (Legacy)
Fixed sequential phases, triggered by labels:
```
agent:start → agent:implement → agent:test → agent:pr
```

Use `agent_start_pipeline` event type for legacy mode.

---

## Project Structure

```
src/
├── index.ts                 # Entry point
├── orchestrator.ts          # Routes events to handlers
│
├── agents/
│   ├── team-lead.ts         # 🧠 Orchestrating agent with tools
│   ├── clarifier.ts         # Asks clarifying questions
│   ├── scope.ts             # Defines acceptance criteria
│   ├── designer.ts          # Technical approach
│   ├── planner.ts           # Implementation tasks
│   ├── implementer.ts       # Writes code (uses tools)
│   ├── tester.ts            # Runs tests
│   └── pr-creator.ts        # Opens pull request
│
├── handlers/
│   ├── team-lead.ts         # Handles agent:start for Team Lead
│   ├── agent-start.ts       # Legacy pipeline start
│   ├── human-response.ts    # Processes human comments
│   └── ...
│
├── services/
│   ├── agent-runner.ts      # Runs any agent, returns structured result
│   ├── session.ts           # Supabase CRUD
│   └── github.ts            # GitHub API
│
├── tools/
│   ├── definitions.ts       # Tool schemas for Claude
│   └── executor.ts          # Executes tools safely
│
└── types/
    └── index.ts             # TypeScript interfaces
```

---

## Team Lead Tools

The Team Lead has these tools to manage the workflow:

| Tool | Purpose |
|------|---------|
| `delegate_to_agent` | Run a specialist agent (clarifier, scope, designer, etc.) |
| `ask_human` | Post a question and wait for human response |
| `think` | Record reasoning (for debugging/transparency) |
| `mark_complete` | Finish the ticket |
| `mark_blocked` | Pause when stuck |

---

## Specialist Agents

| Agent | Purpose | Has Tools? |
|-------|---------|------------|
| **Clarifier** | Ask questions to understand requirements | No |
| **Scope** | Define acceptance criteria & boundaries | No |
| **Designer** | Technical approach & architecture | No |
| **Planner** | Break into implementation tasks | No |
| **Implementer** | Write code changes | Yes (file tools) |
| **Tester** | Run tests, verify build | Yes (run commands) |
| **PR Creator** | Create branch, commit, open PR | Yes (git commands) |

---

## Implementer Tools

The Implementer agent can use these tools to modify code:

| Tool | Purpose |
|------|---------|
| `read_file` | Read file contents |
| `write_file` | Create/overwrite files |
| `apply_diff` | Make targeted edits |
| `list_directory` | Explore codebase |
| `search_code` | Find patterns |
| `run_command` | Run npm scripts (whitelisted) |

### Safety Guards
- Protected paths: `.env`, `.git`, `node_modules`, `.github/workflows`
- Whitelisted commands only: `npm test`, `npm build`, etc.
- Output truncated to prevent token explosion
- Max iterations limit

---

## Setup

### 1. Database

Run the migration in Supabase:

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  current_phase TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  conversation JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repo, issue_number)
);
```

### 2. GitHub Secrets

Add to **cherry-automation** repo:

| Secret | Description |
|--------|-------------|
| `GH_PAT` | GitHub PAT with `repo` scope |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |

### 3. Source Repo Workflow

Copy `.github/workflows/on-label.yml` to your source repo and update the repository target.

### 4. Labels

Create in your source repo:
- `agent:start` - Triggers Team Lead
- `agent:stop` - Cancels session
- `agent:complete` - Added when done
- `agent:pr-ready` - Added when PR is created

---

## Usage

### Automatic (Team Lead)

1. Create an issue with clear description
2. Add `agent:start` label
3. Team Lead takes over:
   - Posts status updates
   - Asks questions if needed (reply to continue)
   - Implements, tests, creates PR
4. Review and merge the PR

### Manual Override

If you want to manually trigger specific phases:
- `agent:implement` - Run implementer only
- `agent:test` - Run tests only

---

## Example Flow

```
Issue: "Add dark mode toggle to settings"
         ↓
🤖 Team Lead: "Analyzing ticket... delegating to Clarifier"
         ↓
🔍 Clarifier: "Questions: 1) System-wide or per-page? 2) OS preference?"
         ↓
👤 Human: "System-wide, respect OS preference"
         ↓
🤖 Team Lead: "Got it, skipping Scope (simple feature), going to Designer"
         ↓
🏗️ Designer: "Use CSS variables with data-theme attribute..."
         ↓
🤖 Team Lead: "Design looks good, delegating to Planner"
         ↓
📝 Planner: "Tasks: 1) Add CSS vars 2) Create toggle 3) Add to settings"
         ↓
🤖 Team Lead: "Plan ready, starting Implementation"
         ↓
🔧 Implementer: [reads files, makes changes, runs tests]
         ↓
🧪 Tester: "✅ All tests pass"
         ↓
🚀 PR Creator: "PR #123 created: github.com/..."
         ↓
🎉 Team Lead: "Done! PR ready for review"
```

---

## Architecture Decisions

- **Team Lead over fixed pipeline**: Adaptive behavior, can skip/loop phases
- **Specialist agents**: Focused prompts are easier to tune
- **GitHub Actions**: Free, no cold starts, built-in secrets
- **Supabase**: Structured state, queryable history
- **Tool-based implementation**: Safe, controlled code modifications

---

## Limits & Safety

| Limit | Value |
|-------|-------|
| Team Lead iterations | 25 |
| Implementer iterations | 30 |
| Workflow timeout | 30 min |
| Protected files | `.env`, `.git`, `node_modules` |
| Allowed commands | `npm test`, `npm build`, etc. |

---

## Development

```bash
npm install
npm run type-check
npm run build

# Run locally (requires env vars)
EVENT_TYPE=agent_start EVENT_PAYLOAD='{"source_repo":"...","issue_number":1}' npm start
```

---

## Troubleshooting

**Team Lead keeps looping?**
- Check max iterations (25 by default)
- Review the reasoning in GitHub comments

**Implementer can't find files?**
- Make sure `REPO_PATH` is set correctly
- Check if repo uses npm (some use yarn/pnpm)

**PR creation fails?**
- Ensure `GH_PAT` has write access to source repo
- Check if branch already exists

**Tests fail?**
- Implementer may need to retry
- Human can provide guidance via comment
