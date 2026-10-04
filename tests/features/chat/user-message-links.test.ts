import assert from 'node:assert/strict';
import test from 'node:test';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import {
  parseUserMessageTokens,
  hasValidLeadingBoundary,
  type UserMessageToken,
} from '@features/chat/user-message-links';
import {
  UserMessageContent,
  UserMessageLink,
} from '@features/chat/components/UserMessageContent';
import { LinkOpenerController } from '@infra/opener';

test('parseUserMessageTokens: empty string returns empty token array', () => {
  const tokens = parseUserMessageTokens('');
  assert.equal(tokens.length, 0);
  assert.equal(tokens.map((t) => t.value).join(''), '');
});

test('parseUserMessageTokens: plain text without URLs returns single text token preserving whitespace', () => {
  const input = 'Hello world!\nThis is a plain message with spaces  and\ttabs.';
  const tokens = parseUserMessageTokens(input);
  assert.equal(tokens.length, 1);
  assert.equal(tokens[0].type, 'text');
  assert.equal(tokens[0].value, input);
  assert.equal(tokens.map((t) => t.value).join(''), input);
});

test('parseUserMessageTokens: parses standalone HTTP and HTTPS URLs', () => {
  const httpsInput = 'https://example.com/docs';
  const httpsTokens = parseUserMessageTokens(httpsInput);
  assert.equal(httpsTokens.length, 1);
  assert.deepEqual(httpsTokens[0], {
    type: 'link',
    value: 'https://example.com/docs',
    href: 'https://example.com/docs',
  });

  const httpInput = 'http://insecure.example.org/path?query=val#hash';
  const httpTokens = parseUserMessageTokens(httpInput);
  assert.equal(httpTokens.length, 1);
  assert.deepEqual(httpTokens[0], {
    type: 'link',
    value: httpInput,
    href: httpInput,
  });
});

test('parseUserMessageTokens: invariant tokenconcat == original across diverse inputs', () => {
  const cases = [
    '',
    'simple text',
    'https://example.com',
    'Visit https://a.com and https://b.org today!',
    'Nested (https://example.com) and [https://test.com/path].',
    'Quotes "https://quoted.com" and \'https://single.com\'.',
    'Multi\nline\t\n  with https://example.com/1 and\nhttps://example.com/2  end.',
    'Punctuation: https://p.com. https://comma.com, https://semi.com; https://excl.com! https://quest.com?',
    'Wikipedia: https://en.wikipedia.org/wiki/React_(software) is great.',
    '(https://en.wikipedia.org/wiki/React_(software)) inside parens.',
    'Bad schemes: javascript:alert(1), mailto:test@example.com, ftp://files.org.',
    'Credentials: http://user:pass@bad.com/path should not be link.',
    'Incomplete: https:// http:// https://.com not a link.',
  ];

  for (const text of cases) {
    const tokens = parseUserMessageTokens(text);
    const concat = tokens.map((t) => t.value).join('');
    assert.equal(
      concat,
      text,
      `Token concatenation failed to match original for input: ${JSON.stringify(text)}`
    );
  }
});

test('parseUserMessageTokens: strips trailing sentence punctuation from URL candidate', () => {
  const punctuations = ['.', ',', ';', ':', '!', '?'];
  for (const p of punctuations) {
    const input = `Visit https://example.com${p}`;
    const tokens = parseUserMessageTokens(input);
    assert.equal(tokens.length, 3, `Expected 3 tokens for input: ${input}`);
    assert.deepEqual(tokens[0], {
      type: 'text',
      value: 'Visit ',
    });
    assert.deepEqual(tokens[1], {
      type: 'link',
      value: 'https://example.com',
      href: 'https://example.com',
    });
    assert.deepEqual(tokens[2], {
      type: 'text',
      value: p,
    });
    assert.equal(tokens.map((t) => t.value).join(''), input);

    // Also test without leading text
    const bareInput = `https://example.com${p}`;
    const bareTokens = parseUserMessageTokens(bareInput);
    assert.equal(bareTokens.length, 2, `Expected 2 tokens for bare input: ${bareInput}`);
    assert.deepEqual(bareTokens[0], {
      type: 'link',
      value: 'https://example.com',
      href: 'https://example.com',
    });
    assert.deepEqual(bareTokens[1], {
      type: 'text',
      value: p,
    });
    assert.equal(bareTokens.map((t) => t.value).join(''), bareInput);
  }

  // Multiple trailing punctuation characters
  const multiPunct = 'Check https://example.com...';
  const multiTokens = parseUserMessageTokens(multiPunct);
  assert.equal(multiTokens.length, 3);
  assert.equal(multiTokens[0].value, 'Check ');
  assert.equal(multiTokens[1].value, 'https://example.com');
  assert.equal(multiTokens[2].value, '...');
});

test('parseUserMessageTokens: strips unmatched closing delimiters and balances parentheses', () => {
  // Unmatched closing paren
  const parenInput = '(https://example.com)';
  const parenTokens = parseUserMessageTokens(parenInput);
  assert.equal(parenTokens.length, 3);
  assert.deepEqual(parenTokens[0], { type: 'text', value: '(' });
  assert.deepEqual(parenTokens[1], {
    type: 'link',
    value: 'https://example.com',
    href: 'https://example.com',
  });
  assert.deepEqual(parenTokens[2], { type: 'text', value: ')' });

  // Unmatched brackets, braces, and quotes
  const bracketInput = '[https://example.com]';
  const bracketTokens = parseUserMessageTokens(bracketInput);
  assert.equal(bracketTokens.length, 3);
  assert.equal(bracketTokens[1].value, 'https://example.com');
  assert.equal(bracketTokens[2].value, ']');

  const quoteInput = '"https://example.com"';
  const quoteTokens = parseUserMessageTokens(quoteInput);
  assert.equal(quoteTokens.length, 3);
  assert.equal(quoteTokens[1].value, 'https://example.com');
  assert.equal(quoteTokens[2].value, '"');

  // Balanced parentheses inside URL path are preserved
  const wikiInput = 'https://en.wikipedia.org/wiki/React_(software)';
  const wikiTokens = parseUserMessageTokens(wikiInput);
  assert.equal(wikiTokens.length, 1);
  assert.deepEqual(wikiTokens[0], {
    type: 'link',
    value: wikiInput,
    href: wikiInput,
  });

  // Balanced parentheses inside outer enclosing parentheses
  const outerWikiInput = '(https://en.wikipedia.org/wiki/React_(software))';
  const outerWikiTokens = parseUserMessageTokens(outerWikiInput);
  assert.equal(outerWikiTokens.length, 3);
  assert.equal(outerWikiTokens[0].value, '(');
  assert.equal(outerWikiTokens[1].value, 'https://en.wikipedia.org/wiki/React_(software)');
  assert.equal(outerWikiTokens[2].value, ')');

  // Balanced parentheses with trailing punctuation and outer parenthesis
  const complexInput = '(see https://en.wikipedia.org/wiki/React_(software)).';
  const complexTokens = parseUserMessageTokens(complexInput);
  assert.equal(complexTokens.length, 3);
  assert.equal(complexTokens[0].value, '(see ');
  assert.equal(complexTokens[1].value, 'https://en.wikipedia.org/wiki/React_(software)');
  assert.equal(complexTokens[2].value, ').');
});

test('parseUserMessageTokens: safety validation rejects credentials and unsafe protocols', () => {
  // Credentials in URL must not be linked
  const creds = [
    'http://user:pass@example.com',
    'https://user@example.com',
    'https://:pass@example.com/path',
    'http://admin:secret@sub.domain.org',
  ];
  for (const c of creds) {
    const tokens = parseUserMessageTokens(c);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].type, 'text');
    assert.equal(tokens[0].value, c);
  }

  // Dangerous or non-http protocols must not be linked
  const unsafe = [
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/System32',
    'tauri://localhost',
    'vbscript:msgbox(1)',
    'mailto:user@example.com',
  ];
  for (const u of unsafe) {
    const tokens = parseUserMessageTokens(u);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].type, 'text');
    assert.equal(tokens[0].value, u);
  }

  // Embedded scheme payload URLs must be rejected and remain literal text
  const embedded = [
    'javascript:https://evil.com',
    'data:https://evil.com',
    'data:text/html;base64,https://evil.com',
    'vbscript:https://evil.com',
    'blob:https://evil.com',
    'about:https://evil.com',
    'javascript:(https://evil.com)',
  ];
  for (const e of embedded) {
    const tokens = parseUserMessageTokens(e);
    assert.equal(
      tokens.length,
      1,
      `Expected embedded scheme ${e} to remain single literal text token, got ${JSON.stringify(tokens)}`
    );
    assert.equal(tokens[0].type, 'text');
    assert.equal(tokens[0].value, e);
  }

  // Malformed or incomplete URLs remain literal text
  const malformed = [
    'http://',
    'https://',
    'https:// ',
    'https:///',
    'not a url',
  ];
  for (const m of malformed) {
    const tokens = parseUserMessageTokens(m);
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].type, 'text');
    assert.equal(tokens[0].value, m);
  }
});

test('parseUserMessageTokens: handles multiple URLs separated by text and newlines', () => {
  const input = 'First: https://first.com\nSecond: https://second.org/path?q=1\nThird: https://third.net#hash';
  const tokens = parseUserMessageTokens(input);
  const links = tokens.filter((t): t is UserMessageToken & { type: 'link' } => t.type === 'link');
  assert.equal(links.length, 3);
  assert.equal(links[0].href, 'https://first.com');
  assert.equal(links[1].href, 'https://second.org/path?q=1');
  assert.equal(links[2].href, 'https://third.net#hash');
  assert.equal(tokens.map((t) => t.value).join(''), input);
});

test('UserMessageContent: static render escapes raw HTML and preserves literal content', () => {
  const maliciousInput = '<script>alert("xss")</script><img src=x onerror=alert(1)>';
  const markup = renderToStaticMarkup(
    React.createElement(UserMessageContent, { content: maliciousInput })
  );

  // Must escape HTML tags
  assert.ok(!markup.includes('<script>'));
  assert.ok(!markup.includes('<img'));
  assert.ok(markup.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;'));
  assert.ok(markup.includes('&lt;img src=x onerror=alert(1)&gt;'));
  assert.ok(markup.includes('message-literal'));
});

test('UserMessageContent: renders accessible anchor tags for valid links', () => {
  const content = 'Please visit https://example.com/docs for guidance.';
  const markup = renderToStaticMarkup(
    React.createElement(UserMessageContent, { content })
  );

  assert.ok(markup.includes('message-literal'));
  assert.ok(markup.includes('<a '));
  assert.ok(markup.includes('href="https://example.com/docs"'));
  assert.ok(markup.includes('target="_blank"'));
  assert.ok(markup.includes('rel="noopener noreferrer"'));
  assert.ok(markup.includes('class="user-message-link"'));
  assert.ok(markup.includes('https://example.com/docs</a>'));
  assert.ok(markup.includes('Please visit '));
  assert.ok(markup.includes(' for guidance.'));
});

test('UserMessageContent: preserves literal whitespace and linebreaks', () => {
  const multiline = '  Line 1 with spaces  \n\n  Line 2 with https://example.com  \n\tTabbed line 3';
  const markup = renderToStaticMarkup(
    React.createElement(UserMessageContent, { content: multiline })
  );

  assert.ok(markup.includes('  Line 1 with spaces  \n\n  Line 2 with '));
  assert.ok(markup.includes('https://example.com</a>'));
  assert.ok(markup.includes('  \n\tTabbed line 3'));
});

test('UserMessageLink: renders accessible anchor with target, rel, class and title', () => {
  const markup = renderToStaticMarkup(
    React.createElement(UserMessageLink, { href: 'https://example.com' }, 'example link')
  );

  assert.ok(markup.includes('<a '));
  assert.ok(markup.includes('href="https://example.com"'));
  assert.ok(markup.includes('target="_blank"'));
  assert.ok(markup.includes('rel="noopener noreferrer"'));
  assert.ok(markup.includes('class="user-message-link"'));
  assert.ok(markup.includes('title="https://example.com"'));
  assert.ok(markup.includes('example link</a>'));
});

test('LinkOpenerController: handles structured unsuccessful opener result (success: false) gracefully', async () => {
  let reportedStatus = '';
  let reportedError: string | null = null;

  const failureOpener = async () => ({
    success: false,
    error: 'Disallowed or unsafe URL scheme: only http, https, and mailto are permitted',
  });

  const controller = new LinkOpenerController(
    {
      onStateChange: (status, err) => {
        reportedStatus = status;
        reportedError = err ?? null;
      },
    },
    {
      openFn: failureOpener,
    }
  );

  const result = await controller.activate('https://example.com');
  assert.equal(result.success, false);
  assert.equal(result.error, 'Disallowed or unsafe URL scheme: only http, https, and mailto are permitted');
  assert.equal(reportedStatus, 'failed');
  assert.equal(reportedError, 'Disallowed or unsafe URL scheme: only http, https, and mailto are permitted');
  assert.equal(controller.getState(), 'failed');
  assert.equal(controller.getError(), 'Disallowed or unsafe URL scheme: only http, https, and mailto are permitted');

  controller.dispose();
});

test('LinkOpenerController: debounces rapid activations and prevents concurrent in-flight activations', async () => {
  let openCount = 0;
  const delayedOpener = async () => {
    openCount++;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return { success: true };
  };

  const controller = new LinkOpenerController(
    { onStateChange: () => {} },
    { debounceMs: 100, openFn: delayedOpener }
  );

  // First activation begins opening
  const p1 = controller.activate('https://example.com');
  assert.equal(controller.getState(), 'opening');

  // Concurrent activation while opening is rejected
  const p2 = await controller.activate('https://example.com');
  assert.equal(p2.success, false);
  assert.equal(p2.error, 'Activation already in progress');

  await p1;
  assert.equal(openCount, 1);

  // Rapid activation within debounce budget is rejected
  const p3 = await controller.activate('https://example.com');
  assert.equal(p3.success, false);
  assert.equal(p3.error, 'Activation debounced');
  assert.equal(openCount, 1);

  controller.dispose();
});

test('LinkOpenerController: disposal during in-flight activation suppresses subsequent state callbacks', async () => {
  let latestStatus = 'idle';
  const slowOpener = async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    return { success: true };
  };

  const controller = new LinkOpenerController(
    {
      onStateChange: (status) => {
        latestStatus = status;
      },
    },
    { openFn: slowOpener }
  );

  const activationPromise = controller.activate('https://example.com');
  assert.equal(latestStatus, 'opening');

  // Dispose while activation is in-flight (simulates effect cleanup when unstable options trigger dispose)
  controller.dispose();
  assert.equal(controller.isDisposed(), true);

  await activationPromise;
  // Because controller was disposed, callbacks are dropped and it does not transition to 'opened'
  assert.equal(latestStatus, 'opening');
});

test('hasValidLeadingBoundary: discriminates valid boundaries vs embedded schemes', () => {
  assert.equal(hasValidLeadingBoundary('https://a.com', 0), true);
  assert.equal(hasValidLeadingBoundary(' https://a.com', 1), true);
  assert.equal(hasValidLeadingBoundary('(https://a.com)', 1), true);
  assert.equal(hasValidLeadingBoundary('[https://a.com]', 1), true);
  assert.equal(hasValidLeadingBoundary('"https://a.com"', 1), true);
  assert.equal(hasValidLeadingBoundary('((https://a.com))', 2), true);

  // Embedded schemes and word boundaries must be rejected
  assert.equal(hasValidLeadingBoundary('javascript:https://evil.com', 11), false);
  assert.equal(hasValidLeadingBoundary('data:https://evil.com', 5), false);
  assert.equal(hasValidLeadingBoundary('vbscript:https://evil.com', 9), false);
  assert.equal(hasValidLeadingBoundary('blob:https://evil.com', 5), false);
  assert.equal(hasValidLeadingBoundary('foohttps://evil.com', 3), false);
  assert.equal(hasValidLeadingBoundary('javascript:(https://evil.com)', 12), false);
});

test('UserMessageContent: handles empty string gracefully', () => {
  const markup = renderToStaticMarkup(
    React.createElement(UserMessageContent, { content: '' })
  );
  assert.equal(markup, '<div class="message-literal"></div>');
});
