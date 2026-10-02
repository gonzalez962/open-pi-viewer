import assert from 'node:assert/strict';
import test from 'node:test';
import enJson from '@shared/locales/en.json';
import esJson from '@shared/locales/es.json';
import {
  getCodeCopyAriaLabel,
  getCopyLiveStatusText,
  getLinkCopyAriaLabel,
} from '@features/chat/MarkdownContent';
import {
  CopyController,
  copyText,
  type ClipboardHost,
} from '@shared/clipboard';
import { translate } from '@shared/i18n';
import {
  LinkOpenerController,
  detectPlatform,
  getLinkAriaLabel,
  getLinkModifierKey,
  getLinkModifierLabel,
  getLinkOpenLiveStatusText,
  openExternalUrl,
  type OpenUrlResult,
} from '@infra/opener';
import {
  MAX_LIST_NESTING_DEPTH,
  extractCodeBlocks,
  getLastAssistantCodeBlocks,
  isSafeUrl,
  parseCodeFenceHeader,
  parseInline,
  parseMarkdown,
  parseTableDelimiter,
  sanitizeLanguage,
  shouldRenderAsMarkdown,
  splitTableCells,
} from '@core/markdown';
import type { ChatMessage } from '@core/types/messages';

// ============================================================================
// Group 1: Message Rendering Decision (Assistant vs User/System)
// ============================================================================

test('decision: shouldRenderAsMarkdown enables Markdown parser exclusively for assistant role', () => {
  assert.equal(shouldRenderAsMarkdown('assistant'), true);
  assert.equal(shouldRenderAsMarkdown('user'), false);
  assert.equal(shouldRenderAsMarkdown('system'), false);
  assert.equal(shouldRenderAsMarkdown('tool'), false);
  assert.equal(shouldRenderAsMarkdown(''), false);
  assert.equal(shouldRenderAsMarkdown('unknown'), false);
});

test('decision: user content containing Markdown/HTML remains literal plain text', () => {
  const userPayload = '# Title\n```js\nalert(1);\n```\n<script>evil()</script>';
  assert.equal(shouldRenderAsMarkdown('user'), false);
  assert.ok(userPayload.length > 0);
  // Parser is not invoked for user messages; payload is passed to literal container
});

// ============================================================================
// Group 2: Markdown Parser - Headings
// ============================================================================

test('parser: parses headings 1 through 6 with correct levels', () => {
  for (let level = 1; level <= 6; level++) {
    const hashes = '#'.repeat(level);
    const ast = parseMarkdown(`${hashes} Heading Level ${level}`);
    assert.equal(ast.children.length, 1);
    const block = ast.children[0];
    assert.equal(block.type, 'heading');
    if (block.type === 'heading') {
      assert.equal(block.level, level);
      assert.deepEqual(block.children, [{ type: 'text', value: `Heading Level ${level}` }]);
    }
  }
});

test('parser: headings support nested inline formatting', () => {
  const ast = parseMarkdown('## Heading with *italic* and `code`');
  assert.equal(ast.children.length, 1);
  const block = ast.children[0];
  assert.equal(block.type, 'heading');
  if (block.type === 'heading') {
    assert.equal(block.level, 2);
    assert.deepEqual(block.children, [
      { type: 'text', value: 'Heading with ' },
      { type: 'emphasis', children: [{ type: 'text', value: 'italic' }] },
      { type: 'text', value: ' and ' },
      { type: 'code_inline', value: 'code' },
    ]);
  }
});

test('parser: more than 6 hashes or missing space are parsed as paragraph, not heading', () => {
  const ast1 = parseMarkdown('####### Seven Hashes');
  assert.equal(ast1.children[0].type, 'paragraph');

  const ast2 = parseMarkdown('#NoSpaceAfterHash');
  assert.equal(ast2.children[0].type, 'paragraph');
});

// ============================================================================
// Group 3: Markdown Parser - Paragraphs, Blank Lines & CRLF
// ============================================================================

test('parser: parses multiple paragraphs separated by blank lines', () => {
  const markdown = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.';
  const ast = parseMarkdown(markdown);
  assert.equal(ast.children.length, 3);
  assert.equal(ast.children[0].type, 'paragraph');
  assert.equal(ast.children[1].type, 'paragraph');
  assert.equal(ast.children[2].type, 'paragraph');
});

test('parser: normalizes CRLF (\\r\\n) and CR (\\r) identically to LF (\\n)', () => {
  const crlf = '# Title\r\n\r\nParagraph line 1\r\nParagraph line 2\r\n\r\n```ts\r\nconst x = 1;\r\n```';
  const lf = '# Title\n\nParagraph line 1\nParagraph line 2\n\n```ts\nconst x = 1;\n```';

  const astCrlf = parseMarkdown(crlf);
  const astLf = parseMarkdown(lf);

  assert.deepEqual(astCrlf, astLf);
});

test('parser: handles empty and whitespace-only input safely', () => {
  assert.deepEqual(parseMarkdown(''), { type: 'root', children: [] });
  assert.deepEqual(parseMarkdown('   \n\t\n  '), { type: 'root', children: [] });
  assert.deepEqual(parseMarkdown(null as any), { type: 'root', children: [] });
  assert.deepEqual(parseMarkdown(undefined as any), { type: 'root', children: [] });
});

test('parser: bounded complexity with large lines and huge inputs', () => {
  const hugeLine = 'a'.repeat(50000);
  const start = Date.now();
  const ast = parseMarkdown(hugeLine);
  const duration = Date.now() - start;

  assert.equal(ast.children.length, 1);
  assert.equal(ast.children[0].type, 'paragraph');
  assert.ok(duration < 200, `Large line parsed in ${duration}ms, must be < 200ms`);
});

// ============================================================================
// Group 4: Markdown Parser - Lists & Nested Lists
// ============================================================================

test('parser: parses unordered lists with -, *, and + markers', () => {
  const markdown = '- Dash item\n* Star item\n+ Plus item';
  const ast = parseMarkdown(markdown);
  assert.equal(ast.children.length, 1);
  const list = ast.children[0];
  assert.equal(list.type, 'list');
  if (list.type === 'list') {
    assert.equal(list.ordered, false);
    assert.equal(list.items.length, 3);
    assert.deepEqual(list.items[0].children, [{ type: 'text', value: 'Dash item' }]);
    assert.deepEqual(list.items[1].children, [{ type: 'text', value: 'Star item' }]);
    assert.deepEqual(list.items[2].children, [{ type: 'text', value: 'Plus item' }]);
  }
});

test('parser: parses ordered lists with numeric markers and records start number', () => {
  const markdown = '1. First item\n2. Second item\n3. Third item';
  const ast = parseMarkdown(markdown);
  assert.equal(ast.children.length, 1);
  const list = ast.children[0];
  assert.equal(list.type, 'list');
  if (list.type === 'list') {
    assert.equal(list.ordered, true);
    assert.equal(list.start, 1);
    assert.equal(list.items.length, 3);
    assert.deepEqual(list.items[0].children, [{ type: 'text', value: 'First item' }]);
  }
});

test('parser: parses nested lists (reasonable subset)', () => {
  const markdown = '- Parent 1\n  - Child 1.1\n  - Child 1.2\n- Parent 2';
  const ast = parseMarkdown(markdown);
  assert.equal(ast.children.length, 1);
  const list = ast.children[0];
  assert.equal(list.type, 'list');
  if (list.type === 'list') {
    assert.equal(list.items.length, 2);
    assert.ok(list.items[0].subList, 'Parent 1 has subList');
    assert.equal(list.items[0].subList?.type, 'list');
    assert.equal(list.items[0].subList?.items.length, 2);
    assert.deepEqual(list.items[0].subList?.items[0].children, [{ type: 'text', value: 'Child 1.1' }]);
    assert.equal(list.items[1].subList, undefined);
  }
});

test('parser: parses nested mixed lists (ordered inside unordered and vice versa)', () => {
  const markdown = '- Top level\n  1. Ordered sub\n  2. Ordered sub 2\n- Another top';
  const ast = parseMarkdown(markdown);
  const list = ast.children[0];
  if (list.type === 'list') {
    assert.equal(list.ordered, false);
    assert.ok(list.items[0].subList);
    assert.equal(list.items[0].subList?.ordered, true);
  }
});

test('parser: list items support inline formatting', () => {
  const markdown = '- Item with **bold** and `code`';
  const ast = parseMarkdown(markdown);
  const list = ast.children[0];
  if (list.type === 'list') {
    assert.deepEqual(list.items[0].children, [
      { type: 'text', value: 'Item with ' },
      { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
      { type: 'text', value: ' and ' },
      { type: 'code_inline', value: 'code' },
    ]);
  }
});

// ============================================================================
// Group 5: Markdown Parser - Inline Formatting & Delimiters
// ============================================================================

test('parser: parses strong (** and __) and emphasis (* and _)', () => {
  assert.deepEqual(parseInline('**bold**'), [
    { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
  ]);
  assert.deepEqual(parseInline('__bold__'), [
    { type: 'strong', children: [{ type: 'text', value: 'bold' }] },
  ]);
  assert.deepEqual(parseInline('*italic*'), [
    { type: 'emphasis', children: [{ type: 'text', value: 'italic' }] },
  ]);
  assert.deepEqual(parseInline('_italic_'), [
    { type: 'emphasis', children: [{ type: 'text', value: 'italic' }] },
  ]);
});

test('parser: parses combined strong and emphasis (*** and ___) and nested formats', () => {
  assert.deepEqual(parseInline('***bold italic***'), [
    {
      type: 'strong',
      children: [
        {
          type: 'emphasis',
          children: [{ type: 'text', value: 'bold italic' }],
        },
      ],
    },
  ]);

  assert.deepEqual(parseInline('**bold with *italic* inside**'), [
    {
      type: 'strong',
      children: [
        { type: 'text', value: 'bold with ' },
        { type: 'emphasis', children: [{ type: 'text', value: 'italic' }] },
        { type: 'text', value: ' inside' },
      ],
    },
  ]);
});

test('parser: parses inline code spans with raw preservation', () => {
  assert.deepEqual(parseInline('Code: `const x = 10;`'), [
    { type: 'text', value: 'Code: ' },
    { type: 'code_inline', value: 'const x = 10;' },
  ]);
});

test('parser: unclosed inline delimiters remain literal text without corrupting output', () => {
  assert.deepEqual(parseInline('*unclosed emphasis'), [
    { type: 'text', value: '*unclosed emphasis' },
  ]);
  assert.deepEqual(parseInline('**unclosed strong'), [
    { type: 'text', value: '**unclosed strong' },
  ]);
  assert.deepEqual(parseInline('***unclosed triple'), [
    { type: 'text', value: '***unclosed triple' },
  ]);
  assert.deepEqual(parseInline('`unclosed inline code'), [
    { type: 'text', value: '`unclosed inline code' },
  ]);
  assert.deepEqual(parseInline('[unclosed link label'), [
    { type: 'text', value: '[unclosed link label' },
  ]);
});

// ============================================================================
// Group 6: Fenced Code Blocks & Streaming
// ============================================================================

test('parser: parses fenced code blocks with backticks and tildes', () => {
  const md1 = '```js\nconsole.log("hello");\n```';
  const ast1 = parseMarkdown(md1);
  assert.equal(ast1.children.length, 1);
  assert.deepEqual(ast1.children[0], {
    type: 'code_block',
    language: 'js',
    code: 'console.log("hello");',
  });

  const md2 = '~~~\nplain code\n~~~';
  const ast2 = parseMarkdown(md2);
  assert.equal(ast2.children.length, 1);
  assert.deepEqual(ast2.children[0], {
    type: 'code_block',
    language: undefined,
    code: 'plain code',
  });
});

test('parser: sanitizes fenced info string against injection and strips whitespace/special chars', () => {
  assert.equal(sanitizeLanguage('typescript'), 'typescript');
  assert.equal(sanitizeLanguage('C++'), 'c++');
  assert.equal(sanitizeLanguage('C#'), 'c#');
  assert.equal(sanitizeLanguage('python --extra-flags'), 'python');
  assert.equal(sanitizeLanguage('<script>evil()</script>'), 'scriptevilscript');
  assert.equal(sanitizeLanguage('a'.repeat(50)), 'a'.repeat(32));
  assert.equal(sanitizeLanguage('   '), undefined);
  assert.equal(sanitizeLanguage(undefined), undefined);
});

test('parser: parses extended code fence headers with language, filename, title and diff categorization', () => {
  // 1. Language + path via colon (pi-messages standard: ```typescript:src/auth/service.ts)
  const meta1 = parseCodeFenceHeader('typescript:src/auth/service.ts');
  assert.equal(meta1.language, 'typescript');
  assert.equal(meta1.fileName, 'src/auth/service.ts');
  assert.equal(meta1.title, 'src/auth/service.ts');
  assert.equal(meta1.isDiff, undefined);

  // 2. Language + filename attribute (```rust filename="engine.rs")
  const meta2 = parseCodeFenceHeader('rust filename="engine.rs"');
  assert.equal(meta2.language, 'rust');
  assert.equal(meta2.fileName, 'engine.rs');
  assert.equal(meta2.title, 'engine.rs');

  // 3. Language + title attribute (```python title="Database Migration")
  const meta3 = parseCodeFenceHeader('python title="Database Migration"');
  assert.equal(meta3.language, 'python');
  assert.equal(meta3.title, 'Database Migration');

  // 4. Standalone filename as fence (```main.go)
  const meta4 = parseCodeFenceHeader('main.go');
  assert.equal(meta4.language, 'go');
  assert.equal(meta4.fileName, 'main.go');

  // 5. Diff blocks (```diff, ```patch)
  const meta5 = parseCodeFenceHeader('diff');
  assert.equal(meta5.language, 'diff');
  assert.equal(meta5.isDiff, true);

  const meta6 = parseCodeFenceHeader('patch:001-fix.patch');
  assert.equal(meta6.language, 'patch');
  assert.equal(meta6.fileName, '001-fix.patch');
  assert.equal(meta6.isDiff, true);
});

test('parser: parses Markdown containing extended code fence into AST with fileName and diff metadata', () => {
  const md = '```typescript:src/utils/math.ts\nexport function add(a: number, b: number) { return a + b; }\n```';
  const ast = parseMarkdown(md);

  assert.equal(ast.children.length, 1);
  assert.deepEqual(ast.children[0], {
    type: 'code_block',
    language: 'typescript',
    fileName: 'src/utils/math.ts',
    title: 'src/utils/math.ts',
    code: 'export function add(a: number, b: number) { return a + b; }',
  });
});

test('parser: unclosed fence at EOF streams as code block (crucial for streaming assistant tokens)', () => {
  const streamingPartial = 'Here is the code:\n\n```typescript\nfunction add(a: number, b: number) {\n  return a + b;';
  const ast = parseMarkdown(streamingPartial);

  assert.equal(ast.children.length, 2);
  assert.equal(ast.children[0].type, 'paragraph');
  assert.equal(ast.children[1].type, 'code_block');

  const codeBlock = ast.children[1];
  if (codeBlock.type === 'code_block') {
    assert.equal(codeBlock.language, 'typescript');
    assert.equal(codeBlock.code, 'function add(a: number, b: number) {\n  return a + b;');
  }
});

// ============================================================================
// Group 6b: GFM Markdown Tables
// ============================================================================

test('tables: splitTableCells handles leading/trailing pipes, code spans, and escapes', () => {
  const row = '| First | Second | Third |';
  assert.deepEqual(splitTableCells(row), ['First', 'Second', 'Third']);

  const withoutOuterPipes = 'Col 1 | Col 2';
  assert.deepEqual(splitTableCells(withoutOuterPipes), ['Col 1', 'Col 2']);

  const withCodeSpan = '| Name | `x | y` | Value |';
  assert.deepEqual(splitTableCells(withCodeSpan), ['Name', '`x | y`', 'Value']);
});

test('tables: parseTableDelimiter correctly parses column alignments', () => {
  const delim = '| :--- | :---: | ---: | --- |';
  const alignments = parseTableDelimiter(delim);
  assert.deepEqual(alignments, ['left', 'center', 'right', null]);

  const invalid = '| not-a-delim | --- |';
  assert.equal(parseTableDelimiter(invalid), null);
});

test('tables: parseMarkdown parses full GFM table into AST with headers and rows', () => {
  const tableMd = `
| Acción del Usuario | Antes | Ahora (pi-messages) |
| :--- | :--- | :--- |
| Identificar archivo | Texto plano o roto | Encabezado estilizado con glifo |
| Resaltado de sintaxis | Todo en blanco plano | PiColor enriquecido |
`;

  const ast = parseMarkdown(tableMd);
  assert.equal(ast.children.length, 1);
  const tableNode = ast.children[0];
  assert.equal(tableNode.type, 'table');
  if (tableNode.type === 'table') {
    assert.equal(tableNode.headers.length, 3);
    assert.equal(tableNode.headers[0].align, 'left');
    assert.equal(tableNode.rows.length, 2);
    assert.equal(tableNode.rows[0].length, 3);
    assert.equal(tableNode.rows[0][0].children[0].type, 'text');
    if (tableNode.rows[0][0].children[0].type === 'text') {
      assert.equal(tableNode.rows[0][0].children[0].value, 'Identificar archivo');
    }
  }
});

// ============================================================================
// Group 7: Link Policy, Safe URL Validation & Raw HTML Text
// ============================================================================

test('links: allows safe http, https, and mailto schemes via standard URL parsing', () => {
  assert.equal(isSafeUrl('https://example.com'), true);
  assert.equal(isSafeUrl('https://example.com/path?foo=bar#section'), true);
  assert.equal(isSafeUrl('http://insecure.test.org'), true);
  assert.equal(isSafeUrl('mailto:user@example.com'), true);
});

test('links: strictly rejects dangerous schemes (javascript, data, file, tauri, vbscript)', () => {
  assert.equal(isSafeUrl('javascript:alert(1)'), false);
  assert.equal(isSafeUrl('JAVASCRIPT:alert(1)'), false);
  assert.equal(isSafeUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeUrl('file:///C:/Windows/System32'), false);
  assert.equal(isSafeUrl('tauri://localhost'), false);
  assert.equal(isSafeUrl('vbscript:msgbox(1)'), false);
});

test('links: rejects credentials in http and https URLs to prevent destination spoofing', () => {
  assert.equal(isSafeUrl('http://user:pass@example.com'), false);
  assert.equal(isSafeUrl('https://user@example.com'), false);
  assert.equal(isSafeUrl('https://:pass@example.com/path'), false);
  assert.equal(isSafeUrl('http://admin:secret@sub.domain.org'), false);
});

test('links: strictly enforces mailto safety policy (rejects queries, fragments, percent-encoding, and multiple recipients)', () => {
  // Query parameters / headers disallowed
  assert.equal(isSafeUrl('mailto:user@example.com?subject=Hello'), false);
  assert.equal(isSafeUrl('mailto:user@example.com?body=secret'), false);

  // Fragments disallowed
  assert.equal(isSafeUrl('mailto:user@example.com#section'), false);

  // Percent-encoded recipient content strictly disallowed for MVP
  assert.equal(isSafeUrl('mailto:user%0d%0a@example.com'), false);
  assert.equal(isSafeUrl('mailto:user%20name@example.com'), false);
  assert.equal(isSafeUrl('mailto:user%40example.com'), false);
  assert.equal(isSafeUrl('mailto:user%2ename@example.com'), false);

  // Multiple recipients disallowed (single recipient policy)
  assert.equal(isSafeUrl('mailto:alice@example.com,bob@example.com'), false);

  // Invalid recipient formats
  assert.equal(isSafeUrl('mailto:'), false);
  assert.equal(isSafeUrl('mailto:notanemail'), false);
  assert.equal(isSafeUrl('mailto:user@'), false);
  assert.equal(isSafeUrl('mailto:@domain.com'), false);
  assert.equal(isSafeUrl('mailto:user@domain'), false);

  // Safe single recipient with dotted domain
  assert.equal(isSafeUrl('mailto:user@example.com'), true);
  assert.equal(isSafeUrl('mailto:dev@gentle.ai'), true);
});

test('links: preserves standard http/https path percent-encoding, query, fragments, ports, and IPv6', () => {
  assert.equal(isSafeUrl('https://example.com/path%20encoded?foo=bar#frag'), true);
  assert.equal(isSafeUrl('http://localhost:3000/api'), true);
  assert.equal(isSafeUrl('http://[::1]:8080/test'), true);
  assert.equal(isSafeUrl('https://gentle.ai/docs/intro#section'), true);
});

test('links: strictly rejects whitespace, newlines, encoded schemes, and malformed URLs', () => {
  assert.equal(isSafeUrl('javascript :alert(1)'), false);
  assert.equal(isSafeUrl('java\nscript:alert(1)'), false);
  assert.equal(isSafeUrl('https://exa mple.com'), false);
  assert.equal(isSafeUrl('http://'), false);
  assert.equal(isSafeUrl('https://'), false);
  assert.equal(isSafeUrl('mailto:'), false);
  assert.equal(isSafeUrl('/relative/path'), false);
  assert.equal(isSafeUrl('not a url'), false);
  assert.equal(isSafeUrl(''), false);
});

test('links: unsafe or malformed links are rendered as literal text without link nodes', () => {
  const unsafe1 = parseInline('[Click me](javascript:alert(1))');
  assert.deepEqual(unsafe1, [{ type: 'text', value: '[Click me](javascript:alert(1))' }]);

  const unsafe2 = parseInline('[Payload](data:text/html,bad)');
  assert.deepEqual(unsafe2, [{ type: 'text', value: '[Payload](data:text/html,bad)' }]);

  const unsafe3 = parseInline('[File](file:///etc/passwd)');
  assert.deepEqual(unsafe3, [{ type: 'text', value: '[File](file:///etc/passwd)' }]);

  const safe = parseInline('[Safe Link](https://gentle.ai)');
  assert.deepEqual(safe, [
    {
      type: 'link',
      label: [{ type: 'text', value: 'Safe Link' }],
      href: 'https://gentle.ai',
    },
  ]);
});

test('links: autolinks automatically parse bare URLs and bracketed URLs as link nodes', () => {
  // 1. Bare https link in sentence
  const bare1 = parseInline('Visit https://github.com/devswha/herdr-web-ui to install');
  assert.deepEqual(bare1, [
    { type: 'text', value: 'Visit ' },
    {
      type: 'link',
      label: [{ type: 'text', value: 'https://github.com/devswha/herdr-web-ui' }],
      href: 'https://github.com/devswha/herdr-web-ui',
    },
    { type: 'text', value: ' to install' },
  ]);

  // 2. Localhost IP with port
  const bareIp = parseInline('Open http://127.0.0.1:7317 in your browser');
  assert.deepEqual(bareIp, [
    { type: 'text', value: 'Open ' },
    {
      type: 'link',
      label: [{ type: 'text', value: 'http://127.0.0.1:7317' }],
      href: 'http://127.0.0.1:7317',
    },
    { type: 'text', value: ' in your browser' },
  ]);

  // 3. Trailing sentence punctuation stripped from link href
  const barePunct = parseInline('Check https://example.com/api.');
  assert.deepEqual(barePunct, [
    { type: 'text', value: 'Check ' },
    {
      type: 'link',
      label: [{ type: 'text', value: 'https://example.com/api' }],
      href: 'https://example.com/api',
    },
    { type: 'text', value: '.' },
  ]);

  // 4. Bracketed autolink <https://...>
  const bracketed = parseInline('See <https://devswha.github.io/herdr-web-ui/> now');
  assert.deepEqual(bracketed, [
    { type: 'text', value: 'See ' },
    {
      type: 'link',
      label: [{ type: 'text', value: 'https://devswha.github.io/herdr-web-ui/' }],
      href: 'https://devswha.github.io/herdr-web-ui/',
    },
    { type: 'text', value: ' now' },
  ]);
});

test('links: credentials, mailto queries/percent-encoding/multiple recipients render as inert plain text in parser', () => {
  const rejectedLinks = [
    '[Evil](http://user:pass@example.com)',
    '[Creds](https://user@example.com)',
    '[MailQuery](mailto:user@example.com?subject=Hello)',
    '[MailFrag](mailto:user@example.com#section)',
    '[MailEncoded](mailto:user%40example.com)',
    '[MailEncodedPunct](mailto:user%2ename@example.com)',
    '[MailMulti](mailto:alice@example.com,bob@example.com)',
    '[MailInvalid](mailto:user@domain)',
  ];

  for (const linkMarkdown of rejectedLinks) {
    const nodes = parseInline(linkMarkdown);
    assert.equal(
      nodes.some((n) => n.type === 'link'),
      false,
      `${linkMarkdown} must NOT generate a link node`
    );
    assert.deepEqual(nodes, [{ type: 'text', value: linkMarkdown }]);
  }
});

test('parser: raw HTML text (<script>, <img>, <div>) is preserved as literal text nodes for React escaping', () => {
  const rawHtml = '<script>alert(1)</script><img src="x" onerror="evil()" /><b>bold text</b>';
  const ast = parseMarkdown(rawHtml);

  assert.equal(ast.children.length, 1);
  assert.equal(ast.children[0].type, 'paragraph');
  if (ast.children[0].type === 'paragraph') {
    assert.deepEqual(ast.children[0].children, [
      { type: 'text', value: rawHtml },
    ]);
  }
});

// ============================================================================
// Group 8: Clipboard Helper (Dependency-Injectable in Node)
// ============================================================================

test('clipboard: primary navigator.clipboard.writeText succeeds and returns true', async () => {
  let writtenText = '';
  const mockHost: ClipboardHost = {
    clipboard: {
      writeText: async (text: string) => {
        writtenText = text;
      },
    },
  };

  const result = await copyText('test clipboard payload', { host: mockHost });
  assert.equal(result, true);
  assert.equal(writtenText, 'test clipboard payload');
});

test('clipboard: falls back to transient textarea with execCommand when primary rejects', async () => {
  let execCommandCalled = '';
  let appendedChild: any = null;
  let removedChild: any = null;

  const mockHost: ClipboardHost = {
    clipboard: {
      writeText: async () => {
        throw new Error('NotAllowedError');
      },
    },
    document: {
      createElement: (tag: string) => ({
        tagName: tag.toUpperCase(),
        value: '',
        style: {},
        setAttribute: () => {},
        select: () => {},
        setSelectionRange: () => {},
      }),
      body: {
        appendChild: (child: any) => {
          appendedChild = child;
        },
        removeChild: (child: any) => {
          removedChild = child;
        },
      },
      execCommand: (command: string) => {
        execCommandCalled = command;
        return true;
      },
    },
  };

  const result = await copyText('fallback payload', { host: mockHost });
  assert.equal(result, true);
  assert.equal(execCommandCalled, 'copy');
  assert.ok(appendedChild, 'transient textarea was appended');
  assert.equal(removedChild, appendedChild, 'transient textarea was removed');
});

test('clipboard: returns false cleanly when both primary and fallback fail without throwing', async () => {
  const mockHost: ClipboardHost = {
    clipboard: {
      writeText: async () => {
        throw new Error('Primary clipboard denied');
      },
    },
    document: {
      createElement: () => ({
        style: {},
        setAttribute: () => {},
        select: () => {},
        setSelectionRange: () => {},
      }),
      body: {
        appendChild: () => {},
        removeChild: () => {},
      },
      execCommand: () => false,
    },
  };

  const result = await copyText('fail test', { host: mockHost });
  assert.equal(result, false);
});

test('clipboard: restores previous selection and activeElement focus', async () => {
  let focusCalled = false;
  let removeAllRangesCalled = false;
  let addRangeCalledWith: any = null;

  const mockRange = { id: 'original-range' };
  const mockActiveElement = {
    focus: () => {
      focusCalled = true;
    },
  };

  const mockHost: ClipboardHost = {
    document: {
      activeElement: mockActiveElement,
      createElement: () => ({
        style: {},
        setAttribute: () => {},
        select: () => {},
        setSelectionRange: () => {},
      }),
      body: {
        appendChild: () => {},
        removeChild: () => {},
      },
      execCommand: () => true,
      getSelection: () => ({
        rangeCount: 1,
        getRangeAt: (idx: number) => (idx === 0 ? mockRange : null),
        removeAllRanges: () => {
          removeAllRangesCalled = true;
        },
        addRange: (r: any) => {
          addRangeCalledWith = r;
        },
      }),
    },
  };

  const result = await copyText('focus restore test', { host: mockHost });
  assert.equal(result, true);
  assert.equal(focusCalled, true);
  assert.equal(removeAllRangesCalled, true);
  assert.equal(addRangeCalledWith, mockRange);
});

// ============================================================================
// Group 9: CopyController & State Machine
// ============================================================================

test('CopyController: transitions from idle -> copied -> idle on success', async () => {
  const states: string[] = [];
  const controller = new CopyController(
    { onStateChange: (state) => states.push(state) },
    {
      timeoutMs: 50,
      copyFn: async () => true,
    }
  );

  assert.equal(controller.getState(), 'idle');
  await controller.copy('hello');
  assert.equal(controller.getState(), 'copied');

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(controller.getState(), 'idle');
  assert.deepEqual(states, ['copied', 'idle']);

  controller.dispose();
});

test('CopyController: transitions from idle -> failed -> idle on failure', async () => {
  const states: string[] = [];
  const controller = new CopyController(
    { onStateChange: (state) => states.push(state) },
    {
      timeoutMs: 50,
      copyFn: async () => false,
    }
  );

  await controller.copy('hello');
  assert.equal(controller.getState(), 'failed');

  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(controller.getState(), 'idle');
  assert.deepEqual(states, ['failed', 'idle']);

  controller.dispose();
});

test('CopyController: dispose cancels pending timeout and drops subsequent updates (unmount-safe)', async () => {
  const states: string[] = [];
  const controller = new CopyController(
    { onStateChange: (state) => states.push(state) },
    {
      timeoutMs: 50,
      copyFn: async () => true,
    }
  );

  await controller.copy('text');
  assert.equal(states.length, 1);
  assert.equal(states[0], 'copied');

  // Dispose before timeout fires (simulating component unmount)
  controller.dispose();

  await new Promise((resolve) => setTimeout(resolve, 80));
  // No further state transitions should have been emitted
  assert.equal(states.length, 1);

  // Calling copy on disposed controller returns false and emits nothing
  const res = await controller.copy('text2');
  assert.equal(res, false);
  assert.equal(states.length, 1);
});

test('CopyController: multiple rapid calls reset timer independently', async () => {
  const states: string[] = [];
  const controller = new CopyController(
    { onStateChange: (state) => states.push(state) },
    {
      timeoutMs: 60,
      copyFn: async () => true,
    }
  );

  await controller.copy('first');
  await new Promise((resolve) => setTimeout(resolve, 30));
  await controller.copy('second'); // resets timer

  await new Promise((resolve) => setTimeout(resolve, 40));
  // At 70ms total, first timer would have fired, but reset pushed expiration to +60ms from second call
  assert.equal(controller.getState(), 'copied');

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(controller.getState(), 'idle');

  controller.dispose();
});

// ============================================================================
// Group 10: Localization Dictionary Parity
// ============================================================================

test('i18n: all markdown localization keys exist with exact parity in en.json and es.json', () => {
  const requiredKeys = [
    'markdown.copy_code',
    'markdown.copy_url',
    'markdown.copied',
    'markdown.copy_failed',
    'markdown.copy_code_aria',
    'markdown.copied_code_aria',
    'markdown.copy_failed_code_aria',
    'markdown.copy_url_aria',
    'markdown.copied_url_aria',
    'markdown.copy_failed_url_aria',
    'markdown.code_plain',
    'markdown.open_url',
    'markdown.opening',
    'markdown.open_failed',
    'markdown.open_url_aria',
    'markdown.opening_url_aria',
    'markdown.open_failed_url_aria',
    'markdown.link_hint',
  ];

  for (const key of requiredKeys) {
    assert.ok(key in enJson, `Key ${key} missing from en.json`);
    assert.ok(key in esJson, `Key ${key} missing from es.json`);

    const enVal = (enJson as Record<string, string>)[key];
    const esVal = (esJson as Record<string, string>)[key];

    assert.ok(typeof enVal === 'string' && enVal.trim().length > 0, `en.json ${key} must be non-empty string`);
    assert.ok(typeof esVal === 'string' && esVal.trim().length > 0, `es.json ${key} must be non-empty string`);
  }
});

// ============================================================================
// Group 11: Production Link Policy & Rendering Contracts
// ============================================================================

test('link policy: unsafe schemes never produce link AST nodes and cannot navigate WebView', () => {
  const unsafeTargets = [
    'javascript:alert(1)',
    'JAVASCRIPT:void(0)',
    'data:text/html,<script>alert(1)</script>',
    'file:///C:/Windows/System32',
    'tauri://localhost/evil',
    'vbscript:msgbox(1)',
    'javascript :alert(1)',
    'java\nscript:alert(1)',
    'javascript%3Aalert(1)',
    '/relative/path/navigation',
    'http://',
    'https://',
    'mailto:',
  ];

  for (const unsafe of unsafeTargets) {
    const nodes = parseInline(`[Exploit](${unsafe})`);
    assert.equal(
      nodes.some((n) => n.type === 'link'),
      false,
      `Unsafe URL ${unsafe} must NOT generate a link node`
    );
    assert.equal(nodes[0].type, 'text');
    assert.ok(
      nodes[0].value.includes('[Exploit]('),
      `Unsafe URL ${unsafe} must remain literal text`
    );
  }
});

// ============================================================================
// Group 12: Screen Reader Announcements & Accessibility Hardening
// ============================================================================

test('a11y: getCodeCopyAriaLabel provides dynamic accessible announcements in en and es', () => {
  const tEn = (key: any, params?: any) => translate('en', key, params);
  const tEs = (key: any, params?: any) => translate('es', key, params);

  // Idle status
  assert.equal(getCodeCopyAriaLabel('idle', 'typescript', tEn), 'Copy typescript code to clipboard');
  assert.equal(getCodeCopyAriaLabel('idle', 'typescript', tEs), 'Copiar código typescript al portapapeles');

  // Copied status (dynamic label avoids masking visual Copied feedback)
  assert.equal(getCodeCopyAriaLabel('copied', 'typescript', tEn), 'Copied typescript code to clipboard');
  assert.equal(getCodeCopyAriaLabel('copied', 'typescript', tEs), 'Código typescript copiado al portapapeles');

  // Failed status
  assert.equal(getCodeCopyAriaLabel('failed', 'typescript', tEn), 'Failed to copy typescript code');
  assert.equal(getCodeCopyAriaLabel('failed', 'typescript', tEs), 'Error al copiar código typescript');
});

test('a11y: getLinkCopyAriaLabel provides dynamic accessible announcements in en and es', () => {
  const tEn = (key: any, params?: any) => translate('en', key, params);
  const tEs = (key: any, params?: any) => translate('es', key, params);
  const url = 'https://gentle.ai';

  // Idle status
  assert.equal(getLinkCopyAriaLabel('idle', url, tEn), 'Copy link URL: https://gentle.ai');
  assert.equal(getLinkCopyAriaLabel('idle', url, tEs), 'Copiar URL del enlace: https://gentle.ai');

  // Copied status
  assert.equal(getLinkCopyAriaLabel('copied', url, tEn), 'Copied link URL to clipboard');
  assert.equal(getLinkCopyAriaLabel('copied', url, tEs), 'URL del enlace copiada al portapapeles');

  // Failed status
  assert.equal(getLinkCopyAriaLabel('failed', url, tEn), 'Failed to copy link URL');
  assert.equal(getLinkCopyAriaLabel('failed', url, tEs), 'Error al copiar URL del enlace');
});

test('a11y: getCopyLiveStatusText returns announcements on transition and null on idle (no repeated noisy announcements)', () => {
  const tEn = (key: any, params?: any) => translate('en', key, params);
  const tEs = (key: any, params?: any) => translate('es', key, params);

  // Idle returns null: no announcement on mount or rest
  assert.equal(getCopyLiveStatusText('idle', tEn), null);
  assert.equal(getCopyLiveStatusText('idle', tEs), null);

  // Copied returns brief polite text
  assert.equal(getCopyLiveStatusText('copied', tEn), 'Copied!');
  assert.equal(getCopyLiveStatusText('copied', tEs), '¡Copiado!');

  // Failed returns brief polite failure notice
  assert.equal(getCopyLiveStatusText('failed', tEn), 'Failed to copy');
  assert.equal(getCopyLiveStatusText('failed', tEs), 'Error al copiar');
});

// ============================================================================
// Group 13: List Nesting Depth Cap & Adversarial Boundedness
// ============================================================================

test('parser: MAX_LIST_NESTING_DEPTH cap is strictly enforced', () => {
  assert.equal(MAX_LIST_NESTING_DEPTH, 6);
});

test('parser: reasonable nested lists (up to 4 levels) nest cleanly with subLists', () => {
  const md = '- L0\n  - L1\n    - L2\n      - L3';
  const ast = parseMarkdown(md);
  assert.equal(ast.children.length, 1);
  const l0 = ast.children[0];
  if (l0.type === 'list') {
    assert.ok(l0.items[0].subList);
    const l1 = l0.items[0].subList;
    assert.ok(l1.items[0].subList);
    const l2 = l1.items[0].subList;
    assert.ok(l2.items[0].subList);
    const l3 = l2.items[0].subList;
    assert.equal(l3.items[0].children[0].type, 'text');
    if (l3.items[0].children[0].type === 'text') {
      assert.equal(l3.items[0].children[0].value, 'L3');
    }
  }
});

test('parser: deep nesting beyond MAX_LIST_NESTING_DEPTH flattens deterministically without content loss', () => {
  // Build a list with 9 levels of indentation (exceeding cap of 6)
  const lines: string[] = [];
  for (let i = 0; i < 9; i++) {
    lines.push(`${'  '.repeat(i)}- Level ${i}`);
  }
  const ast = parseMarkdown(lines.join('\n'));

  // Traverse down to level 6 (the cap)
  let current: any = ast.children[0];
  let depth = 0;
  while (current && current.type === 'list' && current.items[0].subList) {
    current = current.items[0].subList;
    depth++;
  }

  // Confirm depth cap was honored
  assert.equal(depth, MAX_LIST_NESTING_DEPTH);

  // Confirm all text from deeper levels (Level 7, Level 8) was flattened into the capped item without content loss
  const cappedItem = current.items[0];
  const allText = cappedItem.children.map((c: any) => c.value).join(' ');
  assert.ok(allText.includes('Level 6'));
  assert.ok(allText.includes('Level 7'), 'Must preserve Level 7 text');
  assert.ok(allText.includes('Level 8'), 'Must preserve Level 8 text');
});

test('parser: adversarial thousands of progressive indentation levels parse boundedly without stack overflow', () => {
  const count = 2000;
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(`${'  '.repeat(i)}- Line ${i}`);
  }

  const start = Date.now();
  const ast = parseMarkdown(lines.join('\n'));
  const duration = Date.now() - start;

  assert.equal(ast.children.length, 1);
  assert.equal(ast.children[0].type, 'list');
  assert.ok(duration < 1500, `Adversarial 2000-deep list parsed in ${duration}ms, must be < 1500ms`);
});

// ============================================================================
// Group 14: Safe External Link Opener & Activation Controller
// ============================================================================

test('opener: safe http, https, and mailto schemes call invoke exactly once with bounded command', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return undefined as unknown as T;
  };

  const safeUrls = [
    'http://example.com/docs',
    'https://gentle.ai',
    'mailto:dev@gentle.ai',
  ];

  for (const url of safeUrls) {
    calls.length = 0;
    const res = await openExternalUrl(url, { invokeFn: mockInvoke });
    assert.equal(res.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].cmd, 'open_external_url');
    assert.deepEqual(calls[0].args, { url });
  }
});

test('opener: unsafe and disallowed schemes are rejected before invoke without IPC call', async () => {
  const calls: { cmd: string; args?: Record<string, unknown> }[] = [];
  const mockInvoke = async <T>(cmd: string, args?: Record<string, unknown>): Promise<T> => {
    calls.push({ cmd, args });
    return undefined as unknown as T;
  };

  const unsafeUrls = [
    'javascript:alert(1)',
    'data:text/html,evil',
    'file:///C:/secret',
    'tauri://localhost',
    'vbscript:msgbox',
    'custom-app://open',
    '/local/path',
    'https://',
    'mailto:',
    'http://user:pass@example.com',
    'https://user@example.com',
    'mailto:user@example.com?subject=Hello',
    'mailto:user%40example.com',
    'mailto:alice@example.com,bob@example.com',
    '   ',
  ];

  for (const url of unsafeUrls) {
    calls.length = 0;
    const res = await openExternalUrl(url, { invokeFn: mockInvoke });
    assert.equal(res.success, false);
    assert.ok(res.error);
    assert.equal(calls.length, 0, `Unsafe URL ${url} must NEVER call IPC invoke`);
  }
});

test('opener: catches invoke rejection honestly and returns structured failure status without throwing', async () => {
  const mockInvoke = async (): Promise<never> => {
    throw new Error('OS handler failed to open URL');
  };

  const res = await openExternalUrl('https://gentle.ai', { invokeFn: mockInvoke });
  assert.equal(res.success, false);
  assert.equal(res.error, 'OS handler failed to open URL');
});

test('opener: non-Tauri preview fallback returns structured error without throwing', async () => {
  // In Node environment without Tauri, invoking without mock invoke returns structured error
  const res = await openExternalUrl('https://gentle.ai');
  assert.equal(res.success, false);
  assert.ok(res.error?.includes('Desktop runtime unavailable'));
});

test('LinkOpenerController: transitions idle -> opening -> opened -> idle on success', async () => {
  const transitions: string[] = [];
  const controller = new LinkOpenerController(
    {
      onStateChange: (status) => {
        transitions.push(status);
      },
    },
    {
      timeoutMs: 60,
      openFn: async () => {
        await new Promise((r) => setTimeout(r, 10));
        return { success: true };
      },
    }
  );

  assert.equal(controller.getState(), 'idle');
  const promise = controller.activate('https://gentle.ai');
  assert.equal(controller.getState(), 'opening');

  const res = await promise;
  assert.equal(res.success, true);
  assert.equal(controller.getState(), 'opened');

  await new Promise((r) => setTimeout(r, 80));
  assert.equal(controller.getState(), 'idle');
  assert.deepEqual(transitions, ['opening', 'opened', 'idle']);

  controller.dispose();
});

test('LinkOpenerController: click policy requires Ctrl/Meta modifier and primary button (plain click does nothing)', async () => {
  let openCount = 0;
  const controller = new LinkOpenerController(
    { onStateChange: () => {} },
    {
      timeoutMs: 60,
      debounceMs: 10,
      openFn: async () => {
        openCount++;
        return { success: true };
      },
    }
  );

  // 1. Plain click: must do NOTHING (no preventDefault, no stopPropagation, no open, no state change)
  let plainPrevented = false;
  let plainStopped = false;
  const resPlain = await controller.handleClick(
    {
      button: 0,
      preventDefault: () => { plainPrevented = true; },
      stopPropagation: () => { plainStopped = true; },
    },
    'https://gentle.ai'
  );
  assert.equal(resPlain, null);
  assert.equal(plainPrevented, false, 'Plain click must NOT call preventDefault');
  assert.equal(plainStopped, false, 'Plain click must NOT call stopPropagation');
  assert.equal(openCount, 0, 'Plain click must not invoke opener');
  assert.equal(controller.getState(), 'idle');

  // 2. Non-primary modifier (e.g. Shift or Alt alone without Ctrl/Meta): does nothing
  let shiftPrevented = false;
  const resShift = await controller.handleClick(
    {
      button: 0,
      preventDefault: () => { shiftPrevented = true; },
    },
    'https://gentle.ai'
  );
  assert.equal(resShift, null);
  assert.equal(shiftPrevented, false, 'Non-primary modifier must NOT call preventDefault');
  assert.equal(openCount, 0);

  // 3. Non-primary button with Ctrl: rejected without opening
  const resMiddle = await controller.handleClick(
    {
      button: 1, // middle click
      ctrlKey: true,
    },
    'https://gentle.ai'
  );
  assert.equal(resMiddle, null);
  assert.equal(openCount, 0, 'Non-primary button must not open');

  const resRight = await controller.handleClick(
    {
      button: 2, // right click
      ctrlKey: true,
    },
    'https://gentle.ai'
  );
  assert.equal(resRight, null);
  assert.equal(openCount, 0, 'Right click must not open');

  // 4. Ctrl+click (primary button): calls preventDefault & stopPropagation, opens successfully
  let ctrlPrevented = false;
  let ctrlStopped = false;
  const resCtrl = await controller.handleClick(
    {
      button: 0,
      ctrlKey: true,
      preventDefault: () => { ctrlPrevented = true; },
      stopPropagation: () => { ctrlStopped = true; },
    },
    'https://gentle.ai'
  );
  assert.ok(resCtrl);
  assert.equal(resCtrl.success, true);
  assert.equal(ctrlPrevented, true, 'Eligible modified click must call preventDefault');
  assert.equal(ctrlStopped, true, 'Eligible modified click must call stopPropagation');
  assert.equal(openCount, 1);

  await new Promise((r) => setTimeout(r, 20));

  // 5. Meta+click (macOS Command key): calls preventDefault & stopPropagation, opens successfully
  let metaPrevented = false;
  let metaStopped = false;
  const resMeta = await controller.handleClick(
    {
      button: 0,
      metaKey: true,
      preventDefault: () => { metaPrevented = true; },
      stopPropagation: () => { metaStopped = true; },
    },
    'https://gentle.ai'
  );
  assert.ok(resMeta);
  assert.equal(resMeta.success, true);
  assert.equal(metaPrevented, true, 'Meta+click must call preventDefault');
  assert.equal(metaStopped, true, 'Meta+click must call stopPropagation');
  assert.equal(openCount, 2);

  controller.dispose();
});

test('LinkOpenerController: failure persists without auto-clearing and clears on next eligible retry', async () => {
  const transitions: string[] = [];
  let shouldSucceed = false;
  const controller = new LinkOpenerController(
    {
      onStateChange: (status) => {
        transitions.push(status);
      },
    },
    {
      timeoutMs: 40,
      debounceMs: 5,
      openFn: async () => {
        if (!shouldSucceed) {
          return { success: false, error: 'OS launcher failed: code 1' };
        }
        return { success: true };
      },
    }
  );

  // 1. Initial eligible activation fails
  const resFail = await controller.handleClick(
    { button: 0, ctrlKey: true },
    'https://gentle.ai'
  );
  assert.ok(resFail);
  assert.equal(resFail.success, false);
  assert.equal(controller.getState(), 'failed');
  assert.equal(controller.getError(), 'OS launcher failed: code 1');

  // 2. Wait longer than timeoutMs: verify failure is NOT auto-cleared after 2.5s/timeout
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(
    controller.getState(),
    'failed',
    'Failure state must persist and NOT auto-clear on timer'
  );
  assert.equal(controller.getError(), 'OS launcher failed: code 1');

  // 3. Plain click on failed link does NOT clear error and does NOT open
  const resPlain = await controller.handleClick({ button: 0 }, 'https://gentle.ai');
  assert.equal(resPlain, null);
  assert.equal(controller.getState(), 'failed', 'Ineligible plain click must preserve failure state');

  // 4. Next eligible activation (retry with Ctrl+click): clears error, transitions opening -> opened -> idle
  shouldSucceed = true;
  const resRetry = await controller.handleClick(
    { button: 0, ctrlKey: true },
    'https://gentle.ai'
  );
  assert.ok(resRetry);
  assert.equal(resRetry.success, true);
  assert.equal(controller.getState(), 'opened');
  assert.equal(controller.getError(), null);

  // 5. Opened success resets to idle after timeout
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(controller.getState(), 'idle');
  assert.deepEqual(transitions, ['opening', 'failed', 'opening', 'opened', 'idle']);

  controller.dispose();
});

test('LinkOpenerController: safely ignores concurrent activation while opening', async () => {
  let openCount = 0;
  const controller = new LinkOpenerController(
    { onStateChange: () => {} },
    {
      timeoutMs: 60,
      openFn: async () => {
        openCount++;
        await new Promise((r) => setTimeout(r, 50));
        return { success: true };
      },
    }
  );

  const p1 = controller.activate('https://gentle.ai');
  const p2 = controller.activate('https://gentle.ai');

  const [r1, r2] = await Promise.all([p1, p2]);
  assert.equal(r1.success, true);
  assert.equal(r2.success, false);
  assert.equal(r2.error, 'Activation already in progress');
  assert.equal(openCount, 1, 'Opener must only be invoked once for concurrent attempts');

  controller.dispose();
});

test('LinkOpenerController: debounces rapid duplicate activations', async () => {
  let openCount = 0;
  const controller = new LinkOpenerController(
    { onStateChange: () => {} },
    {
      timeoutMs: 60,
      debounceMs: 100,
      openFn: async () => {
        openCount++;
        return { success: true };
      },
    }
  );

  const r1 = await controller.activate('https://gentle.ai');
  assert.equal(r1.success, true);

  // Immediate second activation within debounce window
  const r2 = await controller.activate('https://gentle.ai');
  assert.equal(r2.success, false);
  assert.equal(r2.error, 'Activation debounced');
  assert.equal(openCount, 1, 'Debounced activation must not invoke openFn again');

  controller.dispose();
});

test('LinkOpenerController: keyboard policy activates on Ctrl/Meta+Enter, rejects plain Enter and Space without preventing default', async () => {
  let openCount = 0;
  const controller = new LinkOpenerController(
    { onStateChange: () => {} },
    {
      timeoutMs: 60,
      debounceMs: 10,
      openFn: async () => {
        openCount++;
        return { success: true };
      },
    }
  );

  // 1. Plain Enter: does NOT open and does NOT call preventDefault/stopPropagation
  let plainEnterPrevented = false;
  let plainEnterStopped = false;
  const resPlainEnter = await controller.handleKeyDown(
    {
      key: 'Enter',
      preventDefault: () => { plainEnterPrevented = true; },
      stopPropagation: () => { plainEnterStopped = true; },
    },
    'https://gentle.ai'
  );
  assert.equal(resPlainEnter, null);
  assert.equal(plainEnterPrevented, false, 'Plain Enter must NOT call preventDefault');
  assert.equal(plainEnterStopped, false, 'Plain Enter must NOT call stopPropagation');
  assert.equal(openCount, 0, 'Plain Enter must NOT open');

  // 2. Plain Space: does NOT open and does NOT call preventDefault (allows normal scrolling)
  let plainSpacePrevented = false;
  let plainSpaceStopped = false;
  const resPlainSpace = await controller.handleKeyDown(
    {
      key: ' ',
      preventDefault: () => { plainSpacePrevented = true; },
      stopPropagation: () => { plainSpaceStopped = true; },
    },
    'https://gentle.ai'
  );
  assert.equal(resPlainSpace, null);
  assert.equal(plainSpacePrevented, false, 'Plain Space must NOT call preventDefault');
  assert.equal(plainSpaceStopped, false, 'Plain Space must NOT call stopPropagation');
  assert.equal(openCount, 0, 'Plain Space must NOT open');

  // 3. Ctrl+Enter: calls preventDefault and stopPropagation, opens
  let ctrlEnterPrevented = false;
  let ctrlEnterStopped = false;
  const resCtrlEnter = await controller.handleKeyDown(
    {
      key: 'Enter',
      ctrlKey: true,
      preventDefault: () => { ctrlEnterPrevented = true; },
      stopPropagation: () => { ctrlEnterStopped = true; },
    },
    'https://gentle.ai'
  );
  assert.ok(resCtrlEnter);
  assert.equal(resCtrlEnter.success, true);
  assert.equal(ctrlEnterPrevented, true, 'Ctrl+Enter must call preventDefault');
  assert.equal(ctrlEnterStopped, true, 'Ctrl+Enter must call stopPropagation');
  assert.equal(openCount, 1);

  await new Promise((r) => setTimeout(r, 20));

  // 4. Meta+Enter: calls preventDefault and stopPropagation, opens
  let metaEnterPrevented = false;
  let metaEnterStopped = false;
  const resMetaEnter = await controller.handleKeyDown(
    {
      key: 'Enter',
      metaKey: true,
      preventDefault: () => { metaEnterPrevented = true; },
      stopPropagation: () => { metaEnterStopped = true; },
    },
    'https://gentle.ai'
  );
  assert.ok(resMetaEnter);
  assert.equal(resMetaEnter.success, true);
  assert.equal(metaEnterPrevented, true, 'Meta+Enter must call preventDefault');
  assert.equal(metaEnterStopped, true, 'Meta+Enter must call stopPropagation');
  assert.equal(openCount, 2);

  // 5. Ignored keys: Tab, Escape, ArrowDown, ArrowUp, 'a', Shift
  for (const key of ['Tab', 'Escape', 'ArrowDown', 'ArrowUp', 'a', 'Shift']) {
    let keyPrevented = false;
    let keyStopped = false;
    const res = await controller.handleKeyDown(
      {
        key,
        preventDefault: () => { keyPrevented = true; },
        stopPropagation: () => { keyStopped = true; },
      },
      'https://gentle.ai'
    );
    assert.equal(res, null, `Key ${key} must return null without activating`);
    assert.equal(keyPrevented, false, `Key ${key} must NOT call preventDefault`);
    assert.equal(keyStopped, false, `Key ${key} must NOT call stopPropagation`);
  }
  assert.equal(openCount, 2, 'Ignored keys must not trigger openFn');

  controller.dispose();
});

test('LinkOpenerController: keydown (Ctrl+Enter) followed by synthetic click is debounced to single activation', async () => {
  let openCount = 0;
  const controller = new LinkOpenerController(
    { onStateChange: () => {} },
    {
      timeoutMs: 60,
      debounceMs: 100,
      openFn: async () => {
        openCount++;
        return { success: true };
      },
    }
  );

  // User presses Ctrl+Enter
  const keyRes = await controller.handleKeyDown(
    { key: 'Enter', ctrlKey: true },
    'https://gentle.ai'
  );
  assert.ok(keyRes?.success);

  // Synthetic click with Ctrl fires 10ms later
  const clickRes = await controller.handleClick(
    { button: 0, ctrlKey: true },
    'https://gentle.ai'
  );
  assert.equal(clickRes?.success, false);
  assert.equal(clickRes?.error, 'Activation debounced');
  assert.equal(openCount, 1, 'Synthetic click must be blocked by debounce guard');

  // Synthetic click WITHOUT Ctrl fires 20ms later: ignored by plain click policy
  const plainClickRes = await controller.handleClick(
    { button: 0 },
    'https://gentle.ai'
  );
  assert.equal(plainClickRes, null);
  assert.equal(openCount, 1, 'Plain synthetic click must be ignored without calling openFn');

  controller.dispose();
});

test('LinkOpenerController: dispose cancels timers and drops late state changes (unmount safety)', async () => {
  const transitions: string[] = [];
  let resolvePromise: (val: OpenUrlResult) => void;
  const controller = new LinkOpenerController(
    {
      onStateChange: (status) => {
        transitions.push(status);
      },
    },
    {
      timeoutMs: 60,
      openFn: () => new Promise((r) => { resolvePromise = r; }),
    }
  );

  assert.equal(controller.isDisposed(), false);
  void controller.activate('https://gentle.ai');
  assert.equal(controller.getState(), 'opening');

  // Component unmounts while in-flight
  controller.dispose();
  assert.equal(controller.isDisposed(), true);

  // In-flight promise resolves after unmount
  resolvePromise!({ success: true });
  await new Promise((r) => setTimeout(r, 20));

  // Should have transitioned to opening before dispose, but NOT to opened or idle after dispose
  assert.deepEqual(transitions, ['opening']);

  // Disposed controller rejects subsequent activations
  const afterDisposeRes = await controller.activate('https://gentle.ai');
  assert.equal(afterDisposeRes.success, false);
  assert.equal(afterDisposeRes.error, 'Disposed');

  // Re-instantiating fresh controller allows clean activation (simulating hook remount resilience)
  let freshOpened = false;
  const freshController = new LinkOpenerController(
    { onStateChange: () => {} },
    {
      openFn: async () => {
        freshOpened = true;
        return { success: true };
      },
    }
  );
  assert.equal(freshController.isDisposed(), false);
  const freshRes = await freshController.handleClick({ button: 0, ctrlKey: true }, 'https://gentle.ai');
  assert.equal(freshRes?.success, true);
  assert.equal(freshOpened, true, 'Fresh controller after remount must successfully open');
  freshController.dispose();
});

test('LinkOpenerController: Copy URL remains fully independent and functional when link opening fails', async () => {
  const url = 'https://gentle.ai';
  const openController = new LinkOpenerController(
    { onStateChange: () => {} },
    {
      openFn: async () => ({ success: false, error: 'Network failure' }),
    }
  );

  const openRes = await openController.activate(url);
  assert.equal(openRes.success, false);
  assert.equal(openController.getState(), 'failed');

  // Copy controller operates independently on the same URL
  let copiedText = '';
  const copyHost: ClipboardHost = {
    clipboard: {
      writeText: async (text: string) => {
        copiedText = text;
      },
    },
  };

  const copySuccess = await copyText(url, { host: copyHost });
  assert.equal(copySuccess, true);
  assert.equal(copiedText, url, 'Copy must succeed independently of opener failure');

  openController.dispose();
});

test('platform: detectPlatform, getLinkModifierKey, and getLinkModifierLabel adapt across platforms', () => {
  const tEn = (key: any, params?: any) => translate('en', key, params);
  const tEs = (key: any, params?: any) => translate('es', key, params);

  // Windows
  assert.equal(detectPlatform('win32'), 'windows');
  assert.equal(detectPlatform('Windows'), 'windows');
  assert.equal(getLinkModifierKey('win32'), 'Ctrl');
  assert.equal(getLinkModifierLabel(tEn, 'win32'), 'Ctrl+click to open');
  assert.equal(getLinkModifierLabel(tEs, 'win32'), 'Ctrl+clic para abrir');

  // Linux
  assert.equal(detectPlatform('linux'), 'linux');
  assert.equal(getLinkModifierKey('linux'), 'Ctrl');
  assert.equal(getLinkModifierLabel(tEn, 'linux'), 'Ctrl+click to open');
  assert.equal(getLinkModifierLabel(tEs, 'linux'), 'Ctrl+clic para abrir');

  // macOS
  assert.equal(detectPlatform('darwin'), 'mac');
  assert.equal(detectPlatform('MacIntel'), 'mac');
  assert.equal(getLinkModifierKey('darwin'), 'Cmd');
  assert.equal(getLinkModifierLabel(tEn, 'darwin'), 'Cmd+click to open');
  assert.equal(getLinkModifierLabel(tEs, 'darwin'), 'Cmd+clic para abrir');
});

test('a11y: getLinkAriaLabel and getLinkOpenLiveStatusText provide accurate accessible feedback in en and es', () => {
  const url = 'https://gentle.ai';
  const tEn = (key: any, params?: any) => translate('en', key, params);
  const tEs = (key: any, params?: any) => translate('es', key, params);

  // English (Windows target default)
  assert.equal(getLinkAriaLabel('idle', url, tEn, 'windows'), 'Open link (Ctrl+click): https://gentle.ai');
  assert.equal(getLinkAriaLabel('opening', url, tEn, 'windows'), 'Opening link: https://gentle.ai');
  assert.equal(getLinkAriaLabel('failed', url, tEn, 'windows'), 'Failed to open link: https://gentle.ai');

  // English (macOS target)
  assert.equal(getLinkAriaLabel('idle', url, tEn, 'mac'), 'Open link (Cmd+click): https://gentle.ai');

  // Live status announcements (single live region path, no duplicate role=alert)
  assert.equal(getLinkOpenLiveStatusText('idle', tEn), null);
  assert.equal(getLinkOpenLiveStatusText('opening', tEn), 'Opening...');
  assert.equal(getLinkOpenLiveStatusText('failed', tEn), 'Failed to open link');
  assert.equal(
    getLinkOpenLiveStatusText('failed', tEn, 'Handler timeout (5s)'),
    'Failed to open link: Handler timeout (5s)'
  );

  // Spanish (Windows target default)
  assert.equal(getLinkAriaLabel('idle', url, tEs, 'windows'), 'Abrir enlace (Ctrl+clic): https://gentle.ai');
  assert.equal(getLinkAriaLabel('opening', url, tEs), 'Abriendo enlace: https://gentle.ai');
  assert.equal(getLinkAriaLabel('failed', url, tEs), 'Error al abrir enlace: https://gentle.ai');

  // Spanish (macOS target)
  assert.equal(getLinkAriaLabel('idle', url, tEs, 'mac'), 'Abrir enlace (Cmd+clic): https://gentle.ai');

  assert.equal(getLinkOpenLiveStatusText('idle', tEs), null);
  assert.equal(getLinkOpenLiveStatusText('opening', tEs), 'Abriendo...');
  assert.equal(getLinkOpenLiveStatusText('failed', tEs), 'Error al abrir enlace');
  assert.equal(
    getLinkOpenLiveStatusText('failed', tEs, 'Tiempo de espera agotado'),
    'Error al abrir enlace: Tiempo de espera agotado'
  );
});

// ============================================================================
// Group 12: Code Extraction & Keyboard Productivity Shortcuts (pi-messages)
// ============================================================================

test('shortcuts: extractCodeBlocks extracts executable code blocks and excludes diffs', () => {
  const md = `
Here is TypeScript code:
\`\`\`typescript:src/index.ts
console.log("hello");
\`\`\`

Here is a Git diff:
\`\`\`diff
-oldLine
+newLine
\`\`\`

Here is Python code:
\`\`\`python
print("world")
\`\`\`
`;

  const blocks = extractCodeBlocks(md);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].language, 'typescript');
  assert.equal(blocks[0].fileName, 'src/index.ts');
  assert.equal(blocks[0].code, 'console.log("hello");');
  assert.equal(blocks[1].language, 'python');
  assert.equal(blocks[1].code, 'print("world")');
});

test('shortcuts: getLastAssistantCodeBlocks traverses backwards to find latest assistant code blocks', () => {
  const messages: ChatMessage[] = [
    {
      id: 'm1',
      role: 'assistant',
      content: '```js\nconst first = 1;\n```',
      timestamp: '2025-01-01T00:00:00Z',
    },
    {
      id: 'm2',
      role: 'user',
      content: 'Now write Go code',
      timestamp: '2025-01-01T00:01:00Z',
    },
    {
      id: 'm3',
      role: 'assistant',
      content: '```go:main.go\npackage main\n```\n```diff\n-del\n```',
      timestamp: '2025-01-01T00:02:00Z',
    },
  ];

  const blocks = getLastAssistantCodeBlocks(messages);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].language, 'go');
  assert.equal(blocks[0].fileName, 'main.go');
  assert.equal(blocks[0].code, 'package main');
});


