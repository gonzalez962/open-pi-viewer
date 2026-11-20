import { normalizeWorkingDirectory } from '@core/session';
import type { AuthoritativeMessage, RpcEventBase } from '@core/types/events';
import type { ChatMessage } from '@core/types/messages';
import { extractTextFromContent } from '@core/protocol';

const STORAGE_KEY = 'pi_viewer_turn_durations_v1';
const MAX_SAVED = 128;

function readDurations(): Map<string, number> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const entries: unknown = raw && raw.length < 262_144 ? JSON.parse(raw) : [];
    if (Array.isArray(entries)) return new Map(entries.slice(-MAX_SAVED).filter((entry): entry is [string, number] =>
      Array.isArray(entry) && typeof entry[0] === 'string' && entry[0].length <= 2048
      && Number.isSafeInteger(entry[1]) && entry[1] >= 0));
  } catch { /* Storage may be disabled, full, or corrupt. */ }
  return new Map();
}

// Pi timestamps identify candidates, but are not unique on their own. Keep a
// fingerprint of the visible response instead of storing its text in the browser.
function responseFingerprint(text: string): string {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 0x100000001b3n);
  }
  return hash.toString(16);
}

function matchDurations(owner: string, messages: ChatMessage[], timestamps: Set<number>) {
  const matches = new Map<string, ChatMessage | null>();
  for (const message of messages) {
    const ts = message.responseTimestamp;
    if (message.role !== 'assistant' || ts === undefined || !timestamps.has(ts) || !message.content.trim()) continue;
    const key = JSON.stringify([owner, ts, responseFingerprint(message.content)]);
    if (key.length <= 2048) matches.set(key, matches.has(key) ? null : message);
  }
  return matches;
}

export function saveTurnDurations(owner: string | undefined, messages: ChatMessage[]): void {
  if (!owner) return;
  const measured = messages.filter(m => m.turnDurationOwner === owner && m.turnDurationMs !== undefined && m.responseTimestamp !== undefined);
  if (!measured.length) return;
  const durations = readDurations();
  let changed = false;
  for (const [key, message] of matchDurations(owner, messages, new Set(measured.map(m => m.responseTimestamp!)))) {
    const elapsed = message?.turnDurationMs;
    if (elapsed === undefined || message?.turnDurationOwner !== owner || message.isCancelled || message.isStreaming || durations.get(key) === elapsed) continue;
    durations.delete(key);
    durations.set(key, elapsed);
    changed = true;
  }
  try {
    if (changed) localStorage.setItem(STORAGE_KEY, JSON.stringify([...durations].slice(-MAX_SAVED)));
  } catch { /* Live durations still work without storage. */ }
}

export function restoreTurnDurations(owner: string | undefined, messages: ChatMessage[]): ChatMessage[] {
  if (messages.some(m => m.turnDurationOwner !== undefined && m.turnDurationOwner !== owner)) {
    messages = messages.map(m => m.turnDurationOwner !== undefined && m.turnDurationOwner !== owner
      ? { ...m, turnDurationOwner: undefined, turnDurationMs: undefined } : m);
  }
  if (!owner) return messages;
  const durations = readDurations();
  const timestamps = new Set<number>();
  for (const key of durations.keys()) {
    try {
      const value: unknown = JSON.parse(key);
      if (Array.isArray(value) && value[0] === owner && typeof value[1] === 'number') timestamps.add(value[1]);
    } catch { /* Skip invalid entries. */ }
  }
  if (!timestamps.size) return messages;
  const restored = new Map<ChatMessage, number>();
  for (const [key, message] of matchDurations(owner, messages, timestamps)) {
    const elapsed = durations.get(key);
    if (message && elapsed !== undefined && message.turnDurationMs === undefined && !message.isCancelled && !message.isStreaming) restored.set(message, elapsed);
  }
  return restored.size ? messages.map(m => restored.has(m) ? { ...m, turnDurationMs: restored.get(m) } : m) : messages;
}

interface ObservedTurn {
  startedAt: number;
  userMessages: number;
  ambiguous: boolean;
  response?: { timestamp: number; text: string };
}

export function turnOwner(cwd?: unknown, sessionId?: unknown, sessionFile?: unknown): string | undefined {
  if (typeof cwd !== 'string' || !cwd.trim() || typeof sessionId !== 'string' || !sessionId.trim()
    || typeof sessionFile !== 'string' || !sessionFile.trim()) return;
  return JSON.stringify([normalizeWorkingDirectory(cwd), sessionId, sessionFile]);
}

/** Timing is local to the viewer. A synthetic bridge settlement lacks Pi's aborted field. */
export class TurnDurationTracker {
  private readonly turns = new Map<string, ObservedTurn>();

  reset(owner?: string) {
    if (owner) this.turns.delete(owner);
    else this.turns.clear();
  }

  observe(event: RpcEventBase, owner: string) {
    const turn = this.turns.get(owner);
    if (event.type === 'agent_start') {
      this.turns.set(owner, { startedAt: performance.now(), userMessages: 0, ambiguous: Boolean(turn) });
      if (this.turns.size > 64) {
        const oldest = this.turns.keys().next();
        if (!oldest.done) this.turns.delete(oldest.value);
      }
      return;
    }
    if (!turn) return;
    if (event.type === 'queue_update' && [event.steering, event.followUp].some(queue => Array.isArray(queue) && queue.length > 0)) {
      turn.ambiguous = true;
    } else if (event.type === 'message_start' || event.type === 'message_end') {
      const msg = event.message as AuthoritativeMessage | undefined;
      if (event.type === 'message_start' && msg?.role === 'user') turn.userMessages++;
      if (event.type === 'message_end' && msg?.role === 'assistant') {
        const text = extractTextFromContent(msg.content);
        turn.response = msg.stopReason === 'stop' && !msg.errorMessage && text.trim()
          && typeof msg.timestamp === 'number' && Number.isFinite(msg.timestamp)
          ? { timestamp: msg.timestamp, text } : undefined;
      }
    } else if (event.type === 'agent_settled' && typeof event.aborted === 'boolean') {
      this.turns.delete(owner);
      const elapsedMs = Math.round(performance.now() - turn.startedAt);
      if (!event.aborted && !turn.ambiguous && turn.userMessages === 1 && turn.response
        && Number.isSafeInteger(elapsedMs) && elapsedMs >= 0) return { ...turn.response, elapsedMs };
    }
  }
}
