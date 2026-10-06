import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExtensionUiDialogAdapter } from '@core/protocol';
import type { ExtensionUiRequest } from '@core/types/events';
import { isWindowsPath, normalizeWorkingDirectory } from '@core/session';

export interface QueuedExtensionUiDialog {
  id: string;
  itemKey: string;
  request: ExtensionUiRequest;
  method: 'select' | 'input' | 'confirm';
  createdAt: number;
  expiresAt?: number;
  timerId?: ReturnType<typeof setTimeout>;
  resolve: (value: any) => void;
}

let queueItemCounter = 0;

export function createDialogItemKey(id: string, cwd?: string): string {
  queueItemCounter += 1;
  const normCwd = cwd ? normalizeWorkingDirectory(cwd) : '';
  return `${normCwd}\0${id}\0${queueItemCounter}`;
}

export function isSamePath(pathA?: string, pathB?: string): boolean {
  if (!pathA && !pathB) return true;
  if (!pathA || !pathB) return false;
  const normA = normalizeWorkingDirectory(pathA);
  const normB = normalizeWorkingDirectory(pathB);
  if (normA === normB) return true;
  if (isWindowsPath(normA) && isWindowsPath(normB)) {
    return normA.toLowerCase() === normB.toLowerCase();
  }
  return false;
}

export interface ParsedMultiSelectChoice {
  raw: string;
  label: string;
  toggled: boolean;
}

export interface ParsedMultiSelect {
  isMultiSelect: boolean;
  choices: ParsedMultiSelectChoice[];
  doneOption: string;
}

export interface HistoryDialogEntry {
  itemKey: string;
  id: string;
  request: ExtensionUiRequest;
  method: 'select' | 'input' | 'confirm';
  value: any;
  resolvedAt: number;
}

export interface QuestionStepInfo {
  isMultiStep: boolean;
  currentStep: number;
  totalSteps: number;
  cleanTitle: string;
}

export interface AnsweredQuestionRecord {
  step: number;
  question: string;
  answerText: string;
  selectedLabels?: string[];
  singleChoice?: string;
  inputValue?: string;
  confirmValue?: boolean;
}

/**
 * Known question-type keywords for stripping redundant headers and tags.
 */
const QUESTION_TYPE_KEYWORDS =
  /(?:selecci[oó]n\s+(?:simple|m[uú]ltiple)|simple|m[uú]ltiple|choice|multi-?choice|single-?choice|input|confirm(?:ation)?|booleano?|text(?:o)?|vista\s*previa|preview)/i;

/**
 * Strips redundant question type descriptions, step indicators, and headers from raw question titles.
 * Preserves normal question words when they are part of natural language (requires separator or brackets).
 */
export function cleanQuestionText(raw?: string): string {
  if (!raw || typeof raw !== 'string') return '';
  let text = raw.trim();

  // 0. Strip trailing preview blocks (e.g. '--- 1. Option preview --- ...' or '\n\n--- 1. ...')
  text = text.replace(/(?:\r?\n|\s)+---\s*\d*\.?\s*.*?(?:preview|vista\s*previa)\s*---[\s\S]*$/i, '');

  // Strip trailing options block starting with '--- 1. ...' or after newline
  text = text.replace(/(?:\r?\n|\s)+---\s*\d+\.\s+[\s\S]*$/i, '');

  // Strip trailing numbered option list if formatted like '\n\n1. ... \n2. ...'
  text = text.replace(/(?:\r?\n)+(?:\d+\.\s+.*[\r?\n]*)+$/i, '');

  // Strip trailing options header block (e.g. '\n\nOptions:\n...' or '\n\nOpciones:\n...')
  text = text.replace(/(?:\r?\n)+(?:options?|opciones?|choices?|elecciones?)\s*:[\s\S]*$/i, '');

  // Strip trailing instructions like 'Enter option number (1-4)...' or 'Type your answer:'
  text = text.replace(/(?:\r?\n)+(?:enter option number|type your answer|select an option|elige una opci[oó]n|selecciona una opci[oó]n)[\s\S]*$/i, '');

  let prev = '';
  // Iteratively peel off leading metadata components
  while (text !== prev && text.length > 0) {
    prev = text;

    // 1. Strip any leading label followed by colon/separator before a bracketed tag or step
    // e.g. "Preview: [Pregunta 2/3 - Vista Previa]: " -> removes "Preview: "
    text = text.replace(
      /^[A-Za-zÀ-ÿ0-9_\-\s]{1,40}[:\-–—]\s*(?=[ñ\[\(]|\d+\s*(?:\/|\s+(?:of|de)\s+)\s*\d+)/i,
      ''
    );

    // 2. Leading step prefixes like "1/3:", "1 of 3:", "Paso 1 de 3:", "Pregunta 1 de 3 -"
    text = text.replace(
      /^(?:(?:pregunta|question|paso|step)\s+)?\d+\s*(?:\/|\s+(?:of|de)\s+)\s*\d+\s*[:\-–—.]?\s*/i,
      ''
    );

    // 3. Bracketed tags like "[1/3 Selección Simple]", "[Pregunta 2/3 - Vista Previa]:", "[Choice]"
    text = text.replace(/^\[[^\]]+\]\s*[:\-–—.]?\s*/i, '');

    // 4. Strip bracketed step tag anywhere
    text = text.replace(
      /\[\s*(?:(?:pregunta|question|paso|step)\s+)?\d+\s*(?:\/|\s+(?:of|de)\s+)\s*\d+[^\]]*\]\s*[:\-–—.]?\s*/gi,
      ''
    );

    // 5. Parenthesized tags containing step info or question type keywords
    // e.g. "(1/3 Selección Simple)", "(1/3)", "(Choice)", "(Selección Simple)"
    text = text.replace(
      /^\((?=[^)]*(?:\d+\s*(?:\/|\s+(?:of|de)\s+)\s*\d+|pregunta|question|paso|step|selecci[oó]n|simple|m[uú]ltiple|choice|input|confirm|vista\s*previa|preview|booleano?|text(?:o)?))[^)]*\)\s*[:\-–—.]?\s*/i,
      ''
    );

    // 6. Leading step or item labels like "Paso 1:", "Pregunta 1:"
    text = text.replace(
      /^(?:pregunta|question|paso|step)\s+\d+\s*[:\-–—.]\s*/i,
      ''
    );

    // 7. Leading numbered items like "1. ", "1: ", "1 - "
    text = text.replace(/^\d+\s*[\.\:\-–—]\s*/, '');

    // 8. Leading question-type headers requiring a separator (like ":", "-", "—", ".")
    // e.g. "Simple:", "Selección Simple:", "Choice -", "Confirm:", "Preview:", "Vista Previa:"
    // This explicitly prevents stripping "Simple" in "Simple questions are easy to answer".
    text = text.replace(
      new RegExp(
        `^(?:${QUESTION_TYPE_KEYWORDS.source})\\s*[:\\-–—.]\\s*`,
        'i'
      ),
      ''
    );

    // 9. Leading colons, hyphens, dashes, or whitespace left over from stripped tokens
    text = text.replace(/^[:\-–—\s]+/, '');
  }

  text = text.trim();
  if (text.length > 0) {
    // Capitalize the first letter (preserving leading ¿ or ¡)
    // e.g. "tienes algun template?" -> "Tienes algun template?"
    // "¿tienes algun template?" -> "¿Tienes algun template?"
    text = text.replace(
      /^([¿¡\s]*)([a-zà-ÿ])/i,
      (_, prefix, char) => `${prefix}${char.toUpperCase()}`
    );
  }

  return text;
}

/**
 * Parses multi-step question titles (e.g. "1/2: Question", "2/2: Question", "1 of 3: Question",
 * "Paso 1 de 3: Question", "[1/3 Selección Simple] Question") into structured step metadata.
 */
export function parseQuestionStepInfo(title?: string): QuestionStepInfo {
  if (!title || typeof title !== 'string') {
    return {
      isMultiStep: false,
      currentStep: 1,
      totalSteps: 1,
      cleanTitle: '',
    };
  }

  const trimmed = title.trim();
  const cleaned = cleanQuestionText(trimmed);

  // 1. Match leading step pattern e.g. "1/3:", "1 of 3:", "Paso 1 de 3:"
  const leadingMatch = trimmed.match(
    /^(?:(?:pregunta|question|paso|step)\s+)?(\d+)\s*(?:\/|\s+(?:of|de)\s+)\s*(\d+)/i
  );

  if (leadingMatch) {
    const currentStep = parseInt(leadingMatch[1], 10);
    const totalSteps = parseInt(leadingMatch[2], 10);
    if (!isNaN(currentStep) && !isNaN(totalSteps) && totalSteps > 1) {
      return {
        isMultiStep: true,
        currentStep,
        totalSteps,
        cleanTitle: cleaned || trimmed,
      };
    }
  }

  // 2. Match bracketed or parenthesized step tags e.g. "[1/3 Selección Simple]", "[Pregunta 2/3 - Vista Previa]", "[1/3]", "(1/3)"
  const bracketMatch = trimmed.match(
    /[\[\(]\s*(?:(?:pregunta|question|paso|step)\s+)?(\d+)\s*(?:\/|\s+(?:of|de)\s+)\s*(\d+)[^\]\)]*[\]\)]/i
  );

  if (bracketMatch) {
    const currentStep = parseInt(bracketMatch[1], 10);
    const totalSteps = parseInt(bracketMatch[2], 10);
    if (!isNaN(currentStep) && !isNaN(totalSteps) && totalSteps > 1) {
      return {
        isMultiStep: true,
        currentStep,
        totalSteps,
        cleanTitle: cleaned || trimmed,
      };
    }
  }

  // 3. Match step pattern with keyword anywhere in title e.g. "Pregunta 2/3", "Paso 2 de 3"
  const stepKeywordMatch = trimmed.match(
    /(?:pregunta|question|paso|step)\s+(\d+)\s*(?:\/|\s+(?:of|de)\s+)\s*(\d+)/i
  );

  if (stepKeywordMatch) {
    const currentStep = parseInt(stepKeywordMatch[1], 10);
    const totalSteps = parseInt(stepKeywordMatch[2], 10);
    if (!isNaN(currentStep) && !isNaN(totalSteps) && totalSteps > 1) {
      return {
        isMultiStep: true,
        currentStep,
        totalSteps,
        cleanTitle: cleaned || trimmed,
      };
    }
  }

  return {
    isMultiStep: false,
    currentStep: 1,
    totalSteps: 1,
    cleanTitle: cleaned || trimmed,
  };
}

/**
 * Helper detecting whether a title string indicates question 2 or later in a questionnaire.
 */
export function isMultiQuestionTitle(title?: string): boolean {
  if (!title) return false;
  const info = parseQuestionStepInfo(title);
  if (info.isMultiStep && info.currentStep >= 2) return true;
  // Match e.g. "2/2", "2/3", "3/5" (numerator >= 2)
  if (/\b([2-9]|\d{2,})\s*\/\s*\d+\b/i.test(title)) return true;
  // Match e.g. "2 of 3", "3 of 4", "2 de 3"
  if (/\b([2-9]|\d{2,})\s+(?:of|de)\s+\d+\b/i.test(title)) return true;
  // Match e.g. "pregunta 2", "question 2", "paso 2", "step 2"
  if (/\b(?:pregunta|question|paso|step)\s+([2-9]|\d{2,})\b/i.test(title)) return true;
  return false;
}

/**
 * Detects if options follow the multi-select round convention used by gentle-pi / Pi extensions:
 * - At least 2 options
 * - The last option is "Done" (case-insensitive)
 * - All preceding options start with [ ] or [x]
 */
export function parseMultiSelectOptions(options?: string[]): ParsedMultiSelect {
  if (!options || options.length < 2) {
    return { isMultiSelect: false, choices: [], doneOption: '' };
  }
  const last = options[options.length - 1].trim();
  if (last.toLowerCase() !== 'done') {
    return { isMultiSelect: false, choices: [], doneOption: '' };
  }
  const candidates = options.slice(0, -1);
  const choices: ParsedMultiSelectChoice[] = [];
  for (const raw of candidates) {
    const trimmed = raw.trim();
    const match = trimmed.match(/^\[([ xX])\]\s*(.*)$/);
    if (!match) {
      return { isMultiSelect: false, choices: [], doneOption: '' };
    }
    choices.push({
      raw,
      label: match[2] || trimmed,
      toggled: match[1].toLowerCase() === 'x',
    });
  }
  return { isMultiSelect: true, choices, doneOption: options[options.length - 1] };
}

export interface QuestionIdentity {
  hasTitle: boolean;
  step?: number;
  totalSteps?: number;
  cleanTitle?: string;
  rawTitle?: string;
}

export function extractQuestionIdentity(title?: string): QuestionIdentity {
  const rawTitle = typeof title === 'string' ? title.trim() : '';
  if (!rawTitle) {
    return { hasTitle: false };
  }
  const stepInfo = parseQuestionStepInfo(rawTitle);
  const cleanTitle = cleanQuestionText(stepInfo.cleanTitle) || cleanQuestionText(rawTitle);
  return {
    hasTitle: true,
    step: stepInfo.isMultiStep ? stepInfo.currentStep : undefined,
    totalSteps: stepInfo.isMultiStep ? stepInfo.totalSteps : undefined,
    cleanTitle: cleanTitle.trim(),
    rawTitle,
  };
}

export function isSameQuestionIdentity(
  a?: QuestionIdentity | null,
  b?: QuestionIdentity | null
): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;

  // If neither has a title, treat as matching legacy requests
  if (!a.hasTitle && !b.hasTitle) {
    return true;
  }

  // If one has title and the other doesn't, they cannot match
  if (a.hasTitle !== b.hasTitle) {
    return false;
  }

  // If step numbers are present on either, they must match exactly
  if (a.step !== undefined || b.step !== undefined) {
    if (a.step !== b.step) return false;
    if (
      a.totalSteps !== undefined &&
      b.totalSteps !== undefined &&
      a.totalSteps !== b.totalSteps
    ) {
      return false;
    }
  }

  // If clean titles exist on both, compare them case-insensitively
  if (a.cleanTitle && b.cleanTitle) {
    if (a.cleanTitle.toLowerCase() !== b.cleanTitle.toLowerCase()) {
      return false;
    }
  } else if (Boolean(a.cleanTitle) !== Boolean(b.cleanTitle)) {
    return false;
  } else if (a.rawTitle && b.rawTitle) {
    if (a.rawTitle.toLowerCase() !== b.rawTitle.toLowerCase()) {
      return false;
    }
  }

  return true;
}

interface ActiveMultiSelectAutoPlay {
  cwd?: string;
  desiredToggled: boolean[];
  identity: QuestionIdentity;
  timeoutTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Pure state manager coordinating an asynchronous FIFO queue of extension UI dialog requests.
 * Manages queue-owned expiry timers anchored on arrival, item-identity-bound resolutions,
 * and safe cwd-scoped cancellations.
 */
export class ExtensionUiDialogQueue {
  private queue: QueuedExtensionUiDialog[] = [];
  private dialogHistory: HistoryDialogEntry[] = [];
  private flowAnswers = new Map<number, AnsweredQuestionRecord>();
  private listeners = new Set<(queue: QueuedExtensionUiDialog[]) => void>();
  private activeAutoPlay: ActiveMultiSelectAutoPlay | null = null;
  private isNavigatingBack = false;

  public getQueue(): QueuedExtensionUiDialog[] {
    return [...this.queue];
  }

  public getDialogHistory(): HistoryDialogEntry[] {
    return [...this.dialogHistory];
  }

  public getFlowAnswers(): AnsweredQuestionRecord[] {
    return Array.from(this.flowAnswers.values()).sort((a, b) => a.step - b.step);
  }

  public getFlowAnswersMap(): Map<number, AnsweredQuestionRecord> {
    return new Map(this.flowAnswers);
  }

  public clearFlowAnswers(): void {
    this.isNavigatingBack = false;
    this.flowAnswers.clear();
  }

  public recordFlowAnswer(
    step: number,
    question: string,
    answerText: string,
    details?: {
      selectedLabels?: string[];
      singleChoice?: string;
      inputValue?: string;
      confirmValue?: boolean;
    }
  ): void {
    const cleanQ = cleanQuestionText(question) || question;
    this.flowAnswers.set(step, {
      step,
      question: cleanQ,
      answerText,
      ...details,
    });
  }

  public getActiveDialog(): QueuedExtensionUiDialog | null {
    return this.queue.length > 0 ? this.queue[0] : null;
  }

  public getPendingCount(): number {
    return this.queue.length;
  }

  public isNavigating(): boolean {
    return this.isNavigatingBack;
  }

  public subscribe(listener: (queue: QueuedExtensionUiDialog[]) => void): () => void {
    this.listeners.add(listener);
    listener([...this.queue]);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const snapshot = [...this.queue];
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch {
        // Safe listener notification
      }
    }
  }

  /**
   * Enqueue dialog request. Timeout is anchored immediately upon arrival via a queue-owned
   * timer bound to the item's unique identity (itemKey) so waiting dialogs expire accurately
   * and never collide across identical IDs in different working directories.
   */
  public enqueue(
    request: ExtensionUiRequest,
    method: 'select' | 'input' | 'confirm',
    resolve: (value: any) => void
  ): QueuedExtensionUiDialog {
    // Intercept multi-select iterative rounds if an auto-play session is running
    if (this.activeAutoPlay) {
      if (method === 'select') {
        const parsed = parseMultiSelectOptions(request.options);
        const incomingIdentity = extractQuestionIdentity(request.title);
        if (
          parsed.isMultiSelect &&
          parsed.choices.length === this.activeAutoPlay.desiredToggled.length &&
          isSamePath(request.cwd, this.activeAutoPlay.cwd) &&
          isSameQuestionIdentity(this.activeAutoPlay.identity, incomingIdentity)
        ) {
          if (this.activeAutoPlay.timeoutTimer) {
            clearTimeout(this.activeAutoPlay.timeoutTimer);
            this.activeAutoPlay.timeoutTimer = undefined;
          }

          const currentStates = parsed.choices.map((c) => c.toggled);
          const desired = this.activeAutoPlay.desiredToggled;
          let diffIndex = -1;
          for (let i = 0; i < currentStates.length; i++) {
            if (currentStates[i] !== desired[i]) {
              diffIndex = i;
              break;
            }
          }

          if (diffIndex !== -1 && request.options && request.options[diffIndex]) {
            // Keep safety timer alive while continuing auto-play
            this.activeAutoPlay.timeoutTimer = setTimeout(() => {
              this.clearAutoPlay();
            }, 4000);

            // Resolve immediately with the option at diffIndex to toggle it
            resolve(request.options[diffIndex]);
            return {
              id: request.id,
              itemKey: createDialogItemKey(request.id, request.cwd),
              request,
              method,
              createdAt: Date.now(),
              resolve,
            };
          } else {
            // All states match desired! Resolve with Done option and complete auto-play
            const doneOpt = parsed.doneOption || 'Done';
            this.clearAutoPlay();
            resolve(doneOpt);
            return {
              id: request.id,
              itemKey: createDialogItemKey(request.id, request.cwd),
              request,
              method,
              createdAt: Date.now(),
              resolve,
            };
          }
        } else {
          // Different request arrived; clear auto-play session
          this.clearAutoPlay();
        }
      } else {
        // Non-select method arrived while auto-play active; clear auto-play session
        this.clearAutoPlay();
      }
    }

    const createdAt = Date.now();
    const stepInfo = parseQuestionStepInfo(request.title);
    if (stepInfo.isMultiStep && stepInfo.currentStep === 1) {
      if (!this.isNavigatingBack) {
        this.flowAnswers.clear();
        this.dialogHistory = [];
      }
      this.isNavigatingBack = false;
    } else if (!stepInfo.isMultiStep && this.dialogHistory.length === 0) {
      if (!this.isNavigatingBack) {
        this.flowAnswers.clear();
      }
      this.isNavigatingBack = false;
    } else {
      this.isNavigatingBack = false;
    }
    // Timeout is always specified in milliseconds
    const timeoutMs =
      typeof request.timeout === 'number' &&
      !isNaN(request.timeout) &&
      request.timeout > 0
        ? request.timeout
        : undefined;
    const expiresAt = timeoutMs !== undefined ? createdAt + timeoutMs : undefined;
    const itemKey = createDialogItemKey(request.id, request.cwd);

    const item: QueuedExtensionUiDialog = {
      id: request.id,
      itemKey,
      request,
      method,
      createdAt,
      expiresAt,
      resolve,
    };

    if (timeoutMs !== undefined) {
      item.timerId = setTimeout(() => {
        this.handleExpiry(item.itemKey);
      }, timeoutMs);
    }

    this.queue.push(item);
    this.notify();
    return item;
  }

  /**
   * Handle queue-owned timeout expiry bound to itemKey.
   */
  public handleExpiry(itemKey: string): boolean {
    this.clearAutoPlay();
    this.isNavigatingBack = false;
    const index = this.queue.findIndex((d) => d.itemKey === itemKey);
    if (index === -1) return false;
    const [item] = this.queue.splice(index, 1);
    if (item.timerId) {
      clearTimeout(item.timerId);
      item.timerId = undefined;
    }
    this.notify();
    item.resolve(null);
    return true;
  }

  /**
   * Item-identity-bound resolution to prevent shifted head answers and cross-cwd ID collisions.
   */
  public resolveByItemKey(itemKey: string, value: any): boolean {
    const index = this.queue.findIndex((d) => d.itemKey === itemKey);
    if (index === -1) return false;
    const [item] = this.queue.splice(index, 1);
    if (item.timerId) {
      clearTimeout(item.timerId);
      item.timerId = undefined;
    }
    const isBackToken =
      typeof value === 'string' &&
      (value === '__back__' || value.startsWith('__back__:'));
    if (value !== null && !isBackToken) {
      this.dialogHistory.push({
        itemKey: item.itemKey,
        id: item.id,
        request: item.request,
        method: item.method,
        value,
        resolvedAt: Date.now(),
      });

      const stepInfo = parseQuestionStepInfo(item.request.title);
      const stepNumber = stepInfo.isMultiStep ? stepInfo.currentStep : this.dialogHistory.length;
      const question =
        cleanQuestionText(stepInfo.cleanTitle) ||
        cleanQuestionText(item.request.title) ||
        cleanQuestionText(item.request.message) ||
        `Pregunta ${stepNumber}`;

      const parsed =
        item.method === 'select'
          ? parseMultiSelectOptions(item.request.options)
          : null;

      if (!parsed?.isMultiSelect) {
        let answerText = String(value);
        let singleChoice: string | undefined;
        let inputValue: string | undefined;
        let confirmValue: boolean | undefined;

        if (item.method === 'confirm') {
          confirmValue = typeof value === 'boolean' ? value : Boolean(value);
          answerText = confirmValue ? 'Sí' : 'No';
        } else if (item.method === 'input') {
          inputValue = typeof value === 'string' ? value : String(value);
          answerText = inputValue;
        } else if (item.method === 'select') {
          singleChoice = typeof value === 'string' ? value : String(value);
          answerText = singleChoice;
        }

        this.flowAnswers.set(stepNumber, {
          step: stepNumber,
          question,
          answerText,
          singleChoice,
          inputValue,
          confirmValue,
        });
      } else {
        const existingRecord = this.flowAnswers.get(stepNumber);
        const isDone =
          typeof value === 'string' &&
          (value.toLowerCase() === 'done' ||
            (parsed.doneOption && value.toLowerCase() === parsed.doneOption.toLowerCase()));

        const isAutoPlayForThisQuestion = Boolean(
          this.activeAutoPlay &&
          isSameQuestionIdentity(
            this.activeAutoPlay.identity,
            extractQuestionIdentity(item.request.title)
          )
        );

        if (!existingRecord?.selectedLabels && !isAutoPlayForThisQuestion && isDone) {
          const selectedLabels = parsed.choices
            .filter((c) => c.toggled)
            .map((c) => c.label);
          this.flowAnswers.set(stepNumber, {
            step: stepNumber,
            question,
            answerText: selectedLabels.length > 0 ? selectedLabels.join(', ') : '(Ninguna)',
            selectedLabels,
          });
        }
      }
    }
    this.notify();
    item.resolve(value);
    return true;
  }

  /**
   * Check whether back navigation to a previous question is available.
   * Returns true if there is dialog history or if title indicates question 2+ in a questionnaire.
   */
  public canGoBack(itemKey?: string): boolean {
    if (this.dialogHistory.length > 0) {
      return true;
    }
    const dialog = itemKey
      ? this.queue.find((d) => d.itemKey === itemKey)
      : this.getActiveDialog();
    return isMultiQuestionTitle(dialog?.request?.title);
  }

  /**
   * Go back to the previous dialog or a specific target step by resolving the active dialog with
   * '__back__' or '__back__:<targetStep>'.
   * Pops previous entry/entries from history if present.
   * If currentDraft is provided, saves it into flowAnswers before rewinding.
   * Does NOT delete flowAnswers so previous selections are preserved when modifying.
   */
  public goBackByItemKey(
    itemKey: string,
    targetStep?: number,
    currentDraft?: Partial<AnsweredQuestionRecord>
  ): boolean {
    if (currentDraft && typeof currentDraft.step === 'number') {
      this.recordFlowAnswer(
        currentDraft.step,
        currentDraft.question ?? `Pregunta ${currentDraft.step}`,
        currentDraft.answerText ?? '',
        {
          selectedLabels: currentDraft.selectedLabels,
          singleChoice: currentDraft.singleChoice,
          inputValue: currentDraft.inputValue,
          confirmValue: currentDraft.confirmValue,
        }
      );
    }
    const head = this.getActiveDialog();
    if (head && typeof targetStep === 'number') {
      const stepInfo = parseQuestionStepInfo(head.request.title);
      if (stepInfo.currentStep === targetStep) {
        return false;
      }
    }
    this.isNavigatingBack = true;
    if (this.dialogHistory.length > 0) {
      if (typeof targetStep === 'number' && targetStep >= 1) {
        while (this.dialogHistory.length >= targetStep && this.dialogHistory.length > 0) {
          this.dialogHistory.pop();
        }
      } else {
        this.dialogHistory.pop();
      }
    }
    const token = targetStep !== undefined ? `__back__:${targetStep}` : '__back__';
    return this.resolveByItemKey(itemKey, token);
  }

  public cancelByItemKey(itemKey: string): boolean {
    this.clearAutoPlay();
    this.isNavigatingBack = false;
    this.flowAnswers.clear();
    this.dialogHistory = [];
    return this.resolveByItemKey(itemKey, null);
  }

  public isAutoPlayActive(): boolean {
    return this.activeAutoPlay !== null;
  }

  public clearAutoPlay(): void {
    if (this.activeAutoPlay?.timeoutTimer) {
      clearTimeout(this.activeAutoPlay.timeoutTimer);
    }
    this.activeAutoPlay = null;
  }

  /**
   * Submit client-selected multi-choice state. Automatically manages iterative toggle rounds
   * with the backend so the user UI never experiences flashes or re-renders per choice.
   */
  public submitMultiSelect(itemKey: string, desiredToggled: boolean[]): boolean {
    const index = this.queue.findIndex((d) => d.itemKey === itemKey);
    if (index === -1) return false;
    const item = this.queue[index];
    if (item.method !== 'select') return false;

    const parsed = parseMultiSelectOptions(item.request.options);
    if (!parsed.isMultiSelect || parsed.choices.length !== desiredToggled.length) {
      // Fallback: resolve normally with Done or default
      return this.resolveByItemKey(itemKey, parsed.doneOption || 'Done');
    }

    const stepInfo = parseQuestionStepInfo(item.request.title);
    const selected = parsed.choices
      .filter((_, i) => desiredToggled[i])
      .map((c) => c.label);
    const answerText = selected.length > 0 ? selected.join(', ') : '(Ninguna)';
    const stepNumber = stepInfo.isMultiStep ? stepInfo.currentStep : this.dialogHistory.length + 1;
    const question =
      cleanQuestionText(stepInfo.cleanTitle) ||
      cleanQuestionText(item.request.title) ||
      cleanQuestionText(item.request.message) ||
      `Pregunta ${stepNumber}`;
    this.flowAnswers.set(stepNumber, {
      step: stepNumber,
      question,
      answerText,
      selectedLabels: selected,
    });

    const currentStates = parsed.choices.map((c) => c.toggled);
    let diffIndex = -1;
    for (let i = 0; i < currentStates.length; i++) {
      if (currentStates[i] !== desiredToggled[i]) {
        diffIndex = i;
        break;
      }
    }

    if (diffIndex === -1) {
      // No toggles needed! Resolve immediately with Done
      this.clearAutoPlay();
      return this.resolveByItemKey(itemKey, parsed.doneOption || 'Done');
    }

    // Set up auto-play for subsequent requests from the iterative loop
    this.clearAutoPlay();
    const timeoutTimer = setTimeout(() => {
      this.clearAutoPlay();
    }, 4000);

    const identity = extractQuestionIdentity(item.request.title);

    this.activeAutoPlay = {
      cwd: item.request.cwd,
      desiredToggled,
      identity,
      timeoutTimer,
    };

    // Resolve the active request with the first toggle option
    const toggleOption = item.request.options
      ? item.request.options[diffIndex]
      : parsed.choices[diffIndex].raw;
    return this.resolveByItemKey(itemKey, toggleOption);
  }

  /**
   * Resolve by request ID and optional cwd for caller convenience and test backward compatibility.
   */
  public resolveById(id: string, value: any, cwd?: string): boolean {
    const index = this.queue.findIndex(
      (d) => d.id === id && (!cwd || isSamePath(d.request.cwd, cwd))
    );
    if (index === -1) return false;
    const [item] = this.queue.splice(index, 1);
    if (item.timerId) {
      clearTimeout(item.timerId);
      item.timerId = undefined;
    }
    this.notify();
    item.resolve(value);
    return true;
  }

  public cancelById(id: string, cwd?: string): boolean {
    return this.resolveById(id, null, cwd);
  }

  public cancelActive(): boolean {
    if (this.queue.length === 0) return false;
    return this.cancelByItemKey(this.queue[0].itemKey);
  }

  /**
   * Cancel pending dialog requests.
   * If cwd is provided, only pending requests matching that working directory are cancelled.
   * If a pending request has no cwd (legacy request), it is safely cancelled only when
   * the disconnected session is the active session (targetNorm === activeNorm).
   * If cwd is omitted, all pending requests are cancelled.
   */
  public cancelPending(cwd?: string, activeCwd?: string): number {
    this.clearAutoPlay();
    this.isNavigatingBack = false;
    this.dialogHistory = [];
    this.flowAnswers.clear();
    if (!cwd) {
      const toCancel = [...this.queue];
      this.queue = [];
      for (const item of toCancel) {
        if (item.timerId) {
          clearTimeout(item.timerId);
          item.timerId = undefined;
        }
      }
      this.notify();
      for (const item of toCancel) {
        item.resolve(null);
      }
      return toCancel.length;
    }

    const targetNorm = normalizeWorkingDirectory(cwd);
    const activeNorm = activeCwd ? normalizeWorkingDirectory(activeCwd) : undefined;
    const isTargetActive = Boolean(targetNorm && activeNorm && targetNorm === activeNorm);

    const remaining: QueuedExtensionUiDialog[] = [];
    const toCancel: QueuedExtensionUiDialog[] = [];

    for (const item of this.queue) {
      const itemNorm = item.request.cwd
        ? normalizeWorkingDirectory(item.request.cwd)
        : undefined;
      const shouldCancel = itemNorm ? itemNorm === targetNorm : isTargetActive;
      if (shouldCancel) {
        if (item.timerId) {
          clearTimeout(item.timerId);
          item.timerId = undefined;
        }
        toCancel.push(item);
      } else {
        remaining.push(item);
      }
    }

    if (toCancel.length > 0) {
      this.queue = remaining;
      this.notify();
      for (const item of toCancel) {
        item.resolve(null);
      }
    }

    return toCancel.length;
  }

  public asAdapter(): ExtensionUiDialogAdapter {
    return {
      select: (request: ExtensionUiRequest): Promise<string | null> => {
        return new Promise<string | null>((resolve) => {
          this.enqueue(request, 'select', (val) => {
            resolve(typeof val === 'string' ? val : null);
          });
        });
      },
      input: (request: ExtensionUiRequest): Promise<string | null> => {
        return new Promise<string | null>((resolve) => {
          this.enqueue(request, 'input', (val) => {
            resolve(typeof val === 'string' ? val : null);
          });
        });
      },
      confirm: (request: ExtensionUiRequest): Promise<boolean | null> => {
        return new Promise<boolean | null>((resolve) => {
          this.enqueue(request, 'confirm', (val) => {
            resolve(typeof val === 'boolean' || typeof val === 'string' ? (val as any) : null);
          });
        });
      },
      cancelPending: (cwd?: string, activeCwd?: string): void => {
        this.cancelPending(cwd, activeCwd);
      },
    };
  }
}

export interface UseExtensionUiDialogResult {
  dialogQueue: QueuedExtensionUiDialog[];
  activeDialog: QueuedExtensionUiDialog | null;
  pendingCount: number;
  dialogAdapter: ExtensionUiDialogAdapter;
  canGoBack: boolean;
  flowAnswers: AnsweredQuestionRecord[];
  handleSelect: (itemKey: string, choice: string) => void;
  handleMultiSelectSubmit: (itemKey: string, desiredToggled: boolean[]) => void;
  handleInput: (itemKey: string, value: string) => void;
  handleConfirm: (itemKey: string, confirmed: boolean) => void;
  handleCancel: (itemKey: string) => void;
  handleBack: (
    itemKey: string,
    targetStep?: number,
    currentDraft?: Partial<AnsweredQuestionRecord>
  ) => void;
  cancelPending: (cwd?: string, activeCwd?: string) => void;
}

/**
 * Hook managing the global FIFO extension UI dialog queue and providing the
 * async React-backed ExtensionUiDialogAdapter.
 */
export function useExtensionUiDialog(): UseExtensionUiDialogResult {
  const queueManagerRef = useRef<ExtensionUiDialogQueue | null>(null);
  if (!queueManagerRef.current) {
    queueManagerRef.current = new ExtensionUiDialogQueue();
  }
  const queueManager = queueManagerRef.current;

  const [queue, setQueue] = useState<QueuedExtensionUiDialog[]>([]);
  const [activeDialog, setActiveDialog] = useState<QueuedExtensionUiDialog | null>(null);
  const [flowAnswers, setFlowAnswers] = useState<AnsweredQuestionRecord[]>([]);
  const activeDialogRef = useRef<QueuedExtensionUiDialog | null>(null);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const unsubscribe = queueManager.subscribe((updated) => {
      setQueue(updated);
      setFlowAnswers(queueManager.getFlowAnswers());

      const nextActive = updated.length > 0 ? updated[0] : null;
      if (nextActive) {
        if (graceTimerRef.current) {
          clearTimeout(graceTimerRef.current);
          graceTimerRef.current = null;
        }
        activeDialogRef.current = nextActive;
        setActiveDialog(nextActive);
      } else {
        // If queue transitioned to empty:
        // If it was the final question and not navigating back, dismiss immediately without 600ms debounce.
        // For intermediate steps, wait 600ms; for back navigation, wait 1500ms.
        if (activeDialogRef.current !== null) {
          if (graceTimerRef.current) {
            clearTimeout(graceTimerRef.current);
            graceTimerRef.current = null;
          }
          const stepInfo = parseQuestionStepInfo(activeDialogRef.current.request.title);
          const isFinal = !stepInfo.isMultiStep || stepInfo.currentStep >= stepInfo.totalSteps;
          if (isFinal && !queueManager.isNavigating() && !queueManager.isAutoPlayActive()) {
            activeDialogRef.current = null;
            setActiveDialog(null);
            queueManager.clearFlowAnswers();
            setFlowAnswers([]);
          } else {
            const graceTimeout = queueManager.isNavigating() ? 1500 : 600;
            graceTimerRef.current = setTimeout(() => {
              activeDialogRef.current = null;
              setActiveDialog(null);
              graceTimerRef.current = null;
            }, graceTimeout);
          }
        } else {
          setActiveDialog(null);
        }
      }
    });

    return () => {
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      unsubscribe();
      // On unmount: cancel all pending dialogs so promises resolve
      queueManager.cancelPending();
    };
  }, [queueManager]);

  const dialogAdapter = useMemo(() => queueManager.asAdapter(), [queueManager]);

  const pendingCount = queue.length;
  const canGoBack = activeDialog ? queueManager.canGoBack(activeDialog.itemKey) : false;

  const handleSelect = useCallback(
    (itemKey: string, choice: string) => {
      queueManager.resolveByItemKey(itemKey, choice);
    },
    [queueManager]
  );

  const handleMultiSelectSubmit = useCallback(
    (itemKey: string, desiredToggled: boolean[]) => {
      queueManager.submitMultiSelect(itemKey, desiredToggled);
    },
    [queueManager]
  );

  const handleInput = useCallback(
    (itemKey: string, value: string) => {
      queueManager.resolveByItemKey(itemKey, value);
    },
    [queueManager]
  );

  const handleConfirm = useCallback(
    (itemKey: string, confirmed: boolean) => {
      queueManager.resolveByItemKey(itemKey, confirmed);
    },
    [queueManager]
  );

  const handleCancel = useCallback(
    (itemKey: string) => {
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      activeDialogRef.current = null;
      setActiveDialog(null);
      queueManager.clearFlowAnswers();
      setFlowAnswers([]);
      queueManager.cancelByItemKey(itemKey);
    },
    [queueManager]
  );

  const handleBack = useCallback(
    (
      itemKey: string,
      targetStep?: number,
      currentDraft?: Partial<AnsweredQuestionRecord>
    ) => {
      if (currentDraft && typeof currentDraft.step === 'number') {
        queueManager.recordFlowAnswer(
          currentDraft.step,
          currentDraft.question ?? `Pregunta ${currentDraft.step}`,
          currentDraft.answerText ?? '',
          {
            selectedLabels: currentDraft.selectedLabels,
            singleChoice: currentDraft.singleChoice,
            inputValue: currentDraft.inputValue,
            confirmValue: currentDraft.confirmValue,
          }
        );
        setFlowAnswers(queueManager.getFlowAnswers());
      }
      const active = queueManager.getActiveDialog();
      if (active && typeof targetStep === 'number') {
        const stepInfo = parseQuestionStepInfo(active.request.title);
        if (stepInfo.currentStep === targetStep) {
          return;
        }
      }
      queueManager.goBackByItemKey(itemKey, targetStep, currentDraft);
    },
    [queueManager]
  );

  const cancelPending = useCallback(
    (cwd?: string, activeCwd?: string) => {
      if (graceTimerRef.current) {
        clearTimeout(graceTimerRef.current);
        graceTimerRef.current = null;
      }
      activeDialogRef.current = null;
      setActiveDialog(null);
      queueManager.clearFlowAnswers();
      setFlowAnswers([]);
      queueManager.cancelPending(cwd, activeCwd);
    },
    [queueManager]
  );

  return {
    dialogQueue: queue,
    activeDialog,
    pendingCount,
    dialogAdapter,
    canGoBack,
    flowAnswers,
    handleSelect,
    handleMultiSelectSubmit,
    handleInput,
    handleConfirm,
    handleCancel,
    handleBack,
    cancelPending,
  };
}
