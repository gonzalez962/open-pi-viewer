/**
 * Browser file download helper.
 * Generates an in-memory Blob and triggers native browser file save dialog.
 */
export function triggerFileDownload(
  content: string,
  filename: string,
  mimeType = 'text/markdown;charset=utf-8'
): boolean {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return false;
  }

  try {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';

    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 150);

    return true;
  } catch {
    return false;
  }
}
