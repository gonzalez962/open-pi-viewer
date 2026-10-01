import React from 'react';
import type { ToolCallBlock } from '@core/types/messages';
import type { TranslationKey } from '@shared/i18n';

export interface InteractiveQuestionCardProps {
  block: ToolCallBlock;
  onSelectOption?: (label: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

export interface ParsedQuestionOption {
  label: string;
  description?: string;
  preview?: string;
  value?: string;
}

export interface ParsedQuestionItem {
  header?: string;
  question: string;
  options: ParsedQuestionOption[];
  multiSelect?: boolean;
}

/**
 * Normalizes tool arguments from ask_user_question, ask_user_choice,
 * ask_user_confirmation, and question into a uniform structure.
 */
export function parseInteractiveQuestion(block: ToolCallBlock): ParsedQuestionItem[] {
  let args: any = block.args;
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  if (!args || typeof args !== 'object') {
    return [];
  }

  const toolName = (block.name || '').toLowerCase().trim();

  // 1. ask_user_question: { questions: [...] }
  if (Array.isArray(args.questions)) {
    return args.questions.map((q: any) => ({
      header: typeof q.header === 'string' ? q.header : undefined,
      question: typeof q.question === 'string' ? q.question : 'Pregunta del asistente',
      options: Array.isArray(q.options)
        ? q.options.map((opt: any) => ({
            label: typeof opt.label === 'string' ? opt.label : String(opt?.value ?? opt ?? ''),
            description: typeof opt.description === 'string' ? opt.description : undefined,
            preview: typeof opt.preview === 'string' ? opt.preview : undefined,
            value: typeof opt.value === 'string' ? opt.value : undefined,
          }))
        : [],
      multiSelect: Boolean(q.multiSelect),
    }));
  }

  // 2. ask_user_choice or single question: { question, options, header?, allowCustomResponse? }
  if (typeof args.question === 'string') {
    const rawOptions = Array.isArray(args.options) ? args.options : [];
    const options: ParsedQuestionOption[] = rawOptions.map((opt: any) => {
      if (typeof opt === 'string') {
        return { label: opt };
      }
      return {
        label: typeof opt.label === 'string' ? opt.label : String(opt?.value ?? ''),
        description: typeof opt.description === 'string' ? opt.description : undefined,
        preview: typeof opt.preview === 'string' ? opt.preview : undefined,
        value: typeof opt.value === 'string' ? opt.value : undefined,
      };
    });

    return [
      {
        header:
          typeof args.header === 'string'
            ? args.header
            : toolName.includes('choice')
              ? 'Decisión'
              : 'Pregunta',
        question: args.question,
        options,
        multiSelect: Boolean(args.multiSelect),
      },
    ];
  }

  // 3. ask_user_confirmation: { title?, message }
  if (typeof args.message === 'string' || typeof args.title === 'string') {
    return [
      {
        header: typeof args.title === 'string' ? args.title : 'Confirmación',
        question: typeof args.message === 'string' ? args.message : String(args.title),
        options: [
          { label: 'Confirmar', description: 'Proceder con la acción solicitada' },
          { label: 'Cancelar', description: 'Rechazar o abortar la operación' },
        ],
      },
    ];
  }

  return [];
}

/**
 * Interactive Question Card component.
 * Displays user-facing decision questions prominently in the chat history,
 * allowing selection of choices directly from the turn view.
 */
export const InteractiveQuestionCard: React.FC<InteractiveQuestionCardProps> = React.memo(
  ({ block, onSelectOption, t }) => {
    const parsedQuestions = React.useMemo(() => parseInteractiveQuestion(block), [block]);
    const isWaiting = block.status === 'running';
    const isCompleted = block.status === 'completed';
    const output = block.output ? String(block.output).trim() : '';

    if (parsedQuestions.length === 0) {
      return (
        <div className="interactive-question-card fallback">
          <div className="interactive-question-header">
            <span className="interactive-question-badge">❓ {block.name}</span>
            <span className={`interactive-question-status status-${block.status}`}>
              {isWaiting ? t('activity.tool_status_running') : isCompleted ? t('activity.tool_status_completed') : t('process.status_error')}
            </span>
          </div>
          <pre className="interactive-question-raw">
            {typeof block.args === 'string' ? block.args : JSON.stringify(block.args, null, 2)}
          </pre>
        </div>
      );
    }

    return (
      <div className={`interactive-question-card ${isWaiting ? 'is-waiting' : 'is-resolved'}`}>
        {parsedQuestions.map((q, qIndex) => (
          <div key={`question-${qIndex}`} className="interactive-question-item">
            {/* Header with category badge & active status */}
            <div className="interactive-question-header">
              <div className="interactive-question-header-left">
                <span className="interactive-question-icon" aria-hidden="true">💬</span>
                {q.header && (
                  <span className="interactive-question-chip" title={q.header}>
                    {q.header}
                  </span>
                )}
                <span className="interactive-question-title">
                  {t('interactive.question_title')}
                </span>
              </div>
              <div className="interactive-question-header-right">
                <span
                  className={`interactive-question-status status-${block.status}`}
                  title={block.status}
                >
                  {isWaiting ? (
                    <>
                      <span className="interactive-status-dot" aria-hidden="true" />
                      <span>{t('interactive.decision_required')}</span>
                    </>
                  ) : isCompleted ? (
                    <>
                      <span className="interactive-check-icon" aria-hidden="true">✓</span>
                      <span>{t('interactive.answered')}</span>
                    </>
                  ) : (
                    <span>✕ {t('process.status_error')}</span>
                  )}
                </span>
              </div>
            </div>

            {/* Question prompt text */}
            <div className="interactive-question-prompt">
              <p className="interactive-question-text">{q.question}</p>
            </div>

            {/* Options list */}
            {q.options.length > 0 && (
              <div className="interactive-question-options">
                {q.options.map((opt, optIndex) => {
                  const isSelected =
                    output.length > 0 &&
                    (output.includes(opt.label) || (opt.value && output.includes(opt.value)));

                  return (
                    <button
                      key={`opt-${optIndex}`}
                      type="button"
                      className={`interactive-option-btn ${isSelected ? 'is-selected' : ''} ${isWaiting ? 'is-interactive' : ''}`}
                      onClick={() => onSelectOption?.(opt.label)}
                      title={opt.label}
                    >
                      <div className="interactive-option-header">
                        <span className="interactive-option-index">{optIndex + 1}</span>
                        <strong className="interactive-option-label">{opt.label}</strong>
                        {isSelected && (
                          <span className="interactive-option-selected-tag">
                            ✓ {t('interactive.selected')}
                          </span>
                        )}
                      </div>
                      {opt.description && (
                        <p className="interactive-option-description">{opt.description}</p>
                      )}
                      {opt.preview && (
                        <div className="interactive-option-preview">
                          <pre>
                            <code>{opt.preview}</code>
                          </pre>
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            {/* Footer guide notice */}
            {isWaiting && (
              <div className="interactive-question-footer">
                <span className="interactive-hint-text">
                  👉 {t('interactive.click_to_select')}
                </span>
              </div>
            )}

            {/* Output resolution display if completed and not matching option buttons */}
            {output && !q.options.some((o) => output.includes(o.label)) && (
              <div className="interactive-question-output">
                <span className="output-label">{t('interactive.answered')}:</span>
                <span className="output-value">{output}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  }
);
