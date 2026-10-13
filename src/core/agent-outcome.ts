import type { NotificationEventType } from './notifications';

export type AgentOutcome = NotificationEventType | null;

const waitingPatterns = [
  /\b(?:necesito|necesitamos|requiere|requiero) (?:que|tu|una? (?:confirmaci[oó]n|aprobaci[oó]n|respuesta|acci[oó]n))/i,
  /\b(?:esperando|pendiente de) (?:tu|una? (?:confirmaci[oó]n|aprobaci[oó]n|respuesta))/i,
  /\b(?:por favor|para continuar)[,:]? (?:inicia|confirma|aprueba|proporciona|indica|ejecuta|abre|selecciona|responde)/i,
  /(?:¿|\b)(?:quieres que|confirmas|puedes (?:confirmar|proporcionar|enviar|indicar|ejecutar))[^\n]*\?/i,
  /\b(?:please|you (?:must|need to)) (?:approve|confirm|provide|sign in|log in|run|select|answer)/i,
  /\b(?:waiting for|need|require) your (?:input|approval|confirmation|response|permission)/i,
  /\b(?:can|could|would) you (?:approve|confirm|provide|send|run|choose)[^\n]*\?/i,
  /\b(?:shall I|would you like me to|do you want me to)[^\n]*\?/i,
  /\b(?:av[ií]same|dime|ind[ií]came) (?:cuando|si|qu[eé]|c[oó]mo)/i,
  /(?:¿|\b)(?:qu[eé] opci[oó]n|c[oó]mo (?:quieres|deseas)|cu[aá]l (?:prefieres|eliges))[^\n]*\?/i,
  /\b(?:let me know|tell me) (?:when|which|whether|how)/i,
  /\b(?:blocked|bloqueado|bloqueada) (?:until|waiting for|hasta que|esperando)/i,
];
const errorPatterns = [
  /\b(?:no (?:pude|podemos|se pudo|fue posible)|imposible) (?:completar|continuar|ejecutar|verificar|acceder|conectar)/i,
  /\b(?:pruebas|tests|compilaci[oó]n|build|despliegue) (?:han |have )?(?:fallaron|fall[oó]|failed|fails)/i,
  /\b(?:could not|couldn't|cannot|can't|unable to) (?:complete|continue|run|verify|access|connect)/i,
  /\b(?:error|fallo|failure) (?:al|en|while|during) (?:ejecutar|conectar|guardar|compilar|running|connecting|saving|building)/i,
];

/** Conservative ES/EN fallback; inspect visible prose, never thinking/tool arguments. */
export function classifyAgentOutcome(value: unknown): AgentOutcome {
  if (!value || typeof value !== 'object') return 'task_complete';
  const message = value as Record<string, unknown>;
  if (message.stopReason === 'aborted') return null;
  if (message.errorMessage || ['error', 'length', 'toolUse'].includes(String(message.stopReason))) return 'error';
  if (['pending', 'deferred'].includes(String(message.stopReason))) return 'waiting_input';
  const content = message.content;
  const text = (typeof content === 'string' ? content : Array.isArray(content)
    ? content.filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n') : '')
    .replace(/```[\s\S]*?(?:```|$)/g, '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/`[^`]*`/g, '')
    .replace(/\*\*|__/g, '');
  // Actionable blockers are more useful than a generic error alert.
  if (waitingPatterns.some(pattern => pattern.test(text))) return 'waiting_input';
  if (errorPatterns.some(pattern => pattern.test(text))) return 'error';
  return 'task_complete';
}

/** Per-turn state, keyed by origin + native session identity, shared by both transports. */
export class AgentOutcomeTracker {
  private readonly turns = new Map<string, unknown>();

  observe(event: { type: string; [key: string]: unknown }): AgentOutcome | undefined {
    const key = JSON.stringify([event.cwd ?? '', event.sessionId ?? event.sessionFile ?? '']);
    if (event.type === 'agent_start') this.turns.delete(key);
    if (event.type === 'message_end' && (event.message as { role?: string })?.role === 'assistant') {
      // Bound abandoned turns (disconnects, session switches) without a lifecycle event.
      if (this.turns.size >= 256 && !this.turns.has(key)) this.turns.delete(this.turns.keys().next().value!);
      this.turns.set(key, event.message);
    }
    if (event.type === 'agent_end' || event.type === 'agent_settled') {
      if (Array.isArray(event.messages)) {
        const last = [...event.messages].reverse().find(message => message?.role === 'assistant');
        if (last) this.turns.set(key, last);
      }
    }
    if (event.type !== 'agent_settled') return undefined;
    const outcome = classifyAgentOutcome(this.turns.get(key));
    this.turns.delete(key);
    return outcome;
  }
}
