import { supabase } from '../supabase/client.js';
import { AgentSession, AgentPhase, SessionStatus, ConversationMessage } from '../types/index.js';

export class SessionService {
  async getSession(repo: string, issueNumber: number): Promise<AgentSession | null> {
    const { data, error } = await supabase
      .from('agent_sessions')
      .select('*')
      .eq('repo', repo)
      .eq('issue_number', issueNumber)
      .single();

    if (error && error.code !== 'PGRST116') {
      throw error;
    }

    return data as AgentSession | null;
  }

  async createSession(
    repo: string,
    issueNumber: number,
    initialMetadata: Record<string, unknown> = {}
  ): Promise<AgentSession> {
    const { data, error } = await supabase
      .from('agent_sessions')
      .insert({
        repo,
        issue_number: issueNumber,
        current_phase: 'clarifying',
        status: 'active',
        conversation: [],
        metadata: initialMetadata,
      })
      .select()
      .single();

    if (error) throw error;
    return data as AgentSession;
  }

  async updatePhase(sessionId: string, phase: AgentPhase): Promise<void> {
    const { error } = await supabase
      .from('agent_sessions')
      .update({ current_phase: phase })
      .eq('id', sessionId);

    if (error) throw error;
  }

  async updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const { error } = await supabase
      .from('agent_sessions')
      .update({ status })
      .eq('id', sessionId);

    if (error) throw error;
  }

  async addMessage(sessionId: string, message: ConversationMessage): Promise<void> {
    const { data: session, error: fetchError } = await supabase
      .from('agent_sessions')
      .select('conversation')
      .eq('id', sessionId)
      .single();

    if (fetchError) throw fetchError;

    const conversation = [...(session.conversation || []), message];

    const { error: updateError } = await supabase
      .from('agent_sessions')
      .update({ conversation })
      .eq('id', sessionId);

    if (updateError) throw updateError;
  }

  async updateMetadata(
    sessionId: string,
    metadata: Record<string, unknown>
  ): Promise<void> {
    const { data: session, error: fetchError } = await supabase
      .from('agent_sessions')
      .select('metadata')
      .eq('id', sessionId)
      .single();

    if (fetchError) throw fetchError;

    const mergedMetadata = { ...(session.metadata || {}), ...metadata };

    const { error: updateError } = await supabase
      .from('agent_sessions')
      .update({ metadata: mergedMetadata })
      .eq('id', sessionId);

    if (updateError) throw updateError;
  }
}

export const sessionService = new SessionService();

