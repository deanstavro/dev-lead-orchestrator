export interface EventPayload {
    action: string;
    source_repo: string;
    issue_number?: number;
    issue_title?: string;
    issue_body?: string;
    sender?: string;
    comment_id?: number;
    comment_body?: string;
    comment_author?: string;
    pr_number?: number;
    pr_title?: string;
    pr_body?: string;
    diff?: string;
    test_result?: string;
  }
  
  export type AgentPhase = 'clarifying' | 'scoping' | 'designing' | 'planning' | 'completed';
  export type SessionStatus = 'active' | 'paused' | 'completed' | 'cancelled';
  
  export interface AgentSession {
    id: string;
    repo: string;
    issue_number: number;
    current_phase: AgentPhase;
    status: SessionStatus;
    conversation: ConversationMessage[];
    metadata: Record<string, unknown>;
    created_at: string;
    updated_at: string;
  }
  
  export interface ConversationMessage {
    role: 'user' | 'assistant';
    content: string;
    timestamp: string;
    metadata?: Record<string, unknown>;
  }
  
  export interface AgentContext {
    session: AgentSession;
    payload: EventPayload;
    githubToken: string;
  }