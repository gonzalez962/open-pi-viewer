export function bindFileDropZone(zone: HTMLElement, enabled: boolean, onDrop: (transfer: DataTransfer) => void): () => void {
  let depth = 0;
  const reset = () => { depth = 0; zone.classList.remove('prompt-file-dragover'); };
  const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes('Files');
  const enter = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    if (enabled) zone.classList.add('prompt-file-dragover');
  };
  const over = (event: DragEvent) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = enabled ? 'copy' : 'none';
  };
  const leave = (event: DragEvent) => {
    if (hasFiles(event) && --depth <= 0) reset();
  };
  const drop = (event: DragEvent) => {
    reset();
    if (!hasFiles(event) || !event.dataTransfer) return;
    event.preventDefault();
    if (enabled) onDrop(event.dataTransfer);
  };
  zone.addEventListener('dragenter', enter);
  zone.addEventListener('dragover', over);
  zone.addEventListener('dragleave', leave);
  zone.addEventListener('drop', drop);
  return () => {
    reset();
    zone.removeEventListener('dragenter', enter);
    zone.removeEventListener('dragover', over);
    zone.removeEventListener('dragleave', leave);
    zone.removeEventListener('drop', drop);
  };
}
