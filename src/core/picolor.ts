/**
 * PiColor — semantic syntax highlighting on top of highlight.js.
 *
 * Pure core module (no React, no Tauri): produces a SAFE token structure — an array of
 * lines, each a list of `{ text, className }` tokens — for React to render as plain text
 * nodes with a className. This module never returns HTML and callers must never feed its
 * output into dangerouslySetInnerHTML; every token's `text` is rendered as a literal
 * React child, so it is escaped automatically.
 *
 * highlight.js/lib/core is used with a bounded set of registered languages (rather than the
 * full bundle) to keep bundle size reasonable. Unknown/unregistered languages fall back to
 * plain (unstyled) tokens, split by line, with the original text fully preserved.
 *
 * Diff/patch content (see `isDiff` in ./markdown) bypasses highlight.js entirely and is
 * colored per line: '+' added, '-' removed, '@@' hunk header, everything else plain.
 */

import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

import { isDiff } from './markdown';

let registered = false;

/**
 * Registers the bounded set of highlight.js languages this app supports. Idempotent and
 * safe to call multiple times (module-level guard); kept as a function rather than
 * top-level side effects so tests can call it deterministically if ever needed.
 */
function ensureLanguagesRegistered(): void {
  if (registered) return;
  hljs.registerLanguage('typescript', typescript);
  hljs.registerLanguage('javascript', javascript);
  hljs.registerLanguage('python', python);
  hljs.registerLanguage('rust', rust);
  hljs.registerLanguage('go', go);
  hljs.registerLanguage('java', java);
  hljs.registerLanguage('ruby', ruby);
  hljs.registerLanguage('php', php);
  hljs.registerLanguage('c', c);
  hljs.registerLanguage('cpp', cpp);
  hljs.registerLanguage('csharp', csharp);
  hljs.registerLanguage('css', css);
  hljs.registerLanguage('scss', scss);
  hljs.registerLanguage('xml', xml);
  hljs.registerLanguage('json', json);
  hljs.registerLanguage('yaml', yaml);
  hljs.registerLanguage('bash', bash);
  hljs.registerLanguage('sql', sql);
  hljs.registerLanguage('kotlin', kotlin);
  hljs.registerLanguage('swift', swift);
  hljs.registerLanguage('markdown', markdown);
  registered = true;
}

/** Normalizes common language aliases to their registered highlight.js name. */
const LANGUAGE_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  py: 'python',
  rb: 'ruby',
  'c++': 'cpp',
  cs: 'csharp',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  html: 'xml',
  htm: 'xml',
  svg: 'xml',
  md: 'markdown',
  kt: 'kotlin',
  kts: 'kotlin',
});

function resolveHljsLanguage(language?: string): string | undefined {
  if (!language) return undefined;
  ensureLanguagesRegistered();
  const lower = language.toLowerCase();
  const normalized = LANGUAGE_ALIASES[lower] ?? lower;
  return hljs.getLanguage(normalized) ? normalized : undefined;
}

/** A single rendered token: literal text plus a CSS className (empty string = no styling). */
export interface CodeToken {
  text: string;
  className: string;
}

/** One rendered source line: its tokens, plus an optional line-level className (diff tint). */
export interface HighlightedLine {
  tokens: CodeToken[];
  lineClassName?: string;
}

function unescapeHtmlEntities(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Maps a highlight.js span class string (e.g. "hljs-title function_") to our syntax token class. */
function mapHljsClass(raw: string): string {
  if (!raw) return '';
  const classes = new Set(raw.split(/\s+/).filter(Boolean));
  if (classes.has('class_') || classes.has('hljs-built_in') || classes.has('hljs-type')) {
    return 'pi-token-type';
  }
  if (classes.has('hljs-title') || classes.has('function_')) {
    return 'pi-token-function';
  }
  if (classes.has('hljs-keyword') || classes.has('hljs-literal')) {
    return 'pi-token-keyword';
  }
  if (
    classes.has('hljs-string') ||
    classes.has('hljs-template-string') ||
    classes.has('hljs-regexp')
  ) {
    return 'pi-token-string';
  }
  if (classes.has('hljs-number')) {
    return 'pi-token-number';
  }
  if (classes.has('hljs-comment') || classes.has('hljs-doctag') || classes.has('hljs-quote')) {
    return 'pi-token-comment';
  }
  if (
    classes.has('hljs-variable') ||
    classes.has('hljs-attr') ||
    classes.has('hljs-attribute') ||
    classes.has('hljs-property') ||
    classes.has('hljs-params') ||
    classes.has('hljs-selector-tag') ||
    classes.has('hljs-selector-class')
  ) {
    return 'pi-token-variable';
  }
  if (classes.has('hljs-punctuation') || classes.has('hljs-operator') || classes.has('hljs-symbol')) {
    return 'pi-token-operator';
  }
  return '';
}

/**
 * Parses highlight.js's HTML output (a constrained grammar of text and
 * `<span class="...">...</span>`, possibly nested) into a flat token list, using the
 * innermost active span's class for each text chunk. Never uses a DOM/HTML parser (core
 * has none available); relies on highlight.js only ever emitting `<span class="...">` and
 * `</span>` around HTML-entity-escaped text.
 */
function parseHljsHtml(html: string): CodeToken[] {
  const tokens: CodeToken[] = [];
  const classStack: string[] = [];
  const len = html.length;
  let i = 0;

  while (i < len) {
    if (html.startsWith('<span class="', i)) {
      const openQuoteEnd = i + '<span class="'.length;
      const closeQuoteIdx = html.indexOf('"', openQuoteEnd);
      const cls = html.slice(openQuoteEnd, closeQuoteIdx);
      const tagEnd = html.indexOf('>', closeQuoteIdx);
      classStack.push(cls);
      i = tagEnd + 1;
      continue;
    }
    if (html.startsWith('</span>', i)) {
      classStack.pop();
      i += '</span>'.length;
      continue;
    }
    const nextLt = html.indexOf('<', i);
    const textEnd = nextLt === -1 ? len : nextLt;
    const rawText = html.slice(i, textEnd);
    if (rawText.length > 0) {
      const currentClass = classStack.length > 0 ? classStack[classStack.length - 1] : '';
      tokens.push({ text: unescapeHtmlEntities(rawText), className: mapHljsClass(currentClass) });
    }
    i = textEnd;
  }

  return tokens;
}

/** Matches: method/function calls (`.ident(`), PascalCase type names, and common operators. */
const ENRICHMENT_REGEX =
  /(\.\s*)([A-Za-z_$][A-Za-z0-9_$]*)(\s*\()|(\b[A-Z][A-Za-z0-9_]*\b)|(:=|===|!==|==|!=|=>|<=|>=|\+=|-=|\*=|\/=|%=|&&|\|\||\+\+|--|\?\?|::|[+\-*/%<>=!&|^~])/g;

/**
 * Sub-tokenizes a plain (unclassified) text chunk to add semantic highlighting highlight.js
 * itself does not provide: method/function calls, PascalCase type names, and universal
 * operators. Only ever applied to chunks highlight.js left unstyled, so it never overrides
 * string/comment/keyword/etc. classification. Guaranteed to reconstruct `text` exactly.
 */
function subTokenizePlainText(text: string): CodeToken[] {
  if (text.length === 0) return [];
  const tokens: CodeToken[] = [];
  let lastIndex = 0;
  ENRICHMENT_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;

  while ((m = ENRICHMENT_REGEX.exec(text)) !== null) {
    if (m.index > lastIndex) {
      tokens.push({ text: text.slice(lastIndex, m.index), className: '' });
    }
    if (m[2] !== undefined) {
      // Method/function call: m[1] = ". " prefix, m[2] = identifier, m[3] = " (" suffix.
      tokens.push({ text: m[1], className: '' });
      tokens.push({ text: m[2], className: 'pi-token-function' });
      tokens.push({ text: m[3], className: '' });
    } else if (m[4] !== undefined) {
      tokens.push({ text: m[4], className: 'pi-token-type' });
    } else if (m[5] !== undefined) {
      tokens.push({ text: m[5], className: 'pi-token-operator' });
    }
    lastIndex = ENRICHMENT_REGEX.lastIndex;
  }
  if (lastIndex < text.length) {
    tokens.push({ text: text.slice(lastIndex), className: '' });
  }
  return tokens.length > 0 ? tokens : [{ text, className: '' }];
}

/**
 * Splits a flat, possibly multi-line token stream into per-line token arrays, applying
 * plain-text enrichment (calls/types/operators) to every unclassified chunk along the way.
 */
function splitTokensIntoLines(flatTokens: CodeToken[]): HighlightedLine[] {
  const lines: HighlightedLine[] = [];
  let current: CodeToken[] = [];

  const pushEnriched = (text: string, className: string) => {
    if (text.length === 0) return;
    if (className === '') {
      current.push(...subTokenizePlainText(text));
    } else {
      current.push({ text, className });
    }
  };

  for (const token of flatTokens) {
    const parts = token.text.split('\n');
    for (let idx = 0; idx < parts.length; idx++) {
      pushEnriched(parts[idx], token.className);
      if (idx < parts.length - 1) {
        lines.push({ tokens: current });
        current = [];
      }
    }
  }
  lines.push({ tokens: current });
  return lines;
}

function highlightDiff(code: string): HighlightedLine[] {
  const lines = code.split('\n');
  return lines.map((line) => {
    let lineClassName: string | undefined;
    let tokenClassName = '';
    if (line.startsWith('@@')) {
      lineClassName = 'pi-diff-line-hunk';
      tokenClassName = 'pi-token-diff-hunk';
    } else if (line.startsWith('+') && !line.startsWith('+++')) {
      lineClassName = 'pi-diff-line-add';
      tokenClassName = 'pi-token-diff-add';
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      lineClassName = 'pi-diff-line-remove';
      tokenClassName = 'pi-token-diff-remove';
    }
    return {
      tokens: [{ text: line, className: tokenClassName }],
      lineClassName,
    };
  });
}

/**
 * Highlights `code` for the given (already sanitized) `language` into a safe array of
 * lines of `{ text, className }` tokens. Diff/patch languages are colored per line
 * (add/remove/hunk); unregistered/unknown languages fall back to plain unstyled lines.
 * Every returned line's token texts, joined, plus '\n' between lines, reconstruct `code`
 * exactly — no characters are ever lost, duplicated, or reordered.
 */
export function highlightCode(code: string, language?: string): HighlightedLine[] {
  if (isDiff(language)) {
    return highlightDiff(code);
  }

  const resolved = resolveHljsLanguage(language);
  if (!resolved) {
    // Unknown/unregistered language: plain tokens only, no semantic enrichment.
    return code.split('\n').map((line) => ({ tokens: [{ text: line, className: '' }] }));
  }

  let html: string;
  try {
    html = hljs.highlight(code, { language: resolved, ignoreIllegals: true }).value;
  } catch {
    return code.split('\n').map((line) => ({ tokens: [{ text: line, className: '' }] }));
  }

  return splitTokensIntoLines(parseHljsHtml(html));
}
