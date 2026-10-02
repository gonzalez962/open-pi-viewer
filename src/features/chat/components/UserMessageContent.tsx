import React, { useMemo } from 'react';
import { openExternalUrl } from '@infra/opener';

export interface UserMessageContentProps {
  content: string;
}

export interface UserTextToken {
  type: 'text' | 'link';
  value: string;
}

/**
 * Splits user text into plain text and clickable URL tokens.
 * Accurately trims trailing sentence punctuation while preserving full valid URLs.
 */
export function parseUserMessageLinks(text: string): UserTextToken[] {
  if (!text) return [];

  const urlRegex = /(https?:\/\/[^\s<>"'`]+)/g;
  const tokens: UserTextToken[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      tokens.push({
        type: 'text',
        value: text.slice(lastIndex, match.index),
      });
    }

    let rawUrl = match[1];
    let trailingPunct = '';

    while (rawUrl.length > 0 && /[.,;:!?)]/.test(rawUrl[rawUrl.length - 1])) {
      if (rawUrl.endsWith(')')) {
        const openParens = (rawUrl.match(/\(/g) || []).length;
        const closeParens = (rawUrl.match(/\)/g) || []).length;
        if (closeParens > openParens) {
          trailingPunct = rawUrl.slice(-1) + trailingPunct;
          rawUrl = rawUrl.slice(0, -1);
          continue;
        }
        break;
      } else {
        trailingPunct = rawUrl.slice(-1) + trailingPunct;
        rawUrl = rawUrl.slice(0, -1);
      }
    }

    tokens.push({
      type: 'link',
      value: rawUrl,
    });

    if (trailingPunct) {
      tokens.push({
        type: 'text',
        value: trailingPunct,
      });
    }

    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    tokens.push({
      type: 'text',
      value: text.slice(lastIndex),
    });
  }

  // Merge any adjacent text tokens
  const merged: UserTextToken[] = [];
  for (const token of tokens) {
    const prev = merged[merged.length - 1];
    if (prev && prev.type === 'text' && token.type === 'text') {
      prev.value += token.value;
    } else {
      merged.push({ ...token });
    }
  }

  return merged;
}

/**
 * Renders user message content with safe autolinked URLs.
 * Plain text is safely escaped by React JSX, and URLs are made clickable.
 */
export const UserMessageContent: React.FC<UserMessageContentProps> = React.memo(({ content }) => {
  const tokens = useMemo(() => parseUserMessageLinks(content), [content]);

  const handleLinkClick = (e: React.MouseEvent, url: string) => {
    e.preventDefault();
    e.stopPropagation();
    void openExternalUrl(url);
  };

  return (
    <div className="message-literal">
      {tokens.map((token, index) => {
        if (token.type === 'link') {
          return (
            <a
              key={`user-link-${index}`}
              href={token.value}
              target="_blank"
              rel="noopener noreferrer"
              className="user-message-link"
              onClick={(e) => handleLinkClick(e, token.value)}
              title={token.value}
            >
              {token.value}
            </a>
          );
        }
        return <React.Fragment key={`user-text-${index}`}>{token.value}</React.Fragment>;
      })}
    </div>
  );
});
