import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AnsweredQuestionRecord,
  QueuedExtensionUiDialog,
} from '../hooks/useExtensionUiDialog';
import {
  cleanQuestionText,
  isBackOptionLabel,
  parseMultiSelectOptions,
  parseQuestionStepInfo,
} from '../hooks/useExtensionUiDialog';

const REVIEW_SUMMARY_TITLE = 'Vista previa de respuestas antes de enviar al agente';

export interface ExtensionUiPromptBarProps {
  dialog: QueuedExtensionUiDialog;
  pendingCount?: number;
  canGoBack?: boolean;
  flowAnswers?: AnsweredQuestionRecord[];
  onBack?: (
    itemKey: string,
    targetStep?: number,
    currentDraft?: Partial<AnsweredQuestionRecord>
  ) => void;
  onSelect: (itemKey: string, choice: string) => void;
  onMultiSelectSubmit: (itemKey: string, desiredToggled: boolean[]) => void;
  onInput: (itemKey: string, value: string) => void;
  onConfirm: (itemKey: string, confirmed: boolean) => void;
  onCancel: (itemKey: string) => void;
  initialSelectedIndex?: number;
  initialCheckedIndices?: number[];
  initialReviewingSummary?: boolean;
  initialModifyingStep?: number | null;
  initialIsNavigatingBack?: boolean;
}

/**
 * In-place prompt bar replacing the chat footer prompt form during active extension UI requests.
 * Supports multi-choice option toggling without round-trip re-renders, standard single select chips,
 * text input prompts, and confirmation dialogs with safe defaults and keyboard navigation.
 */
export function isOptionCustom(opt: string, idx: number, total: number): boolean {
  if (!opt) return false;
  const lower = opt.toLowerCase().trim();
  return (
    lower.includes('type something') ||
    lower.includes('personaliz') ||
    lower.includes('custom') ||
    lower.includes('otro') ||
    lower.includes('otra') ||
    lower.includes('other') ||
    (idx === total - 1 && (lower.endsWith('...') || lower.includes('escrib') || lower.includes('texto')))
  );
}

export const ExtensionUiPromptBar: React.FC<ExtensionUiPromptBarProps> = ({
  dialog,
  pendingCount = 1,
  canGoBack = false,
  flowAnswers,
  onBack,
  onSelect,
  onMultiSelectSubmit,
  onInput,
  onConfirm,
  onCancel,
  initialSelectedIndex,
  initialCheckedIndices,
  initialReviewingSummary,
  initialModifyingStep,
  initialIsNavigatingBack,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const negativeBtnRef = useRef<HTMLButtonElement>(null);
  const affirmativeBtnRef = useRef<HTMLButtonElement>(null);
  const doneBtnRef = useRef<HTMLButtonElement>(null);
  const checkboxRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);

  const { itemKey, method, request, expiresAt } = dialog;

  const stepInfo = useMemo(() => parseQuestionStepInfo(request.title), [request.title]);
  const { isMultiStep, currentStep, totalSteps } = stepInfo;
  const isMultiStepFlow = isMultiStep && totalSteps > 1;

  const canReviewSummary = useMemo(() => {
    if (!isMultiStepFlow) return false;
    if (!flowAnswers || flowAnswers.length === 0) return false;
    for (let s = 1; s <= totalSteps; s++) {
      if (s !== currentStep && !flowAnswers.some((a) => a.step === s)) {
        return false;
      }
    }
    return true;
  }, [isMultiStepFlow, flowAnswers, currentStep, totalSteps]);

  const [isReviewingSummary, setIsReviewingSummary] = useState<boolean>(
    initialReviewingSummary ?? false
  );
  const [modifyingStep, setModifyingStep] = useState<number | null>(
    initialModifyingStep ?? null
  );
  const [isNavigatingBack, setIsNavigatingBack] = useState<boolean>(
    initialIsNavigatingBack ?? false
  );
  const [isSubmittingFinal, setIsSubmittingFinal] = useState<boolean>(false);

  useEffect(() => {
    setIsReviewingSummary(initialReviewingSummary ?? false);
  }, [itemKey, initialReviewingSummary]);

  // Multi-select analysis for 'select' method
  const multiSelect = useMemo(() => {
    if (method !== 'select') {
      return { isMultiSelect: false, choices: [], doneOption: '' };
    }
    return parseMultiSelectOptions(request.options);
  }, [method, request.options]);

  const isMultiSelect = multiSelect.isMultiSelect;
  const singleSelectOptions = useMemo(() => {
    if (!request.options) return [];
    if ((canGoBack || currentStep > 1) && request.options.length > 1) {
      const last = request.options[request.options.length - 1];
      if (isBackOptionLabel(last)) {
        return request.options.slice(0, -1);
      }
    }
    return request.options;
  }, [request.options, canGoBack, currentStep]);

  // Local state for multi-select checkboxes
  const [checkedIndices, setCheckedIndices] = useState<Set<number>>(() => {
    if (initialCheckedIndices !== undefined) {
      return new Set(initialCheckedIndices);
    }
    const saved = flowAnswers?.find((r) => r.step === currentStep);
    if (saved?.selectedLabels && saved.selectedLabels.length > 0) {
      const indices = new Set<number>();
      multiSelect.choices.forEach((choice, idx) => {
        if (
          saved.selectedLabels!.some(
            (label) => label.trim().toLowerCase() === choice.label.trim().toLowerCase()
          )
        ) {
          indices.add(idx);
        }
      });
      return indices;
    }
    return new Set<number>();
  });

  // Focused index for keyboard navigation in multi-select
  const [focusedChoiceIndex, setFocusedChoiceIndex] = useState<number>(0);

  // Selected index for single-select chips
  const [selectedOptionIndex, setSelectedOptionIndex] = useState<number>(() => {
    if (initialSelectedIndex !== undefined) {
      return initialSelectedIndex;
    }
    const saved = flowAnswers?.find((r) => r.step === currentStep);
    const target = saved?.singleChoice || saved?.answerText;
    if (target) {
      const normalizedTarget = target.trim().toLowerCase();
      const idx = singleSelectOptions.findIndex(
        (o) => o.trim().toLowerCase() === normalizedTarget
      );
      if (idx !== -1) return idx;
    }
    return -1;
  });

  const [customOptionText, setCustomOptionText] = useState<string>('');
  const [isTypingCustomOption, setIsTypingCustomOption] = useState<boolean>(false);

  // Value for input dialog
  const [inputValue, setInputValue] = useState<string>(() => {
    const saved = flowAnswers?.find((r) => r.step === currentStep);
    if (saved?.inputValue !== undefined) {
      return saved.inputValue;
    }
    return request.prefill ?? '';
  });

  // Value for confirm dialog
  const [confirmValue, setConfirmValue] = useState<boolean | null>(() => {
    const saved = flowAnswers?.find((r) => r.step === currentStep);
    if (saved?.confirmValue !== undefined) {
      return saved.confirmValue;
    }
    return null;
  });

  // Synchronous render-phase state adjustment when transitioning dialog itemKey
  const [prevItemKey, setPrevItemKey] = useState<string>(itemKey);

  if (itemKey !== prevItemKey) {
    setPrevItemKey(itemKey);
    setModifyingStep(null);
    setIsNavigatingBack(false);
    setIsSubmittingFinal(false);
    setCustomOptionText('');
    setIsTypingCustomOption(false);

    const savedRecord = flowAnswers?.find((r) => r.step === currentStep);

    // Multi-select
    if (initialCheckedIndices !== undefined) {
      setCheckedIndices(new Set(initialCheckedIndices));
    } else if (savedRecord?.selectedLabels && savedRecord.selectedLabels.length > 0) {
      const indices = new Set<number>();
      multiSelect.choices.forEach((choice, idx) => {
        if (
          savedRecord.selectedLabels!.some(
            (label) => label.trim().toLowerCase() === choice.label.trim().toLowerCase()
          )
        ) {
          indices.add(idx);
        }
      });
      setCheckedIndices(indices);
    } else {
      setCheckedIndices(new Set<number>());
    }

    // Single-select
    if (initialSelectedIndex !== undefined) {
      setSelectedOptionIndex(initialSelectedIndex);
    } else {
      const target = savedRecord?.singleChoice || savedRecord?.answerText;
      if (target) {
        const normalizedTarget = target.trim().toLowerCase();
        const idx = singleSelectOptions.findIndex(
          (o) => o.trim().toLowerCase() === normalizedTarget
        );
        setSelectedOptionIndex(idx);
      } else {
        setSelectedOptionIndex(-1);
      }
    }

    // Input
    if (savedRecord?.inputValue !== undefined) {
      setInputValue(savedRecord.inputValue);
    } else {
      setInputValue(request.prefill ?? '');
    }

    // Confirm
    if (savedRecord?.confirmValue !== undefined) {
      setConfirmValue(savedRecord.confirmValue);
    } else {
      setConfirmValue(null);
    }

    setIsReviewingSummary(initialReviewingSummary ?? false);
    setFocusedChoiceIndex(0);
  }

  // Reset or restore local state when dialog itemKey, currentStep, or prefill changes
  useEffect(() => {
    setModifyingStep(null);
    setIsNavigatingBack(false);
    setIsSubmittingFinal(false);
    const savedRecord = flowAnswers?.find((r) => r.step === currentStep);

    // Multi-select
    if (initialCheckedIndices !== undefined) {
      setCheckedIndices(new Set(initialCheckedIndices));
    } else if (savedRecord?.selectedLabels && savedRecord.selectedLabels.length > 0) {
      const indices = new Set<number>();
      multiSelect.choices.forEach((choice, idx) => {
        if (
          savedRecord.selectedLabels!.some(
            (label) => label.trim().toLowerCase() === choice.label.trim().toLowerCase()
          )
        ) {
          indices.add(idx);
        }
      });
      setCheckedIndices(indices);
    } else {
      setCheckedIndices(new Set<number>());
    }

    // Single-select
    if (initialSelectedIndex !== undefined) {
      setSelectedOptionIndex(initialSelectedIndex);
    } else {
      const target = savedRecord?.singleChoice || savedRecord?.answerText;
      if (target) {
        const normalizedTarget = target.trim().toLowerCase();
        const idx = singleSelectOptions.findIndex(
          (o) => o.trim().toLowerCase() === normalizedTarget
        );
        setSelectedOptionIndex(idx);
      } else {
        setSelectedOptionIndex(-1);
      }
    }

    // Input
    if (savedRecord?.inputValue !== undefined) {
      setInputValue(savedRecord.inputValue);
    } else {
      setInputValue(request.prefill ?? '');
    }

    // Confirm
    if (savedRecord?.confirmValue !== undefined) {
      setConfirmValue(savedRecord.confirmValue);
    } else {
      setConfirmValue(null);
    }

    setFocusedChoiceIndex(0);
  }, [
    itemKey,
    currentStep,
    flowAnswers,
    request.prefill,
    initialSelectedIndex,
    initialCheckedIndices,
    multiSelect.choices,
    singleSelectOptions,
  ]);

  // Remaining seconds countdown calculation
  const calculateRemainingSeconds = useCallback((): number | null => {
    if (!expiresAt) return null;
    const diff = expiresAt - Date.now();
    return diff > 0 ? Math.ceil(diff / 1000) : 0;
  }, [expiresAt]);

  const [secondsLeft, setSecondsLeft] = useState<number | null>(calculateRemainingSeconds);

  useEffect(() => {
    if (!expiresAt) {
      setSecondsLeft(null);
      return;
    }
    setSecondsLeft(calculateRemainingSeconds());
    const intervalId = setInterval(() => {
      setSecondsLeft(calculateRemainingSeconds());
    }, 500);
    return () => clearInterval(intervalId);
  }, [expiresAt, calculateRemainingSeconds]);

  // Initial focus management
  useEffect(() => {
    const timerId = setTimeout(() => {
      if (method === 'confirm' || method === 'select') {
        containerRef.current?.focus();
      } else if (method === 'input') {
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }, 0);

    return () => clearTimeout(timerId);
  }, [itemKey, method]);

  // Multi-select toggle action (client-only local state change)
  const toggleChoice = useCallback((index: number) => {
    setCheckedIndices((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  // Multi-select submit action (called on "Done" button or Enter)
  const handleDoneMultiSelect = useCallback(() => {
    if (checkedIndices.size === 0) {
      return;
    }
    const desired = multiSelect.choices.map((_, i) => checkedIndices.has(i));
    onMultiSelectSubmit(itemKey, desired);
  }, [itemKey, multiSelect.choices, checkedIndices, onMultiSelectSubmit]);

  const currentAnswerText = useMemo(() => {
    if (method === 'select') {
      if (isMultiSelect) {
        const selected = Array.from(checkedIndices)
          .map((i) => multiSelect.choices[i]?.label)
          .filter(Boolean);
        return selected.length > 0 ? selected.join(', ') : '(Ninguna)';
      }
      if (selectedOptionIndex >= 0 && selectedOptionIndex < singleSelectOptions.length) {
        return singleSelectOptions[selectedOptionIndex];
      }
      return '';
    }
    if (method === 'input') {
      return inputValue;
    }
    if (method === 'confirm') {
      return confirmValue === null ? '' : (confirmValue ? 'Sí' : 'No');
    }
    return '';
  }, [
    method,
    isMultiSelect,
    checkedIndices,
    multiSelect.choices,
    selectedOptionIndex,
    singleSelectOptions,
    inputValue,
    confirmValue,
  ]);

  const defaultTitle = useMemo(() => {
    if (method === 'select') {
      return isMultiSelect ? 'Select options' : 'Select an option';
    }
    if (method === 'input') return 'Input required';
    if (method === 'confirm') return 'Confirmation';
    return 'Extension Prompt';
  }, [method, isMultiSelect]);

  const displayTitle = useMemo(() => {
    const raw =
      stepInfo.cleanTitle ||
      cleanQuestionText(request.title) ||
      cleanQuestionText(request.message) ||
      defaultTitle;
    return cleanQuestionText(raw) || defaultTitle;
  }, [stepInfo.cleanTitle, request.title, request.message, defaultTitle]);

  const title = displayTitle;

  const allSummaryItems = useMemo(() => {
    const map = new Map<number, AnsweredQuestionRecord>();
    if (flowAnswers) {
      for (const record of flowAnswers) {
        map.set(record.step, {
          ...record,
          question: cleanQuestionText(record.question) || record.question,
        });
      }
    }
    const currentQuestionText =
      cleanQuestionText(displayTitle) ||
      cleanQuestionText(stepInfo.cleanTitle) ||
      cleanQuestionText(request.title) ||
      cleanQuestionText(request.message) ||
      `Pregunta ${currentStep}`;
    map.set(currentStep, {
      step: currentStep,
      question: currentQuestionText,
      answerText: currentAnswerText,
    });
    return Array.from(map.values()).sort((a, b) => a.step - b.step);
  }, [
    flowAnswers,
    currentStep,
    displayTitle,
    stepInfo.cleanTitle,
    request.title,
    request.message,
    currentAnswerText,
  ]);

  const getCurrentDraft = useCallback((): Partial<AnsweredQuestionRecord> | undefined => {
    const currentQuestionText =
      cleanQuestionText(displayTitle) ||
      cleanQuestionText(stepInfo.cleanTitle) ||
      cleanQuestionText(request.title) ||
      cleanQuestionText(request.message) ||
      `Pregunta ${currentStep}`;

    if (method === 'select') {
      if (isMultiSelect) {
        if (checkedIndices.size > 0) {
          const selected = Array.from(checkedIndices)
            .map((i) => multiSelect.choices[i]?.label)
            .filter(Boolean);
          return {
            step: currentStep,
            question: currentQuestionText,
            answerText: selected.join(', '),
            selectedLabels: selected,
          };
        }
      } else {
        if (isTypingCustomOption && customOptionText.trim()) {
          const val = customOptionText.trim();
          return {
            step: currentStep,
            question: currentQuestionText,
            answerText: val,
            singleChoice: val,
          };
        }
        if (selectedOptionIndex >= 0 && selectedOptionIndex < singleSelectOptions.length) {
          const choice = singleSelectOptions[selectedOptionIndex];
          return {
            step: currentStep,
            question: currentQuestionText,
            answerText: choice,
            singleChoice: choice,
          };
        }
      }
    } else if (method === 'input') {
      if (inputValue.trim().length > 0) {
        return {
          step: currentStep,
          question: currentQuestionText,
          answerText: inputValue,
          inputValue,
        };
      }
    } else if (method === 'confirm') {
      if (confirmValue !== null) {
        return {
          step: currentStep,
          question: currentQuestionText,
          answerText: confirmValue ? 'Sí' : 'No',
          confirmValue,
        };
      }
    }
    return undefined;
  }, [
    displayTitle,
    stepInfo.cleanTitle,
    request.title,
    request.message,
    currentStep,
    method,
    isMultiSelect,
    checkedIndices,
    multiSelect.choices,
    selectedOptionIndex,
    singleSelectOptions,
    inputValue,
    confirmValue,
  ]);

  const handleBackClick = useCallback(
    (targetStep?: number) => {
      setIsNavigatingBack(true);
      if (onBack) {
        onBack(itemKey, targetStep, getCurrentDraft());
      }
    },
    [onBack, itemKey, getCurrentDraft]
  );

  const handleFinalSubmit = useCallback(() => {
    setIsSubmittingFinal(true);
    if (method === 'select') {
      if (isMultiSelect) {
        if (checkedIndices.size === 0) return;
        handleDoneMultiSelect();
      } else {
        if (selectedOptionIndex >= 0 && selectedOptionIndex < singleSelectOptions.length) {
          onSelect(itemKey, singleSelectOptions[selectedOptionIndex]);
        }
      }
    } else if (method === 'input') {
      if (inputValue.trim().length === 0) return;
      onInput(itemKey, inputValue);
    } else if (method === 'confirm') {
      onConfirm(itemKey, confirmValue ?? true);
    }
  }, [
    method,
    isMultiSelect,
    checkedIndices.size,
    handleDoneMultiSelect,
    selectedOptionIndex,
    singleSelectOptions,
    onSelect,
    itemKey,
    onInput,
    inputValue,
    onConfirm,
    confirmValue,
  ]);

  const handleModifyQuestion = useCallback(
    (step: number) => {
      if (step === currentStep) {
        setIsReviewingSummary(false);
      } else {
        setModifyingStep(step);
        if (onBack) {
          onBack(itemKey, step, getCurrentDraft());
        }
      }
    },
    [currentStep, onBack, itemKey, getCurrentDraft]
  );

  // Keyboard navigation listener
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Escape key cancels dialog
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel(itemKey);
        return;
      }

      // If in summary review view
      if (isReviewingSummary) {
        if (e.key === 'Enter') {
          e.preventDefault();
          if (isSubmittingFinal || modifyingStep !== null) return;
          handleFinalSubmit();
          return;
        }
        if (e.key === 'Backspace' || e.key === 'ArrowLeft') {
          e.preventDefault();
          if (isSubmittingFinal || modifyingStep !== null) return;
          setIsReviewingSummary(false);
          return;
        }
        return;
      }

      // Input dialog keyboard behavior: let normal typing occur
      if (method === 'input') {
        if ((canGoBack || currentStep > 1) && onBack && inputValue === '' && (e.key === 'Backspace' || e.key === 'ArrowLeft')) {
          e.preventDefault();
          handleBackClick();
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          if (inputValue.trim().length === 0) {
            return;
          }
          if (isMultiStepFlow) {
            if (currentStep < totalSteps) {
              onInput(itemKey, inputValue);
            } else {
              setIsReviewingSummary(true);
            }
          } else {
            onInput(itemKey, inputValue);
          }
        }
        return;
      }

      // Confirm dialog keyboard navigation
      if (method === 'confirm') {
        if ((canGoBack || currentStep > 1) && onBack && e.key === 'Backspace') {
          e.preventDefault();
          handleBackClick();
          return;
        }
        if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Tab') {
          e.preventDefault();
          if (document.activeElement === negativeBtnRef.current) {
            affirmativeBtnRef.current?.focus();
          } else {
            negativeBtnRef.current?.focus();
          }
          return;
        }
        if (e.key === 'Enter') {
          const activeEl = document.activeElement as HTMLElement | null;
          if (activeEl === affirmativeBtnRef.current) {
            return;
          }
          if (activeEl === negativeBtnRef.current) {
            return;
          }
          if (activeEl && (activeEl.classList.contains('btn-extension-prompt-cancel') || activeEl.classList.contains('btn-extension-prompt-secondary'))) {
            return;
          }
          e.preventDefault();
          if (confirmValue === null) {
            return;
          }
          if (isMultiStepFlow) {
            if (currentStep < totalSteps) {
              onConfirm(itemKey, confirmValue);
            } else {
              setIsReviewingSummary(true);
            }
          } else {
            onConfirm(itemKey, confirmValue);
          }
          return;
        }
        if (e.key === '1' || e.key === 'y' || e.key === 'Y' || e.key === 's' || e.key === 'S') {
          e.preventDefault();
          setConfirmValue(true);
          if (isMultiStepFlow) {
            if (currentStep < totalSteps) {
              onConfirm(itemKey, true);
            } else {
              setIsReviewingSummary(true);
            }
          } else {
            onConfirm(itemKey, true);
          }
          return;
        }
        if (e.key === '2' || e.key === 'n' || e.key === 'N') {
          e.preventDefault();
          setConfirmValue(false);
          if (isMultiStepFlow) {
            if (currentStep < totalSteps) {
              onConfirm(itemKey, false);
            } else {
              setIsReviewingSummary(true);
            }
          } else {
            onConfirm(itemKey, false);
          }
          return;
        }
        return;
      }

      // Multi-select keyboard navigation
      if (method === 'select' && isMultiSelect) {
        if ((canGoBack || currentStep > 1) && onBack && e.key === 'Backspace') {
          e.preventDefault();
          handleBackClick();
          return;
        }
        const choiceCount = multiSelect.choices.length;
        if (choiceCount > 0) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
            e.preventDefault();
            const nextIdx = (focusedChoiceIndex + 1) % choiceCount;
            setFocusedChoiceIndex(nextIdx);
            checkboxRefs.current[nextIdx]?.focus();
            return;
          }
          if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
            e.preventDefault();
            const prevIdx = (focusedChoiceIndex - 1 + choiceCount) % choiceCount;
            setFocusedChoiceIndex(prevIdx);
            checkboxRefs.current[prevIdx]?.focus();
            return;
          }
          if (e.key === ' ' || e.code === 'Space') {
            // Space toggles focused choice if not on a button other than checkbox
            const activeEl = document.activeElement as HTMLElement | null;
            if (activeEl && (activeEl.classList.contains('btn-extension-prompt-cancel') || activeEl.classList.contains('btn-extension-prompt-secondary') || activeEl.classList.contains('btn-extension-prompt-done') || activeEl.classList.contains('btn-extension-prompt-primary'))) {
              return;
            }
            e.preventDefault();
            toggleChoice(focusedChoiceIndex);
            return;
          }
          if (e.key === 'Enter') {
            const activeEl = document.activeElement as HTMLElement | null;
            if (activeEl && (activeEl.classList.contains('btn-extension-prompt-cancel') || activeEl.classList.contains('btn-extension-prompt-secondary'))) {
              return;
            }
            e.preventDefault();
            if (checkedIndices.size === 0) {
              return;
            }
            if (isMultiStepFlow) {
              if (currentStep < totalSteps) {
                handleDoneMultiSelect();
              } else {
                setIsReviewingSummary(true);
              }
            } else {
              handleDoneMultiSelect();
            }
            return;
          }
          if (/^[1-9]$/.test(e.key)) {
            const digit = parseInt(e.key, 10);
            if (digit >= 1 && digit <= choiceCount) {
              e.preventDefault();
              toggleChoice(digit - 1);
              setFocusedChoiceIndex(digit - 1);
              checkboxRefs.current[digit - 1]?.focus();
              return;
            }
          }
        }
        return;
      }

      // Single-select keyboard navigation
      if (method === 'select' && !isMultiSelect && singleSelectOptions.length > 0) {
        if (isTypingCustomOption) {
          if (e.key === 'Escape') {
            e.preventDefault();
            setIsTypingCustomOption(false);
            return;
          }
          if (e.key === 'Enter') {
            e.preventDefault();
            const val = customOptionText.trim();
            if (val) {
              if (isMultiStepFlow) {
                if (currentStep < totalSteps) {
                  onSelect(itemKey, val);
                } else {
                  setIsReviewingSummary(true);
                }
              } else {
                onSelect(itemKey, val);
              }
            }
            return;
          }
          return;
        }

        if ((canGoBack || currentStep > 1) && onBack && (e.key === 'Backspace' || (e.key === 'ArrowLeft' && selectedOptionIndex === -1))) {
          e.preventDefault();
          handleBackClick();
          return;
        }
        const optCount = singleSelectOptions.length;
        if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
          e.preventDefault();
          const nextIdx = selectedOptionIndex === -1 ? 0 : (selectedOptionIndex + 1) % optCount;
          setSelectedOptionIndex(nextIdx);
          optionRefs.current[nextIdx]?.focus();
          return;
        }
        if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const prevIdx = selectedOptionIndex === -1 ? optCount - 1 : (selectedOptionIndex - 1 + optCount) % optCount;
          setSelectedOptionIndex(prevIdx);
          optionRefs.current[prevIdx]?.focus();
          return;
        }
        if (e.key === 'Enter') {
          const activeEl = document.activeElement as HTMLElement | null;
          if (activeEl && (activeEl.classList.contains('btn-extension-prompt-cancel') || activeEl.classList.contains('btn-extension-prompt-secondary'))) {
            return;
          }
          e.preventDefault();
          if (selectedOptionIndex < 0) {
            return;
          }
          if (selectedOptionIndex >= 0 && selectedOptionIndex < optCount) {
            if (isMultiStepFlow) {
              if (currentStep < totalSteps) {
                onSelect(itemKey, singleSelectOptions[selectedOptionIndex]);
              } else {
                setIsReviewingSummary(true);
              }
            } else {
              onSelect(itemKey, singleSelectOptions[selectedOptionIndex]);
            }
          }
          return;
        }
        if (/^[1-9]$/.test(e.key)) {
          const digit = parseInt(e.key, 10);
          if (digit >= 1 && digit <= optCount) {
            e.preventDefault();
            setSelectedOptionIndex(digit - 1);
            optionRefs.current[digit - 1]?.focus();
            return;
          }
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [
    itemKey,
    method,
    isMultiSelect,
    multiSelect.choices,
    singleSelectOptions,
    focusedChoiceIndex,
    selectedOptionIndex,
    checkedIndices.size,
    inputValue,
    canGoBack,
    currentStep,
    totalSteps,
    isMultiStepFlow,
    isReviewingSummary,
    onBack,
    handleBackClick,
    toggleChoice,
    handleDoneMultiSelect,
    handleFinalSubmit,
    onSelect,
    onInput,
    onConfirm,
    onCancel,
    confirmValue,
  ]);

  const message = useMemo(() => {
    if (!request.message) return undefined;
    const cleaned = cleanQuestionText(request.message);
    if (!cleaned || cleaned.toLowerCase() === displayTitle.toLowerCase()) {
      return undefined;
    }
    return cleaned;
  }, [request.message, displayTitle]);
  const headerTitle = isReviewingSummary ? REVIEW_SUMMARY_TITLE : displayTitle;

  const singlePrimaryButtonLabel = useMemo(() => {
    return isMultiStepFlow
      ? (currentStep < totalSteps ? 'Siguiente →' : 'Revisar respuestas →')
      : 'Enviar selección';
  }, [isMultiStepFlow, currentStep, totalSteps]);

  const multiPrimaryButtonLabel = useMemo(() => {
    return isMultiStepFlow
      ? (currentStep < totalSteps ? 'Siguiente →' : 'Revisar respuestas →')
      : `Done (${checkedIndices.size} selected)`;
  }, [isMultiStepFlow, currentStep, totalSteps, checkedIndices.size]);

  const inputPrimaryButtonLabel = useMemo(() => {
    return isMultiStepFlow
      ? (currentStep < totalSteps ? 'Siguiente →' : 'Revisar respuestas →')
      : 'Submit';
  }, [isMultiStepFlow, currentStep, totalSteps]);

  return (
    <div
      className={`extension-prompt-bar ${isNavigatingBack || modifyingStep !== null ? 'is-transitioning' : ''}`.trim()}
      ref={containerRef}
      role="region"
      aria-label={`Extension prompt: ${headerTitle}`}
      tabIndex={-1}
    >
      <div className="extension-prompt-header">
        <div className="extension-prompt-header-left">
          {isReviewingSummary ? (
            <span className="extension-prompt-badge badge-summary">
              Revisión
            </span>
          ) : (
            isMultiStepFlow && (
              <span className="extension-prompt-badge badge-step">
                {`${currentStep}/${totalSteps}`}
              </span>
            )
          )}
          <h3 id="extension-prompt-title" className="extension-prompt-title">
            {headerTitle}
          </h3>
          {pendingCount > 1 && (
            <div className="extension-prompt-meta">
              <span className="extension-prompt-queue-badge">
                1 of {pendingCount} queued
              </span>
            </div>
          )}
        </div>

        <div className="extension-prompt-header-right">
          {secondsLeft !== null && (
            <span
              className="extension-prompt-timeout"
              aria-live="polite"
              title="Dialog will automatically cancel when time expires"
            >
              ⏱️ {secondsLeft}s
            </span>
          )}
          <button
            type="button"
            className="btn-extension-prompt-cancel"
            onClick={() => onCancel(itemKey)}
            title="Cancel prompt (Esc)"
            aria-label="Cancel prompt"
          >
            ✕
          </button>
        </div>
      </div>

      {!isReviewingSummary && message && (
        <div id="extension-prompt-message" className="extension-prompt-message">
          {message}
        </div>
      )}

      <div className="extension-prompt-body">
        {isReviewingSummary ? (
          <div className="extension-prompt-summary-view">
            <div className="extension-prompt-summary-header">
              <p className="extension-prompt-summary-subtitle">
                Verifica todas las preguntas y respuestas antes de enviarlas al agente. Puedes modificarlas o confirmar el envío:
              </p>
            </div>
            <div className="extension-prompt-summary-list">
              {allSummaryItems.map((item, idx) => (
                <div key={idx} className="extension-prompt-summary-item">
                  <div className="summary-item-content">
                    <span className="summary-item-num">{idx + 1}.</span>
                    <div className="summary-item-text">
                      <span className="summary-item-q">{item.question}</span>
                      <div className="summary-item-answer-row">
                        <strong className="summary-item-a">{item.answerText}</strong>
                        <button
                          type="button"
                          className="btn-extension-prompt-modify"
                          disabled={modifyingStep !== null || isSubmittingFinal}
                          onClick={() => handleModifyQuestion(item.step)}
                        >
                          {modifyingStep === item.step ? 'Cargando...' : 'Modificar'}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <div className="extension-prompt-footer-actions">
              <button
                type="button"
                className="btn-extension-prompt-primary"
                disabled={modifyingStep !== null || isSubmittingFinal}
                onClick={handleFinalSubmit}
              >
                {isSubmittingFinal ? 'Enviando al agente...' : 'Confirmar y enviar al agente'}
              </button>
              <button
                type="button"
                className="btn-extension-prompt-secondary"
                disabled={modifyingStep !== null || isSubmittingFinal}
                onClick={() => setIsReviewingSummary(false)}
              >
                Modificar selección
              </button>
              <button
                type="button"
                className="btn-extension-prompt-secondary"
                disabled={modifyingStep !== null || isSubmittingFinal}
                onClick={() => onCancel(itemKey)}
              >
                Cancelar
              </button>
            </div>
          </div>
        ) : (
          <div key={itemKey} className="extension-prompt-step-content">
            {/* Multi-Select Checkboxes */}
            {method === 'select' && isMultiSelect && (
              <div className="extension-prompt-multiselect-container">
                <div
                  className="extension-prompt-checkbox-list"
                  role="group"
                  aria-label={title}
                >
                  {multiSelect.choices.map((choice, idx) => {
                    const isChecked = checkedIndices.has(idx);
                    const isFocused = focusedChoiceIndex === idx;
                    const shortcutNum = idx < 9 ? idx + 1 : null;
                    return (
                      <button
                        key={`${idx}-${choice.raw}`}
                        ref={(el) => {
                          checkboxRefs.current[idx] = el;
                        }}
                        type="button"
                        role="checkbox"
                        aria-checked={isChecked}
                        className={`extension-prompt-checkbox-item ${
                          isChecked ? 'is-checked' : ''
                        } ${isFocused ? 'is-focused' : ''}`}
                        onClick={() => {
                          toggleChoice(idx);
                          setFocusedChoiceIndex(idx);
                        }}
                        onFocus={() => setFocusedChoiceIndex(idx)}
                      >
                        <span
                          className="extension-prompt-checkbox-box"
                          aria-hidden="true"
                        >
                          {isChecked ? '✓' : ''}
                        </span>
                        {shortcutNum !== null && (
                          <span className="extension-prompt-shortcut">
                            {shortcutNum}
                          </span>
                        )}
                        <span className="extension-prompt-choice-label">
                          {choice.label}
                        </span>
                      </button>
                    );
                  })}
                </div>

                <div className="extension-prompt-footer-actions">
                  <button
                    type="button"
                    ref={doneBtnRef}
                    className="btn-extension-prompt-primary btn-extension-prompt-done"
                    disabled={checkedIndices.size === 0}
                    onClick={() => {
                      if (checkedIndices.size === 0) return;
                      if (isMultiStepFlow) {
                        if (currentStep < totalSteps) {
                          handleDoneMultiSelect();
                        } else {
                          setIsReviewingSummary(true);
                        }
                      } else {
                        handleDoneMultiSelect();
                      }
                    }}
                  >
                    {multiPrimaryButtonLabel}
                  </button>
                  {canReviewSummary && currentStep < totalSteps && (
                    <button
                      type="button"
                      className="btn-extension-prompt-secondary"
                      onClick={() => {
                        const draft = getCurrentDraft();
                        if (draft && typeof draft.step === 'number' && onBack) {
                          onBack(itemKey, currentStep, draft);
                        }
                        setIsReviewingSummary(true);
                      }}
                    >
                      Revisar respuestas →
                    </button>
                  )}
                  {(canGoBack || currentStep > 1) && onBack && (
                    <button
                      type="button"
                      className="btn-extension-prompt-secondary btn-extension-prompt-back"
                      disabled={isNavigatingBack}
                      onClick={() => handleBackClick()}
                    >
                      ← Anterior
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-extension-prompt-secondary"
                    onClick={() => onCancel(itemKey)}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {/* Single-Select Option Buttons */}
            {method === 'select' && !isMultiSelect && (
              <div className="extension-prompt-singleselect-container">
                <div
                  className="extension-prompt-options-list"
                  role="listbox"
                  aria-label={title}
                >
                  {singleSelectOptions.map((opt, idx) => {
                    const isSelected = selectedOptionIndex >= 0 && idx === selectedOptionIndex;
                    const shortcutNum = idx < 9 ? idx + 1 : null;
                    const isOtherOrCustom = isOptionCustom(opt, idx, singleSelectOptions.length);
                    return (
                      <button
                        key={`${idx}-${opt}`}
                        ref={(el) => {
                          optionRefs.current[idx] = el;
                        }}
                        type="button"
                        role="option"
                        aria-selected={isSelected}
                        className={`extension-prompt-option-btn ${
                          isSelected ? 'is-selected' : ''
                        } ${isOtherOrCustom ? 'is-custom-choice' : ''}`}
                        onClick={() => {
                          setSelectedOptionIndex(idx);
                          if (isOtherOrCustom) {
                            setIsTypingCustomOption(true);
                          } else {
                            setIsTypingCustomOption(false);
                          }
                        }}
                      >
                        {shortcutNum !== null && (
                          <span className="extension-prompt-shortcut">
                            {shortcutNum}
                          </span>
                        )}
                        <span className="extension-prompt-choice-label">{opt}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Inline Custom Input when user picks the custom/other option */}
                {isTypingCustomOption && (
                  <div className="extension-prompt-custom-input-box">
                    <input
                      type="text"
                      className="extension-prompt-input-field"
                      placeholder="Escriba su respuesta personalizada..."
                      value={customOptionText}
                      onChange={(e) => setCustomOptionText(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          const val = customOptionText.trim();
                          if (val) {
                            onSelect(itemKey, val);
                          }
                        }
                      }}
                      autoFocus
                    />
                  </div>
                )}

                <div className="extension-prompt-footer-actions">
                  <button
                    type="button"
                    className="btn-extension-prompt-primary"
                    disabled={
                      selectedOptionIndex < 0 ||
                      (isTypingCustomOption && customOptionText.trim().length === 0)
                    }
                    onClick={() => {
                      if (selectedOptionIndex >= 0 && selectedOptionIndex < singleSelectOptions.length) {
                        const answerValue = isTypingCustomOption
                          ? customOptionText.trim()
                          : singleSelectOptions[selectedOptionIndex];

                        if (isMultiStepFlow) {
                          if (currentStep < totalSteps) {
                            onSelect(itemKey, answerValue);
                          } else {
                            setIsReviewingSummary(true);
                          }
                        } else {
                          onSelect(itemKey, answerValue);
                        }
                      }
                    }}
                  >
                    {singlePrimaryButtonLabel}
                  </button>
                  {canReviewSummary && currentStep < totalSteps && (
                    <button
                      type="button"
                      className="btn-extension-prompt-secondary"
                      onClick={() => {
                        const draft = getCurrentDraft();
                        if (draft && typeof draft.step === 'number' && onBack) {
                          onBack(itemKey, currentStep, draft);
                        }
                        setIsReviewingSummary(true);
                      }}
                    >
                      Revisar respuestas →
                    </button>
                  )}
                  {(canGoBack || currentStep > 1) && onBack && (
                    <button
                      type="button"
                      className="btn-extension-prompt-secondary btn-extension-prompt-back"
                      disabled={isNavigatingBack}
                      onClick={() => handleBackClick()}
                    >
                      ← Anterior
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-extension-prompt-secondary"
                    onClick={() => onCancel(itemKey)}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {/* Input Field Prompt */}
            {method === 'input' && (
              <div className="extension-prompt-input-row">
                <input
                  ref={inputRef}
                  type="text"
                  className="extension-prompt-input-field"
                  value={inputValue}
                  placeholder={request.placeholder ?? ''}
                  onChange={(e) => setInputValue(e.target.value)}
                  autoFocus
                  aria-label={title}
                />
                <div className="extension-prompt-footer-actions">
                  <button
                    type="button"
                    className="btn-extension-prompt-primary"
                    disabled={inputValue.trim().length === 0}
                    onClick={() => {
                      if (inputValue.trim().length === 0) return;
                      if (isMultiStepFlow) {
                        if (currentStep < totalSteps) {
                          onInput(itemKey, inputValue);
                        } else {
                          setIsReviewingSummary(true);
                        }
                      } else {
                        onInput(itemKey, inputValue);
                      }
                    }}
                  >
                    {inputPrimaryButtonLabel}
                  </button>
                  {canReviewSummary && currentStep < totalSteps && (
                    <button
                      type="button"
                      className="btn-extension-prompt-secondary"
                      onClick={() => {
                        const draft = getCurrentDraft();
                        if (draft && typeof draft.step === 'number' && onBack) {
                          onBack(itemKey, currentStep, draft);
                        }
                        setIsReviewingSummary(true);
                      }}
                    >
                      Revisar respuestas →
                    </button>
                  )}
                  {(canGoBack || currentStep > 1) && onBack && (
                    <button
                      type="button"
                      className="btn-extension-prompt-secondary btn-extension-prompt-back"
                      disabled={isNavigatingBack}
                      onClick={() => handleBackClick()}
                    >
                      ← Anterior
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn-extension-prompt-secondary"
                    onClick={() => onCancel(itemKey)}
                  >
                    Cancelar
                  </button>
                </div>
              </div>
            )}

            {/* Confirmation Buttons */}
            {method === 'confirm' && (
              <div className="extension-prompt-confirm-row">
                <button
                  ref={affirmativeBtnRef}
                  type="button"
                  className="btn-extension-prompt-primary"
                  onClick={() => {
                    setConfirmValue(true);
                    if (isMultiStepFlow) {
                      if (currentStep < totalSteps) {
                        onConfirm(itemKey, true);
                      } else {
                        setIsReviewingSummary(true);
                      }
                    } else {
                      onConfirm(itemKey, true);
                    }
                  }}
                >
                  {isMultiStepFlow && currentStep < totalSteps ? 'Siguiente →' : 'Sí'}
                </button>
                {canReviewSummary && currentStep < totalSteps && (
                  <button
                    type="button"
                    className="btn-extension-prompt-secondary"
                    onClick={() => {
                      const draft = getCurrentDraft();
                      if (draft && typeof draft.step === 'number' && onBack) {
                        onBack(itemKey, currentStep, draft);
                      }
                      setIsReviewingSummary(true);
                    }}
                  >
                    Revisar respuestas →
                  </button>
                )}
                {(canGoBack || currentStep > 1) && onBack && (
                  <button
                    type="button"
                    className="btn-extension-prompt-secondary btn-extension-prompt-back"
                    disabled={isNavigatingBack}
                    onClick={() => handleBackClick()}
                  >
                    ← Anterior
                  </button>
                )}
                <button
                  ref={negativeBtnRef}
                  type="button"
                  className="btn-extension-prompt-negative"
                  onClick={() => {
                    setConfirmValue(false);
                    if (isMultiStepFlow) {
                      if (currentStep < totalSteps) {
                        onConfirm(itemKey, false);
                      } else {
                        setIsReviewingSummary(true);
                      }
                    } else {
                      onConfirm(itemKey, false);
                    }
                  }}
                >
                  {isMultiStepFlow && currentStep < totalSteps ? 'No y siguiente' : 'No'}
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
