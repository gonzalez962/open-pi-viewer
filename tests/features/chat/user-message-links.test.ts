import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  parseUserMessageLinks,
  UserMessageContent,
} from '@features/chat/components/UserMessageContent';

test('user-message-links: parseUserMessageLinks accurately extracts URLs and preserves surrounding text', () => {
  // Case 1: URL at the beginning of prompt (as in the screenshot)
  const text1 = 'https://github.com/devswha/herdr-web-ui INSTALA ESTE REPO';
  const tokens1 = parseUserMessageLinks(text1);
  assert.equal(tokens1.length, 2);
  assert.deepEqual(tokens1[0], {
    type: 'link',
    value: 'https://github.com/devswha/herdr-web-ui',
  });
  assert.deepEqual(tokens1[1], {
    type: 'text',
    value: ' INSTALA ESTE REPO',
  });

  // Case 2: URL with trailing period in sentence
  const text2 = 'Revisa https://example.com/test. Está funcionando.';
  const tokens2 = parseUserMessageLinks(text2);
  assert.equal(tokens2.length, 3);
  assert.deepEqual(tokens2[0], { type: 'text', value: 'Revisa ' });
  assert.deepEqual(tokens2[1], { type: 'link', value: 'https://example.com/test' });
  assert.deepEqual(tokens2[2], { type: 'text', value: '. Está funcionando.' });

  // Case 3: Text with no URLs
  const text3 = 'Hola, el Gentleman. Continuamos con el desarrollo.';
  const tokens3 = parseUserMessageLinks(text3);
  assert.equal(tokens3.length, 1);
  assert.deepEqual(tokens3[0], { type: 'text', value: text3 });

  // Case 4: Multiple URLs in one prompt
  const text4 = 'Compara http://localhost:5174 con http://192.168.18.110:7317 por favor';
  const tokens4 = parseUserMessageLinks(text4);
  assert.equal(tokens4.length, 5);
  assert.equal(tokens4[1].type, 'link');
  assert.equal(tokens4[1].value, 'http://localhost:5174');
  assert.equal(tokens4[3].type, 'link');
  assert.equal(tokens4[3].value, 'http://192.168.18.110:7317');
});

test('user-message-links: UserMessageContent renders accessible clickable anchors for URLs', () => {
  const content = 'https://github.com/devswha/herdr-web-ui INSTALA ESTE REPO';
  const html = renderToStaticMarkup(
    React.createElement(UserMessageContent, { content })
  );

  assert.ok(html.includes('class="message-literal"'));
  assert.ok(html.includes('<a '));
  assert.ok(html.includes('class="user-message-link"'));
  assert.ok(html.includes('href="https://github.com/devswha/herdr-web-ui"'));
  assert.ok(html.includes('target="_blank"'));
  assert.ok(html.includes('rel="noopener noreferrer"'));
  assert.ok(html.includes('INSTALA ESTE REPO'));
});
