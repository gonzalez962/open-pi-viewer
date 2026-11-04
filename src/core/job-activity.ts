export interface JobChange {
  id: string;
  active: boolean;
}

function text(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.map(item => typeof item?.text === 'string' ? item.text : '').join('\n') : '';
}

/** Extract only RPC-visible, successful job lifecycle evidence. */
export function parseJobChange(event: any): JobChange | null {
  let source: any;
  let active: boolean;
  let pattern: RegExp;
  if (event?.type === 'tool_execution_end') {
    if (event.isError || event.result?.isError || event.result?.details?.error) return null;
    if (event.toolName === 'bash_background' || event.toolName === 'monitor') {
      active = true;
      pattern = /Started (?:background job|monitor) (?:"[^"]+" )?\(?([a-zA-Z0-9_-]+)\)?/i;
    } else if (event.toolName === 'job_stop') {
      active = false;
      pattern = /Stopped (?:"[^"]+" )?\(?([a-zA-Z0-9_-]+)\)?/i;
    } else return null;
    source = event.result;
  } else if (event?.type === 'message_end' && event.message?.customType === 'gentle-jobs.notice') {
    active = false;
    pattern = /Background job (?:"[^"]+" )?\(?([a-zA-Z0-9_-]+)\)?(?: \("[^"]*"\))? exited/i;
    source = event.message;
    const details = source?.details?.gentleJobs;
    if (details?.event === 'events' || (details?.status && !['exited', 'failed', 'stopped'].includes(details.status))) return null;
  } else return null;
  const raw = source?.details?.gentleJobs?.jobId ?? source?.details?.gentleJobs?.id;
  const id = typeof raw === 'string' && raw.trim() ? raw.trim() : text(source?.content).match(pattern)?.[1];
  return id ? { id, active } : null;
}

export function applyJobChange(jobs: string[], change: JobChange): string[] {
  if (change.active) return jobs.includes(change.id) ? jobs : [...jobs, change.id];
  return jobs.filter(id => id !== change.id);
}
