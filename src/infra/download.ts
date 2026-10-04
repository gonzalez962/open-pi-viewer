/**
 * Injectable browser/host download adapter using Blob + temporary anchor click strategy.
 *
 * Designed for client-side text export (Markdown / JSON) without outer layer or React coupling.
 *
 * Semantics notice (Issue #59 / T2):
 * `initiated: true` signifies only that the host anchor click sequence was initiated.
 * In browser/webview environments, this triggers the download manager, but does NOT confirm
 * or guarantee that the file was saved to disk by the user or operating system (no browser save promises).
 */

export interface DownloadPayload {
  content: string;
  filename: string;
  mimeType?: string;
}

export interface DownloadResult {
  /** True when the download sequence was successfully initiated on the host. */
  success: boolean;
  /**
   * Explicit initiated flag reflecting that download was triggered,
   * NOT confirmed saved to persistent disk.
   */
  initiated: boolean;
  filename: string;
  error?: string;
}

export interface DownloadAnchorElement {
  href: string;
  download: string;
  rel?: string;
  style?: { display?: string; [key: string]: unknown };
  click: () => void;
}

export interface DownloadDocumentHost {
  createElement: (tagName: string) => unknown;
  body?: {
    appendChild: (node: unknown) => unknown;
    removeChild?: (node: unknown) => unknown;
  };
}

export interface DownloadHost {
  Blob?: typeof Blob;
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
  document?: DownloadDocumentHost;
  setTimeout?: (handler: () => void, timeout?: number) => unknown;
}

export interface DownloadOptions {
  host?: DownloadHost;
  /**
   * Milliseconds before revoking the temporary object URL.
   * Deferred revocation prevents the race condition where browsers fail to download
   * because the URL was revoked before the download manager started streaming.
   * Pass 0 for immediate revocation (e.g. test-only; offers NO download streaming race protection).
   * Default: 60,000 ms.
   */
  revokeDelayMs?: number;
}

export const DEFAULT_REVOKE_DELAY_MS = 60_000;
export const DEFAULT_MIME_TYPE = 'text/plain;charset=utf-8';

interface ResolvedHostCapabilities {
  BlobClass?: typeof Blob;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
  doc?: DownloadDocumentHost;
  scheduleTimeout?: (handler: () => void, timeout?: number) => unknown;
}

/**
 * Resolves host capabilities from injected host when provided,
 * or ambient environment when host is omitted.
 *
 * Isolation invariant: When an injected host is passed,
 * absent properties must NEVER silently fall back to ambient globals.
 */
function resolveCapabilities(host?: DownloadHost): ResolvedHostCapabilities {
  if (host !== undefined) {
    return {
      BlobClass: host.Blob,
      createUrl: host.createObjectURL,
      revokeUrl: host.revokeObjectURL,
      doc: host.document,
      scheduleTimeout: host.setTimeout,
    };
  }

  return {
    BlobClass: typeof Blob !== 'undefined' ? Blob : undefined,
    createUrl:
      typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
        ? (b: Blob) => URL.createObjectURL(b)
        : undefined,
    revokeUrl:
      typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function'
        ? (u: string) => URL.revokeObjectURL(u)
        : undefined,
    doc:
      typeof document !== 'undefined'
        ? (document as unknown as DownloadDocumentHost)
        : undefined,
    scheduleTimeout:
      typeof setTimeout !== 'undefined' ? setTimeout : undefined,
  };
}

function hasMandatoryCapabilities(caps: ResolvedHostCapabilities): boolean {
  return Boolean(
    typeof caps.BlobClass === 'function' &&
    typeof caps.createUrl === 'function' &&
    typeof caps.revokeUrl === 'function' &&
    caps.doc &&
    typeof caps.doc.createElement === 'function' &&
    caps.doc.body &&
    typeof caps.doc.body.appendChild === 'function' &&
    typeof caps.scheduleTimeout === 'function'
  );
}

/**
 * Checks whether the host environment provides Blob, URL.createObjectURL, URL.revokeObjectURL,
 * DOM document (createElement, body.appendChild), and setTimeout scheduler.
 */
export function isDownloadSupported(host?: DownloadHost): boolean {
  return hasMandatoryCapabilities(resolveCapabilities(host));
}

/**
 * Triggers a text file download on the host environment via Blob and hidden anchor.
 *
 * Lifecycle safety:
 * 1. Validates input and all mandatory host capabilities (Blob, URLs, DOM, setTimeout).
 * 2. Prepares Blob, Object URL, and anchor element; attaches anchor to body.
 * 3. Schedules delayed URL revocation BEFORE anchor.click(). If scheduling throws,
 *    aborts before click, immediately revokes URL, detaches element, and reports initiated: false.
 * 4. Invokes anchor.click() with delayed revocation already guaranteed. If click throws,
 *    immediately revokes URL (safe idempotent guard prevents double revoke on later timer).
 * 5. Best-effort removes anchor from body. Catching removeChild avoids interrupting initiation,
 *    though complete detach cannot be guaranteed if the host DOM throws.
 */
export function triggerDownload(
  payload: DownloadPayload,
  options?: DownloadOptions
): DownloadResult {
  const { content, filename, mimeType } = payload ?? {};

  if (!filename || typeof filename !== 'string' || filename.trim() === '') {
    return {
      success: false,
      initiated: false,
      filename: filename ?? '',
      error: 'Filename is required for download',
    };
  }

  if (typeof content !== 'string') {
    return {
      success: false,
      initiated: false,
      filename,
      error: 'Content must be a string for download',
    };
  }

  const caps = resolveCapabilities(options?.host);

  if (typeof caps.BlobClass !== 'function') {
    return {
      success: false,
      initiated: false,
      filename,
      error: 'Blob API is not available in host environment',
    };
  }

  if (typeof caps.createUrl !== 'function') {
    return {
      success: false,
      initiated: false,
      filename,
      error: 'URL.createObjectURL is not available in host environment',
    };
  }

  if (typeof caps.revokeUrl !== 'function') {
    return {
      success: false,
      initiated: false,
      filename,
      error: 'URL.revokeObjectURL is not available in host environment',
    };
  }

  if (
    !caps.doc ||
    typeof caps.doc.createElement !== 'function' ||
    !caps.doc.body ||
    typeof caps.doc.body.appendChild !== 'function'
  ) {
    return {
      success: false,
      initiated: false,
      filename,
      error: 'DOM document is not available for download',
    };
  }

  if (typeof caps.scheduleTimeout !== 'function') {
    return {
      success: false,
      initiated: false,
      filename,
      error: 'setTimeout scheduler is not available in host environment',
    };
  }

  let objectUrl: string | null = null;
  let attachedNode: unknown = null;
  let urlRevoked = false;

  const safeRevoke = () => {
    if (!urlRevoked && objectUrl && caps.revokeUrl) {
      urlRevoked = true;
      try {
        caps.revokeUrl(objectUrl);
      } catch {
        // Ignore
      }
    }
  };

  const safeDetach = () => {
    if (attachedNode && caps.doc?.body?.removeChild) {
      try {
        caps.doc.body.removeChild(attachedNode);
      } catch {
        // Documented: best-effort removal cannot guarantee detach if removeChild throws
      }
      attachedNode = null;
    }
  };

  try {
    const blob = new caps.BlobClass([content], {
      type: mimeType || DEFAULT_MIME_TYPE,
    });

    objectUrl = caps.createUrl(blob);
    if (!objectUrl || typeof objectUrl !== 'string') {
      throw new Error('createObjectURL failed to generate a valid URL string');
    }

    const element = caps.doc.createElement('a') as unknown as DownloadAnchorElement;
    if (!element || typeof element.click !== 'function') {
      throw new Error('createElement failed to produce a clickable anchor element');
    }

    element.href = objectUrl;
    element.download = filename;
    element.rel = 'noopener';
    if (element.style) {
      element.style.display = 'none';
    }

    caps.doc.body.appendChild(element);
    attachedNode = element;

    // Schedule delayed URL revocation BEFORE anchor.click().
    // If scheduling throws, execution jumps to catch before click(),
    // guaranteeing no partial initiation and immediate cleanup.
    const delay =
      typeof options?.revokeDelayMs === 'number'
        ? options.revokeDelayMs
        : DEFAULT_REVOKE_DELAY_MS;

    if (delay > 0) {
      caps.scheduleTimeout(safeRevoke, delay);
    }

    // Now trigger download click; delayed revocation is already safely registered
    element.click();

    // In test-only immediate mode (delay <= 0), revoke after click (no stream race protection)
    if (delay <= 0) {
      safeRevoke();
    }
  } catch (err) {
    // If failure happened anywhere before click completed (including scheduling failure),
    // clean up DOM and immediately revoke URL; honestly report initiated: false.
    safeDetach();
    safeRevoke();

    const message = err instanceof Error ? err.message : String(err);
    return {
      success: false,
      initiated: false,
      filename,
      error: message,
    };
  }

  // Click completed successfully. Best-effort DOM cleanup.
  safeDetach();

  return {
    success: true,
    initiated: true,
    filename,
  };
}

export interface DownloadAdapter {
  download: (payload: DownloadPayload) => DownloadResult;
  isSupported: () => boolean;
}

/**
 * Creates an injectable download adapter instance bound to configured options/host.
 */
export function createDownloadAdapter(options?: DownloadOptions): DownloadAdapter {
  return {
    download: (payload: DownloadPayload) => triggerDownload(payload, options),
    isSupported: () => isDownloadSupported(options?.host),
  };
}
