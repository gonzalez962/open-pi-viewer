import { isSafeUrl } from '@core/markdown';

export type UserMessageToken =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string; href: string };

export type MessageToken = UserMessageToken;

const SENTENCE_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);

const PAIRED_DELIMITERS: Array<{ open: string; close: string }> = [
  { open: '(', close: ')' },
  { open: '[', close: ']' },
  { open: '{', close: '}' },
  { open: '<', close: '>' },
  { open: '“', close: '”' },
  { open: '‘', close: '’' },
  { open: '«', close: '»' },
];

const SYMMETRIC_DELIMITERS = ['"', "'", '`'];

function countOccurrences(str: string, char: string): number {
  let count = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === char) count++;
  }
  return count;
}

const VALID_OPENING_DELIMITERS = new Set([
  '(', '[', '{', '<',
  '"', "'", '`',
  '“', '‘', '«'
]);

/**
 * Validates that the URL candidate starts at an authentic leading boundary
 * (start of text, whitespace, or standard opening delimiters).
 * Rejects embedded scheme payloads such as `javascript:https://evil.com` or `data:https://...`.
 */
export function hasValidLeadingBoundary(text: string, matchIndex: number): boolean {
  if (matchIndex === 0) {
    return true;
  }

  // Scan backwards from matchIndex across contiguous non-whitespace characters
  let i = matchIndex - 1;
  while (i >= 0 && !/\s/.test(text[i])) {
    if (!VALID_OPENING_DELIMITERS.has(text[i])) {
      // Encountered non-delimiter character (e.g. ':', letter, digit, comma, slash)
      return false;
    }
    i--;
  }

  return true;
}

/**
 * Trims trailing sentence punctuation and unmatched closing delimiters from a URL candidate
 * while preserving balanced parentheses and brackets inside the URL.
 */
export function trimCandidateUrl(candidate: string): {
  url: string;
  trailing: string;
} {
  let cur = candidate;

  while (cur.length > 0) {
    const lastChar = cur[cur.length - 1];

    // 1. Trailing sentence punctuation
    if (SENTENCE_PUNCTUATION.has(lastChar)) {
      cur = cur.slice(0, -1);
      continue;
    }

    // 2. Trailing paired closing delimiters (trim if unmatched)
    const pair = PAIRED_DELIMITERS.find((p) => p.close === lastChar);
    if (pair) {
      if (countOccurrences(cur, pair.close) > countOccurrences(cur, pair.open)) {
        cur = cur.slice(0, -1);
        continue;
      }
    }

    // 3. Trailing symmetric delimiters (trim if unclosed / odd count)
    if (SYMMETRIC_DELIMITERS.includes(lastChar)) {
      if (countOccurrences(cur, lastChar) % 2 !== 0) {
        cur = cur.slice(0, -1);
        continue;
      }
    }

    break;
  }

  return {
    url: cur,
    trailing: candidate.slice(cur.length),
  };
}

/**
 * Validates that a candidate string is a safe HTTP or HTTPS URL.
 * Strictly forbids credentials (user/password) and non-HTTP(S) protocols.
 */
export function isValidHttpUrl(candidate: string): boolean {
  if (!candidate || typeof candidate !== 'string') return false;

  const lower = candidate.toLowerCase();
  if (!lower.startsWith('http://') && !lower.startsWith('https://')) {
    return false;
  }

  if (!isSafeUrl(candidate)) {
    return false;
  }

  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return false;
    }
    if (parsed.username || parsed.password) {
      return false;
    }
    return Boolean(parsed.hostname && parsed.hostname.length > 0);
  } catch {
    return false;
  }
}

/**
 * Pure feature-layer HTTP/HTTPS token parser for user messages.
 * Invariant: tokens.map(t => t.value).join('') === text (original text strictly preserved).
 */
export function parseUserMessageTokens(text: string): UserMessageToken[] {
  if (!text) {
    return [];
  }

  const tokens: UserMessageToken[] = [];
  const regex = /\bhttps?:\/\/[^\s]+/gi;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    const rawCandidate = match[0];
    const matchIndex = match.index;

    // Must be preceded by start-of-string, whitespace, or opening delimiters (not embedded scheme)
    if (!hasValidLeadingBoundary(text, matchIndex)) {
      regex.lastIndex = matchIndex + 7;
      continue;
    }

    const { url } = trimCandidateUrl(rawCandidate);

    if (url.length > 0 && isValidHttpUrl(url)) {
      if (matchIndex > lastIndex) {
        tokens.push({
          type: 'text',
          value: text.slice(lastIndex, matchIndex),
        });
      }
      tokens.push({
        type: 'link',
        value: url,
        href: url,
      });
      lastIndex = matchIndex + url.length;
      regex.lastIndex = lastIndex;
    } else {
      // Advance past the protocol prefix so the regex continues without looping
      regex.lastIndex = matchIndex + 7;
    }
  }

  if (lastIndex < text.length) {
    tokens.push({
      type: 'text',
      value: text.slice(lastIndex),
    });
  }

  return tokens;
}

export const parseUserMessage = parseUserMessageTokens;
