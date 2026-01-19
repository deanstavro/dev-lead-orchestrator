# Team Lead Automation

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
    │  📖 R    │ │  📖 R    │ │  📖 R    │ │  📖 RW   │ │  📖 R+C  │
    └──────────┘ └──────────┘ └──────────┘ └──────────┘ └──────────┘
                                                              │
                                                              ▼
                                                        ┌──────────┐
                                                        │PR Creator│
                                                        │  📖 RW+G │
                                                        └──────────┘

Legend: R = Read codebase  |  RW = Read/Write files  |  C = Commands  |  G = Git
```

1. Add `agent:start` label to an issue
2. **Team Lead** analyzes the ticket and decides what to do
3. Delegates to specialist agents (all have codebase context!)
4. Continues until PR is created or blocked
5. Posts updates as GitHub comments throughout

---

## Context-Aware Agents

**All agents can now explore the codebase before responding.** This means:

| Before | After |
|--------|-------|
| "What framework are you using?" | *reads package.json* "I see you're using Next.js 14 with shadcn/ui..." |
| "Create a new component" | *searches existing* "I'll follow the pattern in `src/components/ui/Button.tsx`..." |
| "Estimated 8 hours" | *analyzes actual code* "This touches 3 files, ~2h realistic estimate" |

### How Context Gathering Works

```
┌────────────────────────────────────────────────────────────────┐
│  Agent receives task                                           │
│            ↓                                                   │
│  list_directory(".")  →  Understand project structure          │
│  read_file("package.json")  →  See dependencies, scripts       │
│  search_code("Button")  →  Find existing patterns              │
│            ↓                                                   │
│  Agent responds with SPECIFIC, ACCURATE information            │
└────────────────────────────────────────────────────────────────┘
```

Each agent gets up to **5-6 iterations** to explore before responding.

---

## Tool Access Matrix

| Agent | read_file | list_dir | search | write_file | apply_diff | run_cmd | Claude Code | git |
|-------|:---------:|:--------:|:------:|:----------:|:----------:|:-------:|:-----------:|:---:|
| **Team Lead** | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Clarifier** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Scope** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Designer** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Planner** | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Implementer** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅* | ❌ |
| **Tester** | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ❌ |
| **PR Creator** | ✅ | ✅ | ✅ | ❌ | ❌ | ✅ | ❌ | ✅ |

*Claude Code is used automatically for complex tasks (score ≥ 40) with human approval.

**Key principle**: READ tools are available to all agents for context. WRITE tools are restricted to agents that need them. Claude Code is used for complex refactors with a plan-approve-execute flow.

---

## Specialist Agents

### 🔍 Clarifier
**Purpose**: Ask questions to understand requirements  
**Tools**: Read-only codebase access  
**Output**: Numbered questions, "PHASE_COMPLETE" when done

```
"I see your project uses Next.js App Router with TypeScript. 
Should the new auth flow use Server Actions or API routes?"
```

### 📋 Scope
**Purpose**: Define acceptance criteria & boundaries  
**Tools**: Read-only codebase access  
**Output**: Acceptance criteria, in/out of scope, files to modify, complexity estimate

```
## Files to Modify
- src/app/settings/page.tsx: Add dark mode toggle
- src/lib/theme.ts: Create theme context
```

### 🏗️ Designer
**Purpose**: Technical approach & architecture  
**Tools**: Read-only codebase access  
**Output**: Technical approach, components to modify, patterns to follow

```
## Existing Patterns to Follow
- Pattern from src/hooks/useAuth.ts: Use Zustand for state management
- Pattern from src/components/ui/: Follow shadcn/ui conventions
```

### 📝 Planner
**Purpose**: Break into implementation tasks  
**Tools**: Read-only codebase access  
**Output**: Task list with file paths, line numbers, estimates

```
### Phase 1: Theme Foundation
- [ ] **Task 1.1** (1h): Create theme context
  - File: src/lib/theme.ts (new)
  - Changes: Export useTheme hook following useAuth pattern
```

### 🔧 Implementer
**Purpose**: Write actual code changes  
**Tools**: Full read/write access + npm commands + Claude Code CLI  
**Loop**: Up to 1000 iterations until task complete

**Smart Initial Exploration**: Before implementing, the agent automatically:
1. Reads root directory structure
2. Reads `package.json` for dependencies
3. Pre-reads files mentioned in the plan (up to 5)
4. Explores directories mentioned in the plan

This gives the implementer context **before it starts guessing**.

**Smart Routing**: Analyzes task complexity and chooses the best approach:
- **Simple tasks** (score < 25): Uses basic tools with pre-gathered context
- **Complex tasks** (score ≥ 25): Uses Claude Code CLI

For complex tasks, a **plan-approve-execute** flow is used:
1. Claude Code generates a detailed plan
2. Plan is posted to GitHub for human approval
3. Human replies: "approve", "modify: [changes]", or "basic"
4. On approval, Claude Code executes the plan

### 🧪 Tester
**Purpose**: Verify changes work  
**Tools**: Read access + npm commands  
**Runs**: Type check, lint, build, tests (skips if scripts don't exist)

### 🚀 PR Creator
**Purpose**: Create branch, commit, push, open PR  
**Tools**: Read access + git commands  
**Output**: PR URL with description

---

## Team Lead Tools

The Team Lead orchestrates but doesn't modify code directly:

| Tool | Purpose |
|------|---------|
| `delegate_to_agent` | Run a specialist agent |
| `ask_human` | Post a question and wait |
| `think` | Record reasoning (shown in logs) |
| `mark_complete` | Finish the ticket |
| `mark_blocked` | Pause when stuck |

---

## Claude Code Integration

For complex implementation tasks, Cherry Automation integrates with **Claude Code CLI** for more powerful codebase modifications.

### How It Works

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Implementer receives task                                                   │
│            ↓                                                                │
│  ┌─────────────────────────────────────┐                                   │
│  │  Complexity Analysis                 │                                   │
│  │  • Count files mentioned            │                                   │
│  │  • Check for keywords: refactor,    │                                   │
│  │    migrate, upgrade, etc.           │                                   │
│  │  • Score: 0-100                     │                                   │
│  └─────────────────────────────────────┘                                   │
│            ↓                                                                │
│  Score < 40: Basic tools          Score ≥ 40: Claude Code CLI              │
│            │                                │                               │
│            ↓                                ↓                               │
│  Direct file edits              1. Generate plan                           │
│  (read/write/apply_diff)        2. Post for approval                       │
│                                 3. Human: "approve"                        │
│                                 4. Execute with Claude Code                │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Complexity Indicators

| Indicator | Score |
|-----------|-------|
| More than 3 files mentioned | +30 |
| Contains "refactor", "migrate", "upgrade" | +15 each |
| Contains "tab", "navigation", "route", "layout" | +15 each |
| "Codebase-wide" or "project-wide" | +25 |
| "Architectural" or "restructure" | +20 |
| Migration pattern (from X to Y) | +20 |

**Threshold**: Score ≥ 25 triggers Claude Code (lowered from 40)

### Plan Approval Commands

When Claude Code generates a plan, reply with:

| Command | Effect |
|---------|--------|
| `approve` | Execute the plan with Claude Code |
| `basic` | Use basic tools instead (skip Claude Code) |
| `modify: [feedback]` | Adjust the plan based on feedback |

### Example: Complex Refactoring

```
Issue: "Migrate all API calls from axios to native fetch"
         ↓
🔧 Implementer: "Complexity score: 65 (>40), using Claude Code"
         ↓
📋 Claude Code Plan:
   "## Files to Modify
    - src/api/client.ts: Replace axios instance
    - src/api/users.ts: Update 12 functions
    - src/api/products.ts: Update 8 functions
    - src/hooks/useApi.ts: Update error handling
    - package.json: Remove axios dependency
    
    ## Estimated Complexity: Medium"
         ↓
❓ "Please review and reply: approve / basic / modify: [changes]"
         ↓
👤 Human: "approve"
         ↓
✅ Claude Code executes plan, modifies 5 files
         ↓
🧪 Tester → 🚀 PR Creator
```

---

## Team Lead vs Pipeline Mode

### Team Lead Mode (Default)
The Team Lead adapts to each ticket:
```
Simple bug fix:    Clarifier → Implementer → Tester → PR (skips scope/design)
Complex feature:   Clarifier → Scope → Designer → Planner → Implementer → Tester → PR
Unclear ticket:    Clarifier → (ask human) → Clarifier → Scope → ...
```

### Pipeline Mode (Legacy)
Fixed sequential phases via labels:
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
│   ├── team-lead.ts         # 🧠 Orchestrating agent with delegation tools
│   ├── with-context.ts      # 🔧 Context-gathering helper (READ-ONLY tools)
│   ├── clarifier.ts         # Asks clarifying questions (w/ codebase context)
│   ├── scope.ts             # Defines acceptance criteria (w/ codebase context)
│   ├── designer.ts          # Technical approach (w/ codebase context)
│   ├── planner.ts           # Implementation tasks (w/ codebase context)
│   ├── implementer.ts       # Writes code (full tools)
│   ├── tester.ts            # Runs tests
│   └── pr-creator.ts        # Opens pull request
│
├── handlers/
│   ├── team-lead.ts         # Handles agent:start for Team Lead
│   ├── agent-start.ts       # Legacy pipeline start
│   ├── human-response.ts    # Processes human comments
│   ├── implement.ts         # Direct implement handler
│   ├── test.ts              # Direct test handler
│   └── create-pr.ts         # Direct PR handler
│
├── services/
│   ├── agent-runner.ts      # Runs any agent, returns structured result
│   ├── session.ts           # Supabase CRUD
│   └── github.ts            # GitHub API
│
├── tools/
│   ├── definitions.ts       # Tool schemas (READ_ONLY_TOOLS + CODE_TOOLS)
│   └── executor.ts          # Executes tools safely
│
└── types/
    └── index.ts             # TypeScript interfaces
```

---

## Setup

### 1. Database

Run in Supabase SQL Editor:

```sql
CREATE TABLE IF NOT EXISTS agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  current_phase TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  conversation JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  team_lead_state JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repo, issue_number)
);
```

### 2. GitHub Secrets

Add to **cherry-automation** repo:

| Secret | Description |
|--------|-------------|
| `GH_PAT` | GitHub PAT with `repo` scope (access to both repos) |
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

## Example Flow

```
Issue: "Add dark mode toggle to settings"
         ↓
🤖 Team Lead: "Analyzing ticket... delegating to Clarifier"
         ↓
🔍 Clarifier: *reads package.json, explores src/*
   "You're using Next.js 14 with Tailwind. Questions:
    1) Should dark mode follow OS preference?
    2) Store in localStorage or cookies?"
         ↓
👤 Human: "OS preference, localStorage is fine"
         ↓
📋 Scope: *searches for theme, reads existing components*
   "## Files to Modify
    - src/app/layout.tsx: Add ThemeProvider
    - src/app/settings/page.tsx: Add toggle
    ## Complexity: M"
         ↓
🏗️ Designer: *reads similar hooks*
   "## Existing Patterns to Follow
    - Hook pattern from src/hooks/useLocalStorage.ts"
         ↓
📝 Planner: *verifies file paths exist*
   "Tasks:
    1. Create src/hooks/useTheme.ts
    2. Update src/app/layout.tsx (line 15)
    3. Add toggle to settings page"
         ↓
🔧 Implementer: [reads → writes → tests in loop]
         ↓
🧪 Tester: "✅ Type check passed"
         ↓
🚀 PR Creator: "PR #123 created"
         ↓
🎉 Team Lead: "Done! PR ready for review"
```

---

## Limits & Safety

| Limit | Value | Why |
|-------|-------|-----|
| Context iterations | 5-6 | Prevent endless exploration |
| Implementer iterations (basic) | 1000 | Complex changes need room |
| Claude Code timeout | 10 min | Large refactors need time |
| Team Lead iterations | 25 | Prevent infinite loops |
| Workflow timeout | 30 min | GitHub Actions limit |
| Complexity threshold | 25 | Score to trigger Claude Code (lowered) |
| File read limit | 100,000 chars | See full files (was 10,000) |
| Protected files | `.env`, `.git`, `node_modules` | Security |
| Command whitelist | `npm test/build/lint`, `claude` | Safety |

---

## Potential Improvements

### 1. Codebase Indexing
**Current**: Agents explore on each run  
**Better**: Pre-index with embeddings, semantic search

```
┌─────────────────────────────────────────┐
│  On repo change → Index files           │
│  On agent run → Query vector DB         │
│  Result → Instant relevant context      │
└─────────────────────────────────────────┘
```

### 2. Chunked Execution for Big Changes
**Current**: Claude Code handles multi-file changes  
**Better**: Break into file-level tasks for more control

```
Planner creates:
  - Task 1: Update src/auth.ts (isolated implementer run)
  - Task 2: Update src/api.ts (isolated implementer run)
  - Task 3: Update src/hooks.ts (isolated implementer run)
```

### 3. Parallel Agent Execution
**Current**: Sequential delegation  
**Better**: Run independent agents in parallel

```
Designer + Scope → Both read codebase simultaneously
```

### 4. Persistent Codebase Memory
**Current**: Each session starts fresh  
**Better**: Remember project patterns, conventions, decisions

### 5. Visual Diff Preview
**Before PR**: Show human a preview of all changes  
**Human can**: Approve, request modifications, or rollback

### 6. Learning from Feedback
**Track**: Which PRs get approved vs rejected  
**Improve**: Tune prompts based on what works

---

## Development

```bash
npm install
npm run type-check
npm run build

# Run locally (requires env vars)
EVENT_TYPE=agent_start \
EVENT_PAYLOAD='{"source_repo":"org/repo","issue_number":1}' \
REPO_PATH="/path/to/source/repo" \
npm start
```

---

## Troubleshooting

**Team Lead keeps looping?**
- Check max iterations (25 by default)
- Review reasoning in GitHub comments
- Human can comment to guide direction

**Agents giving generic advice?**
- Check `REPO_PATH` is set correctly
- Verify repo was checked out in workflow
- Look for tool errors in logs

**Implementer can't find files?**
- Paths are relative to repo root
- Check for typos in file paths
- Use `list_directory` to explore

**PR creation fails?**
- Ensure `GH_PAT` has write access to source repo
- Check if branch already exists
- Verify git user is configured

**Tests fail but you want to proceed?**
- Comment telling Team Lead to skip tests
- Tests are currently non-blocking (configurable)

**Claude Code plan not generating?**
- Check if Claude Code CLI is installed in workflow
- Verify ANTHROPIC_API_KEY is set
- Falls back to basic tools automatically

**Want to skip Claude Code for a task?**
- Reply "basic" when asked to approve the plan
- Or set `use_basic_tools: true` in session metadata

---

## Architecture Decisions

| Decision | Rationale |
|----------|-----------|
| All agents get read access | Context-aware responses beat generic advice |
| Write tools limited | Prevent accidental modifications |
| Team Lead doesn't code | Separation of concerns, focused agents |
| Claude Code for complex tasks | Pre-indexed codebase, better multi-file changes |
| Plan-approve-execute flow | Human oversight for major changes |
| Complexity-based routing | Simple tasks stay fast, complex tasks get power |
| GitHub Actions | Free, no cold starts, built-in secrets |
| Supabase | Structured state, queryable history |
| Anthropic Claude | Best tool use, follows instructions well |
