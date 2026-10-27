import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractAssistantSpeechText,
  shouldTriggerAutoSpeech,
} from '../../../src/features/chat/hooks/useAutoSpeech';
import type { ChatMessage } from '../../../src/core/types/messages';

test('Auto-TTS on Agent Settlement: extractAssistantSpeechText', async (t) => {
  await t.test('extracts from plain content string when blocks are absent', () => {
    const msg: ChatMessage = {
      id: 'm1',
      role: 'assistant',
      content: 'Hola, ¿en qué te puedo ayudar?',
      timestamp: '12:00',
    };
    assert.equal(extractAssistantSpeechText(msg), 'Hola, ¿en qué te puedo ayudar?');
  });

  await t.test('extracts only text blocks, ignoring thinking and tool calls', () => {
    const msg: ChatMessage = {
      id: 'm2',
      role: 'assistant',
      content: 'fallback text',
      timestamp: '12:01',
      blocks: [
        { type: 'thinking', thinking: 'Debería revisar los archivos...' },
        { type: 'tool_call', id: 't1', name: 'grep', status: 'completed', output: 'match' },
        { type: 'text', text: 'Encontré la coincidencia.' },
        { type: 'text', text: 'El proceso finalizó con éxito.' },
      ],
    };
    assert.equal(
      extractAssistantSpeechText(msg),
      'Encontré la coincidencia.\n\nEl proceso finalizó con éxito.'
    );
  });

  await t.test('falls back to content if text blocks are empty or missing', () => {
    const msg: ChatMessage = {
      id: 'm3',
      role: 'assistant',
      content: 'Contenido de respaldo',
      timestamp: '12:02',
      blocks: [
        { type: 'thinking', thinking: 'Pensando...' },
      ],
    };
    assert.equal(extractAssistantSpeechText(msg), 'Contenido de respaldo');
  });

  await t.test('returns empty string if neither blocks nor content contain text', () => {
    const msg: ChatMessage = {
      id: 'm4',
      role: 'assistant',
      content: '   ',
      timestamp: '12:03',
      blocks: [],
    };
    assert.equal(extractAssistantSpeechText(msg), '');
  });
});

test('Auto-TTS on Agent Settlement: shouldTriggerAutoSpeech evaluation', async (t) => {
  const validAssistantMsg: ChatMessage = {
    id: 'msg-99',
    role: 'assistant',
    content: 'Tarea completada exitosamente.',
    timestamp: '12:10',
  };

  await t.test('triggers when agent transitions from busy to idle with assistant message', () => {
    const should = shouldTriggerAutoSpeech({
      wasBusy: true,
      currentActivity: 'idle',
      lastMessage: validAssistantMsg,
      lastSpokenId: null,
    });
    assert.equal(should, true);
  });

  await t.test('does NOT trigger on initial view mount when wasBusy is false', () => {
    // If the web was closed while the agent ran and user opens the web later,
    // wasBusy starts as false so old messages are not spoken.
    const should = shouldTriggerAutoSpeech({
      wasBusy: false,
      currentActivity: 'idle',
      lastMessage: validAssistantMsg,
      lastSpokenId: null,
    });
    assert.equal(should, false);
  });

  await t.test('does NOT trigger if agent is still busy', () => {
    const should = shouldTriggerAutoSpeech({
      wasBusy: true,
      currentActivity: 'busy',
      lastMessage: validAssistantMsg,
      lastSpokenId: null,
    });
    assert.equal(should, false);
  });

  await t.test('does NOT trigger if TTS was explicitly disabled (ttsEnabled: false)', () => {
    const should = shouldTriggerAutoSpeech({
      wasBusy: true,
      currentActivity: 'idle',
      ttsEnabled: false,
      lastMessage: validAssistantMsg,
      lastSpokenId: null,
    });
    assert.equal(should, false);
  });

  await t.test('triggers when ttsEnabled is undefined or true', () => {
    const should = shouldTriggerAutoSpeech({
      wasBusy: true,
      currentActivity: 'idle',
      ttsEnabled: undefined,
      lastMessage: validAssistantMsg,
      lastSpokenId: null,
    });
    assert.equal(should, true);
  });

  await t.test('does NOT trigger if last message was cancelled or aborted', () => {
    const cancelledMsg: ChatMessage = {
      ...validAssistantMsg,
      isCancelled: true,
    };
    const should = shouldTriggerAutoSpeech({
      wasBusy: true,
      currentActivity: 'idle',
      lastMessage: cancelledMsg,
      lastSpokenId: null,
    });
    assert.equal(should, false);
  });

  await t.test('does NOT trigger if last message was already spoken', () => {
    const should = shouldTriggerAutoSpeech({
      wasBusy: true,
      currentActivity: 'idle',
      lastMessage: validAssistantMsg,
      lastSpokenId: 'msg-99',
    });
    assert.equal(should, false);
  });

  await t.test('does NOT trigger if last message is from user role', () => {
    const userMsg: ChatMessage = {
      id: 'u1',
      role: 'user',
      content: 'haz algo',
      timestamp: '12:09',
    };
    const should = shouldTriggerAutoSpeech({
      wasBusy: true,
      currentActivity: 'idle',
      lastMessage: userMsg,
      lastSpokenId: null,
    });
    assert.equal(should, false);
  });
});
