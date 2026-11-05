import type { SaveWorkspaceFilePayload, WorkspaceFileContent } from '@core/types/workspace';

const normalize = (text: string) => text.replace(/\r\n/g, '\n');

export interface EditorTarget {
  file: WorkspaceFileContent;
  workingDirectory?: string;
}

/** Keep the displayed file and its save directory together until a switch is approved. */
export function createEditorTarget(initial: EditorTarget | null) {
  let current = initial;
  return {
    current: () => current,
    switchTo(next: EditorTarget | null, allow: () => boolean) {
      if (!allow()) return false;
      current = next;
      return true;
    },
  };
}

/** State owned by the viewer; save is injected to keep the bridge boundary explicit. */
export function createFileEditor({ file, workingDirectory, save }: {
  file: WorkspaceFileContent;
  workingDirectory?: string;
  save: (payload: SaveWorkspaceFilePayload) => Promise<void>;
}) {
  let content = file.content;
  let draft = normalize(content);
  let editing = false;
  let saving = false;
  let error: string | null = null;
  const crlf = content.includes('\r\n') && !content.replace(/\r\n/g, '').includes('\n');
  const dirty = () => draft !== normalize(content);
  const snapshot = () => ({ content, draft, editing, saving, error, dirty: dirty() });
  const discard = (confirm: () => boolean) => {
    if (saving || (dirty() && !confirm())) return false;
    draft = normalize(content);
    editing = false;
    error = null;
    return true;
  };
  return {
    snapshot,
    edit() { editing = true; error = null; },
    setDraft(value: string) { draft = normalize(value); },
    cancel: discard,
    close: discard,
    async save() {
      if (saving) return;
      const submitted = draft;
      const next = crlf ? submitted.replace(/\n/g, '\r\n') : submitted;
      saving = true;
      error = null;
      try {
        await save({ workingDirectory, relativePath: file.relativePath, originalContent: content, content: next });
        content = next;
        if (draft === submitted) editing = false;
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
      } finally {
        saving = false;
      }
    },
  };
}
