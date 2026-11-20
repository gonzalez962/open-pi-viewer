import { mergeConsecutiveAssistantMessages } from '@core/process-grouping';
import type { ChatMessage } from '@core/types/messages';

export function groupMessagesByDay(messages: readonly ChatMessage[]) {
  const runs: { divider?: { date: Date; day: string }; messages: ChatMessage[] }[] = [];
  let run: (typeof runs)[number] = { messages: [] };
  let previousDay: string | undefined;

  for (const message of messages) {
    if (message.sentAtMs !== undefined) {
      const date = new Date(message.sentAtMs);
      const day = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
        String(date.getDate()).padStart(2, '0')].join('-');
      if (previousDay && day !== previousDay) {
        runs.push(run);
        run = { divider: { date, day }, messages: [] };
      }
      previousDay = day;
    }
    run.messages.push(message);
  }

  if (run.messages.length) runs.push(run);
  return runs.flatMap(({ divider, messages: runMessages }) =>
    mergeConsecutiveAssistantMessages(runMessages).map((message, index) => ({
      message,
      divider: index === 0 ? divider : undefined,
    })));
}
