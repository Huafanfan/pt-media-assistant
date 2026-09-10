import { randomUUID } from 'node:crypto';
import { defaultAssistantPreferences, type AssistantPreferences, type AssistantTurnResponse } from '../../shared/assistant.js';
import type { RecommendationCandidate } from './recommendation.js';

export class AssistantError extends Error {
  constructor(public code: string, public status = 503, public retryAfter?: number) { super(code); }
}
export type Conversation = {
  id: string; owner: string; touched: number; preferences: AssistantPreferences;
  candidates: Map<string, RecommendationCandidate>;
  history: Array<{ user: string; response: AssistantTurnResponse }>;
  /** Seen public-source titles whose provider identity is not resolved yet. */
  seenSourceTitles?: string[];
  topic?: string;
  active?: string;
};
export type Turn = {
  id: string; clientTurnId: string; owner: string; requestKey?: string; conversation: Conversation; controller: AbortController;
  createdAt: number; result?: AssistantTurnResponse; failed?: boolean;
};
export class ConversationStore {
  readonly conversations = new Map<string, Conversation>();
  readonly turns = new Map<string, Turn>();
  private clientIds = new Map<string, string>();
  private starts: Array<{ owner: string; at: number }> = [];
  constructor(readonly now: () => number = Date.now) {}
  private cleanup() {
    const now = this.now();
    for (const [id, turn] of this.turns) if (!turn.conversation.active && now - turn.createdAt >= 30 * 60_000) { this.turns.delete(id); this.clientIds.delete(`${turn.owner}:${turn.clientTurnId}`); }
    for (const [id, c] of this.conversations) if (now - c.touched >= 24 * 60 * 60_000) this.remove(c.owner, id);
    this.starts = this.starts.filter(x => now - x.at < 60 * 60_000);
  }
  start(owner: string, clientTurnId: string, conversationId?: string, requestKey?: string): { turn: Turn; cached: boolean } {
    this.cleanup();
    const existingId = this.clientIds.get(`${owner}:${clientTurnId}`);
    const old = existingId ? this.turns.get(existingId) : undefined;
    if (old) {
      if (old.owner !== owner) throw new AssistantError('TURN_NOT_FOUND', 404);
      if (requestKey !== old.requestKey || (conversationId && conversationId !== old.conversation.id)) throw new AssistantError('TURN_IN_PROGRESS', 409);
      if (old.result) return { turn: old, cached: true };
      throw new AssistantError(old.failed ? 'AI_CANCELLED' : 'TURN_IN_PROGRESS', 409);
    }
    let c = conversationId ? this.conversations.get(conversationId) : undefined;
    if (conversationId && (!c || c.owner !== owner)) throw new AssistantError('CONVERSATION_EXPIRED', 404);
    if (c?.active) throw new AssistantError('TURN_IN_PROGRESS', 409);
    if (this.starts.length >= 60 || this.starts.filter(x => x.owner === owner && this.now() - x.at < 60_000).length >= 3) throw new AssistantError('AI_BUDGET_EXCEEDED', 429, 60);
    if ([...this.conversations.values()].filter(x => x.active).length >= 2) throw new AssistantError('TURN_IN_PROGRESS', 429, 5);
    if (!c) {
      if (this.conversations.size >= 100) {
        const oldest = [...this.conversations.values()].filter(x => !x.active).sort((a,b) => a.touched-b.touched)[0];
        if (!oldest) throw new AssistantError('AI_BUDGET_EXCEEDED', 429);
        this.remove(oldest.owner, oldest.id);
      }
      c = { id: randomUUID(), owner, touched: this.now(), preferences: defaultAssistantPreferences(), candidates: new Map(), history: [] };
      this.conversations.set(c.id, c);
    }
    if (c.history.length >= 20) throw new AssistantError('CONVERSATION_EXPIRED', 409);
    const id = randomUUID();
    c.active = id; c.touched = this.now();
    const turn = { id, clientTurnId, owner, requestKey, conversation: c, controller: new AbortController(), createdAt: this.now() };
    this.turns.set(id, turn); this.clientIds.set(`${owner}:${clientTurnId}`,id); this.starts.push({owner, at: this.now()});
    return { turn, cached: false };
  }
  cancel(owner: string, id: string) {
    const turn = this.turns.get(id) ?? this.turns.get(this.clientIds.get(`${owner}:${id}`) ?? "");
    if (!turn || turn.owner !== owner) throw new AssistantError('TURN_NOT_FOUND', 404);
    turn.controller.abort();
  }
  remove(owner: string, id: string) {
    const c = this.conversations.get(id);
    if (!c || c.owner !== owner) throw new AssistantError('CONVERSATION_EXPIRED', 404);
    if (c.active) this.turns.get(c.active)?.controller.abort();
    this.conversations.delete(id);
    for (const [turnId, turn] of this.turns) if (turn.conversation.id === id) { this.turns.delete(turnId); this.clientIds.delete(`${turn.owner}:${turn.clientTurnId}`); }
  }
  close() { for (const t of this.turns.values()) t.controller.abort(); this.turns.clear(); this.clientIds.clear(); this.conversations.clear(); }
}
