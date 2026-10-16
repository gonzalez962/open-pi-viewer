import { useEffect, useId } from 'react';
import type { TranslationKey } from '@shared/i18n';

export interface WebPushInvitationProps {
  isOpen: boolean;
  isPending: boolean;
  error: string | null;
  onAccept: () => void;
  onDecline: () => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

/**
 * Bottom-docked cookie-style invitation banner prompting to activate WebPush notifications.
 * Direct user gesture on Accept requests browser permissions without a second modal.
 * Decline or Escape dismisses with a persisted 24-hour cooldown.
 */
export function WebPushInvitation({
  isOpen,
  isPending,
  error,
  onAccept,
  onDecline,
  t,
}: WebPushInvitationProps) {
  const titleId = useId();
  const messageId = useId();

  // Escape key dismisses the invitation with cooldown (unless operation is pending)
  useEffect(() => {
    if (!isOpen || typeof window === 'undefined') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !isPending) {
        event.preventDefault();
        onDecline();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, isPending, onDecline]);

  if (!isOpen) return null;

  return (
    <div
      className="web-push-invitation"
      data-testid="web-push-invitation"
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={messageId}
    >
      <div className="web-push-invitation-content">
        <h2 id={titleId} className="web-push-invitation-title">
          {t('settings.web_push_invitation_title')}
        </h2>
        <p id={messageId} className="web-push-invitation-message">
          {t('settings.web_push_invitation_message')}
        </p>
        {error && (
          <p className="web-push-invitation-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="web-push-invitation-actions" aria-busy={isPending}>
        <button
          type="button"
          className="web-push-invitation-decline"
          data-testid="web-push-invitation-decline"
          disabled={isPending}
          onClick={onDecline}
        >
          {t('settings.web_push_invitation_decline')}
        </button>
        <button
          type="button"
          className="web-push-invitation-accept"
          data-testid="web-push-invitation-accept"
          disabled={isPending}
          onClick={onAccept}
        >
          {t(isPending ? 'settings.web_push_invitation_pending' : 'settings.web_push_invitation_accept')}
        </button>
      </div>
    </div>
  );
}
