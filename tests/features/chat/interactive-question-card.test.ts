import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  InteractiveQuestionCard,
  parseInteractiveQuestion,
} from '@features/chat/components/InteractiveQuestionCard';
import type { ToolCallBlock } from '@core/types/messages';
import enJson from '@shared/locales/en.json';
import esJson from '@shared/locales/es.json';

const tEn = (key: any, params?: any) => {
  let str = (enJson as any)[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(`{${k}}`, String(v));
    }
  }
  return str;
};

const tEs = (key: any, params?: any) => {
  let str = (esJson as any)[key] || key;
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      str = str.replace(`{${k}}`, String(v));
    }
  }
  return str;
};

test('interactive-question-card: parseInteractiveQuestion normalizes ask_user_question with questions array', () => {
  const block: ToolCallBlock = {
    type: 'tool_call',
    id: 't-1',
    name: 'ask_user_question',
    status: 'running',
    args: {
      questions: [
        {
          header: 'Instalación',
          question: '¿Cómo desea proceder con la instalación?',
          options: [
            {
              label: 'Completa con herdr',
              description: 'Instala herdr y Bun en el sistema',
              preview: 'curl -fsSL https://herdr.dev/install.sh | sh',
            },
            {
              label: 'Clonar código fuente',
              description: 'Solo clona en Desarrollos',
            },
          ],
        },
      ],
    },
  };

  const parsed = parseInteractiveQuestion(block);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].header, 'Instalación');
  assert.equal(parsed[0].question, '¿Cómo desea proceder con la instalación?');
  assert.equal(parsed[0].options.length, 2);
  assert.equal(parsed[0].options[0].label, 'Completa con herdr');
  assert.equal(parsed[0].options[0].preview, 'curl -fsSL https://herdr.dev/install.sh | sh');
  assert.equal(parsed[0].options[1].label, 'Clonar código fuente');
});

test('interactive-question-card: parseInteractiveQuestion handles ask_user_choice and stringified JSON', () => {
  const block: ToolCallBlock = {
    type: 'tool_call',
    id: 't-2',
    name: 'ask_user_choice',
    status: 'completed',
    args: JSON.stringify({
      header: 'Entorno',
      question: '¿Qué ambiente deseas desplegar?',
      options: [
        { label: 'Staging', value: 'stg' },
        { label: 'Producción', value: 'prod' },
      ],
    }),
    output: 'Staging',
  };

  const parsed = parseInteractiveQuestion(block);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].header, 'Entorno');
  assert.equal(parsed[0].question, '¿Qué ambiente deseas desplegar?');
  assert.equal(parsed[0].options.length, 2);
  assert.equal(parsed[0].options[0].label, 'Staging');
  assert.equal(parsed[0].options[0].value, 'stg');
});

test('interactive-question-card: parseInteractiveQuestion handles ask_user_confirmation', () => {
  const block: ToolCallBlock = {
    type: 'tool_call',
    id: 't-3',
    name: 'ask_user_confirmation',
    status: 'running',
    args: {
      title: 'Eliminar Base de Datos',
      message: '¿Está seguro de eliminar la base de datos local?',
    },
  };

  const parsed = parseInteractiveQuestion(block);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].header, 'Eliminar Base de Datos');
  assert.equal(parsed[0].question, '¿Está seguro de eliminar la base de datos local?');
  assert.equal(parsed[0].options.length, 2);
  assert.equal(parsed[0].options[0].label, 'Confirmar');
  assert.equal(parsed[0].options[1].label, 'Cancelar');
});

test('interactive-question-card: renders interactive question card with options, header, and waiting badge', () => {
  const block: ToolCallBlock = {
    type: 'tool_call',
    id: 't-4',
    name: 'ask_user_question',
    status: 'running',
    args: {
      questions: [
        {
          header: 'Instalación',
          question: '¿Cómo desea proceder con la instalación?',
          options: [
            {
              label: 'Completa con herdr (Recommended)',
              description: 'Instala herdr y Bun en el sistema',
              preview: 'curl -fsSL https://herdr.dev/install.sh | sh',
            },
            {
              label: 'Clonar código fuente',
              description: 'Solo clona en Desarrollos',
            },
          ],
        },
      ],
    },
  };

  const html = renderToStaticMarkup(
    React.createElement(InteractiveQuestionCard, {
      block,
      t: tEs,
    })
  );

  // Checks header, chips, question text and option cards
  assert.ok(html.includes('interactive-question-card is-waiting'));
  assert.ok(html.includes('Instalación'));
  assert.ok(html.includes('Pregunta del Asistente'));
  assert.ok(html.includes('Decisión Requerida'));
  assert.ok(html.includes('¿Cómo desea proceder con la instalación?'));
  assert.ok(html.includes('Completa con herdr (Recommended)'));
  assert.ok(html.includes('Clonar código fuente'));
  assert.ok(html.includes('curl -fsSL https://herdr.dev/install.sh | sh'));
  assert.ok(html.includes('Haz clic en una opción'));
});

test('interactive-question-card: renders completed state with selected option highlighted', () => {
  const block: ToolCallBlock = {
    type: 'tool_call',
    id: 't-5',
    name: 'ask_user_question',
    status: 'completed',
    args: {
      questions: [
        {
          question: '¿Prefieres café o té?',
          options: [{ label: 'Café' }, { label: 'Té' }],
        },
      ],
    },
    output: 'Café',
  };

  const html = renderToStaticMarkup(
    React.createElement(InteractiveQuestionCard, {
      block,
      t: tEn,
    })
  );

  assert.ok(html.includes('interactive-question-card is-resolved'));
  assert.ok(html.includes('Answered'));
  assert.ok(html.includes('is-selected'));
  assert.ok(html.includes('Selected'));
});
