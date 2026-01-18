-- Agent Sessions Table
CREATE TABLE IF NOT EXISTS agent_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo TEXT NOT NULL,
  issue_number INTEGER NOT NULL,
  current_phase TEXT NOT NULL CHECK (current_phase IN ('clarifying', 'scoping', 'designing', 'planning', 'completed')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'completed', 'cancelled')),
  conversation JSONB NOT NULL DEFAULT '[]'::jsonb,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(repo, issue_number)
);

-- Index for faster lookups
CREATE INDEX IF NOT EXISTS idx_agent_sessions_repo_issue ON agent_sessions(repo, issue_number);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status ON agent_sessions(status);

-- Auto-update timestamp
CREATE OR REPLACE FUNCTION update_agent_sessions_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_sessions_updated_at
  BEFORE UPDATE ON agent_sessions
  FOR EACH ROW
  EXECUTE FUNCTION update_agent_sessions_updated_at();