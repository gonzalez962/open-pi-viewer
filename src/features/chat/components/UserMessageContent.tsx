import React, { useCallback, useMemo } from 'react';
import { parseUserMessageTokens } from '../user-message-links';
import { useLinkOpener } from '@features/chat/hooks/useLinkOpener';
import type { OpenUrlResult } from '@infra/opener';

export interface UserMessageContentProps {
  content: string;
  className?: string;
  onOpenUrl?: (url: string) => Promise<OpenUrlResult>;
}

export interface UserMessageLinkProps {
  href: string;
  children?: React.ReactNode;
  onOpenUrl?: (url: string) => Promise<OpenUrlResult>;
}

/**
 * Accessible user message anchor link reusing useLinkOpener / LinkOpenerController.
 * - Native anchor: receives keyboard focus via Tab, activates on Enter via native click.
 * - Single activation: onClick calls e.preventDefault() and triggers opener (no duplicate onKeyDown).
 * - Debounced & in-flight safe: LinkOpenerController drops concurrent/debounced activations.
 * - Structured failure: updates status to 'failed' and surfaces error gracefully.
 */
export const UserMessageLink: React.FC<UserMessageLinkProps> = ({
  href,
  children,
  onOpenUrl,
}) => {
  const options = useMemo(
    () => (onOpenUrl ? { openFn: onOpenUrl } : undefined),
    [onOpenUrl]
  );
  const { status, error, triggerOpen } = useLinkOpener(href, options);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLAnchorElement>) => {
      // Always prevent native WebView navigation
      e.preventDefault();
      void triggerOpen();
    },
    [triggerOpen]
  );

  const linkClass = [
    'user-message-link',
    status === 'opening' && 'user-message-link-opening',
    status === 'failed' && 'user-message-link-failed',
  ]
    .filter(Boolean)
    .join(' ');

  const linkTitle =
    status === 'failed' && error ? `${href} (${error})` : href;

  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={linkClass}
      onClick={handleClick}
      title={linkTitle}
      aria-busy={status === 'opening'}
    >
      {children}
    </a>
  );
};

/**
 * Renders user message text content with clickable HTTP/HTTPS links.
 * Preserves literal whitespace, escaping, and accessibility.
 * Reuses existing useLinkOpener and LinkOpenerController for debouncing,
 * in-flight activation tracking, and structured error status handling.
 */
export const UserMessageContent: React.FC<UserMessageContentProps> = ({
  content,
  className = 'message-literal',
  onOpenUrl,
}) => {
  const tokens = parseUserMessageTokens(content);

  return (
    <div className={className}>
      {tokens.map((token, index) => {
        if (token.type === 'text') {
          return <React.Fragment key={index}>{token.value}</React.Fragment>;
        }
        return (
          <UserMessageLink
            key={index}
            href={token.href}
            onOpenUrl={onOpenUrl}
          >
            {token.value}
          </UserMessageLink>
        );
      })}
    </div>
  );
};
