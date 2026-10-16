import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentOutcomeTracker, classifyAgentOutcome } from '@core/agent-outcome';

const message = (text: string, stopReason = 'stop') => ({ role: 'assistant', content: [{ type: 'text', text }], stopReason });

for (const text of [
  'Necesito que confirmes el despliegue para continuar.',
  '¿Quieres que aplique los cambios?',
  'Por favor, inicia sesión y avísame cuando esté listo.',
  'Please approve the changes before I continue.',
  'Waiting for your confirmation.',
  'Can you provide the API key?',
]) {
  test(`action required: ${text}`, () => assert.equal(classifyAgentOutcome(message(text)), 'waiting_input'));
}
for (const text of [
  'No pude completar la tarea: el servidor no responde.',
  'Las pruebas fallaron. No se pudo verificar el cambio.',
  'I could not complete the task because access was denied.',
  'Build failed: missing dependency.',
]) {
  test(`failure: ${text}`, () => assert.equal(classifyAgentOutcome(message(text)), 'error'));
}
for (const text of [
  'Tarea completada. Todas las pruebas pasan.',
  'Fixed the error. Tests passed.',
  'Se corrigió el error de permisos.',
  'Puedes revisar los cambios si quieres.',
  '```text\nPlease approve the changes\n```\nDone.',
  '> Waiting for your confirmation.\nResolved and completed.',
]) {
  test(`completed: ${text}`, () => assert.equal(classifyAgentOutcome(message(text)), 'task_complete'));
}
test('protocol failures override prose; cancellation is silent; incomplete generations are not success', () => {
  assert.equal(classifyAgentOutcome(message('Done', 'error')), 'error');
  assert.equal(classifyAgentOutcome(message('Done', 'aborted')), null);
  assert.equal(classifyAgentOutcome(message('Done', 'length')), 'error');
  assert.equal(classifyAgentOutcome(message('', 'toolUse')), 'error');
  assert.equal(classifyAgentOutcome({ ...message('Done'), errorMessage: 'Rate limited' }), 'error');
});
test('tracker isolates turns and sessions and prefers final recovered assistant response', () => {
  const tracker = new AgentOutcomeTracker();
  tracker.observe({ type: 'message_end', cwd: '/a', sessionId: '1', message: message('Oops', 'error') });
  tracker.observe({ type: 'message_end', cwd: '/a', sessionId: '1', message: message('Fixed and completed') });
  tracker.observe({ type: 'message_end', cwd: '/a', sessionId: '2', message: message('Waiting for your confirmation') });
  assert.equal(tracker.observe({ type: 'agent_end', cwd: '/a', sessionId: '1', willRetry: true }), undefined);
  assert.equal(tracker.observe({ type: 'agent_settled', cwd: '/a', sessionId: '1' }), 'task_complete');
  assert.equal(tracker.observe({ type: 'agent_settled', cwd: '/a', sessionId: '2' }), 'waiting_input');
  tracker.observe({ type: 'agent_start', cwd: '/a', sessionId: '2' });
  assert.equal(tracker.observe({ type: 'agent_settled', cwd: '/a', sessionId: '2' }), 'task_complete');
});
