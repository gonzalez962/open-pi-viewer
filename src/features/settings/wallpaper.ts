import {
  isSafeImageUrl,
  MAX_WALLPAPER_DATA_URL_LENGTH,
  type BackgroundImageConfig,
  type BackgroundImagePosition,
} from '@infra/preferences';
import type { TranslationKey } from '@shared/i18n';

/**
 * Stable low-level error codes for wallpaper processing failures.
 */
export type WallpaperErrorCode =
  | 'invalid_type'
  | 'file_empty'
  | 'file_too_large'
  | 'invalid_dimensions'
  | 'pixel_limit_exceeded'
  | 'compression_failed'
  | 'read_failed'
  | 'decode_failed'
  | 'aborted'
  | 'generic';

/**
 * Typed error class with stable codes for deterministic boundary classification.
 */
export class WallpaperProcessingError extends Error {
  readonly code: WallpaperErrorCode;

  constructor(code: WallpaperErrorCode, message: string) {
    super(message);
    this.name = 'WallpaperProcessingError';
    this.code = code;
    Object.setPrototypeOf(this, WallpaperProcessingError.prototype);
  }
}

/**
 * Maps a WallpaperProcessingError or unknown error to a localized translation key.
 * Avoids brittle string-matching error classification at the UI boundary.
 */
export function mapWallpaperErrorToTranslationKey(error: unknown): TranslationKey {
  if (error instanceof WallpaperProcessingError) {
    switch (error.code) {
      case 'invalid_type':
        return 'theme.bg_image_error_invalid_type';
      case 'file_empty':
      case 'file_too_large':
        return 'theme.bg_image_error_too_large';
      case 'pixel_limit_exceeded':
      case 'invalid_dimensions':
        return 'theme.bg_image_error_pixel_limit';
      case 'compression_failed':
        return 'theme.bg_image_error_compression';
      case 'read_failed':
        return 'theme.bg_image_error_read_failed';
      case 'decode_failed':
        return 'theme.bg_image_error_decode_failed';
      case 'generic':
      default:
        return 'theme.bg_image_error_generic';
    }
  }
  return 'theme.bg_image_error_generic';
}

/**
 * Maximum input file size before reading or decoding: 5 MiB (5,242,880 bytes).
 */
export const MAX_WALLPAPER_INPUT_FILE_SIZE = 5 * 1024 * 1024;

/**
 * Allowed input image MIME types. Non-raster formats like SVG are strictly rejected.
 */
export const ALLOWED_WALLPAPER_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
] as const;

export type AllowedWallpaperMimeType = (typeof ALLOWED_WALLPAPER_MIME_TYPES)[number];

/**
 * Maximum decoded pixel count allowed before canvas drawing: ~16 megapixels (4096 x 4096).
 */
export const MAX_WALLPAPER_DECODED_PIXELS = 16 * 1024 * 1024;

/**
 * Maximum output bounding box dimension in pixels (width or height).
 */
export const MAX_WALLPAPER_OUTPUT_DIMENSION = 1280;

/**
 * Stepped JPEG compression qualities attempted to satisfy the 1 MiB Data URL cap.
 */
export const WALLPAPER_JPEG_COMPRESSION_STEPS = [0.8, 0.6, 0.4, 0.2] as const;

export interface FileInputSummary {
  type: string;
  size: number;
}

export interface FileValidationResult {
  valid: boolean;
  errorCode?: WallpaperErrorCode;
  error?: string;
}

/**
 * Validates file input metadata before expensive memory reads or image decoding.
 */
export function validateWallpaperFileInput(file: FileInputSummary): FileValidationResult {
  if (!file || typeof file.size !== 'number' || !Number.isFinite(file.size)) {
    return { valid: false, errorCode: 'generic', error: 'Invalid file metadata' };
  }

  const rawType = (file.type || '').trim().toLowerCase();
  if (!ALLOWED_WALLPAPER_MIME_TYPES.includes(rawType as AllowedWallpaperMimeType)) {
    return {
      valid: false,
      errorCode: 'invalid_type',
      error: 'Unsupported image format. Allowed formats are JPEG, PNG, WebP, and GIF.',
    };
  }

  if (file.size <= 0) {
    return { valid: false, errorCode: 'file_empty', error: 'Image file is empty.' };
  }

  if (file.size > MAX_WALLPAPER_INPUT_FILE_SIZE) {
    return {
      valid: false,
      errorCode: 'file_too_large',
      error: 'Image file exceeds the maximum allowed size of 5 MiB.',
    };
  }

  return { valid: true };
}

/**
 * Returns true if the URL points to a remote web host (http or https).
 */
export function isRemoteImageUrl(url: unknown): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim().toLowerCase();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

/**
 * Safely escapes and formats a validated URL for CSS background-image url(...).
 * Uses JSON stringification to prevent quote, newline, or syntax injection.
 * Returns undefined if the URL is not validated safe.
 */
export function formatCssUrl(url: unknown): string | undefined {
  if (typeof url !== 'string' || !isSafeImageUrl(url)) {
    return undefined;
  }
  return `url(${JSON.stringify(url)})`;
}

export interface WallpaperLayerStyles {
  backgroundImage: string;
  backgroundSize: string;
  backgroundPosition: string;
  backgroundRepeat: string;
  opacity: number;
  filter?: string;
}

/**
 * Computes CSS styles for the wallpaper layer adhering to validated constraints.
 * Maps fit "repeat" to backgroundSize "auto" because "repeat" is not a valid CSS background-size.
 */
export function computeWallpaperStyles(
  config?: BackgroundImageConfig | null
): WallpaperLayerStyles | undefined {
  if (!config || !config.enabled || !config.url) {
    return undefined;
  }

  const cssUrl = formatCssUrl(config.url);
  if (!cssUrl) {
    return undefined;
  }

  const fit = config.fit || 'cover';
  // Critical fix: 'repeat' is not a valid CSS background-size value. Use 'auto'.
  const backgroundSize =
    fit === 'repeat'
      ? 'auto'
      : fit === 'contain'
        ? 'contain'
        : fit === '100% 100%'
          ? '100% 100%'
          : fit === 'auto'
            ? 'auto'
            : 'cover';

  const backgroundRepeat = config.repeat || fit === 'repeat' ? 'repeat' : 'no-repeat';

  const validPositions: BackgroundImagePosition[] = ['center', 'top', 'bottom', 'left', 'right'];
  const backgroundPosition = validPositions.includes(config.position) ? config.position : 'center';

  const opacity =
    typeof config.opacity === 'number' && Number.isFinite(config.opacity)
      ? Math.max(0, Math.min(1, config.opacity))
      : 0.4;

  const blur =
    typeof config.blur === 'number' && Number.isFinite(config.blur)
      ? Math.max(0, Math.min(30, config.blur))
      : 0;

  return {
    backgroundImage: cssUrl,
    backgroundSize,
    backgroundPosition,
    backgroundRepeat,
    opacity,
    ...(blur > 0 ? { filter: `blur(${blur}px)` } : {}),
  };
}

/**
 * Calculates target output dimensions bounded to maxDim while preserving aspect ratio.
 */
export function calculateTargetDimensions(
  width: number,
  height: number,
  maxDim: number = MAX_WALLPAPER_OUTPUT_DIMENSION
): { width: number; height: number } {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: 1, height: 1 };
  }

  if (width <= maxDim && height <= maxDim) {
    return { width: Math.round(width), height: Math.round(height) };
  }

  if (width > height) {
    const targetHeight = Math.max(1, Math.round((height * maxDim) / width));
    return { width: maxDim, height: targetHeight };
  } else {
    const targetWidth = Math.max(1, Math.round((width * maxDim) / height));
    return { width: targetWidth, height: maxDim };
  }
}

// ---------------------------------------------------------------------------
// Injectable Browser Adapter
// ---------------------------------------------------------------------------

export interface WallpaperImageInfo {
  width: number;
  height: number;
}

export interface WallpaperCanvasRenderParams {
  sourceDataUrl: string;
  sourceWidth: number;
  sourceHeight: number;
  targetWidth: number;
  targetHeight: number;
  quality: number;
}

export interface WallpaperBrowserAdapter {
  readFileAsDataUrl(file: File | Blob): Promise<string>;
  decodeImageDimensions(dataUrl: string): Promise<WallpaperImageInfo>;
  compressToDataUrl(params: WallpaperCanvasRenderParams): Promise<string>;
}

export const defaultWallpaperBrowserAdapter: WallpaperBrowserAdapter = {
  readFileAsDataUrl(file: File | Blob): Promise<string> {
    return new Promise((resolve, reject) => {
      if (typeof FileReader === 'undefined') {
        reject(new Error('FileReader is not supported in this environment'));
        return;
      }
      const reader = new FileReader();
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          resolve(reader.result);
        } else {
          reject(new Error('FileReader produced non-string result'));
        }
      };
      reader.onerror = () => {
        reject(reader.error || new Error('FileReader encountered a read error'));
      };
      reader.readAsDataURL(file);
    });
  },

  decodeImageDimensions(dataUrl: string): Promise<WallpaperImageInfo> {
    return new Promise((resolve, reject) => {
      if (typeof Image === 'undefined') {
        reject(new Error('Image constructor is not supported in this environment'));
        return;
      }
      const img = new Image();
      img.onload = () => {
        const width = img.naturalWidth || img.width;
        const height = img.naturalHeight || img.height;
        resolve({ width, height });
      };
      img.onerror = () => {
        reject(new Error('Failed to decode image data'));
      };
      img.src = dataUrl;
    });
  },

  compressToDataUrl(params: WallpaperCanvasRenderParams): Promise<string> {
    return new Promise((resolve, reject) => {
      if (typeof document === 'undefined') {
        reject(new Error('DOM document is not supported in this environment'));
        return;
      }
      const canvas = document.createElement('canvas');
      canvas.width = params.targetWidth;
      canvas.height = params.targetHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to acquire 2D canvas context'));
        return;
      }
      const img = new Image();
      img.onload = () => {
        try {
          ctx.drawImage(img, 0, 0, params.targetWidth, params.targetHeight);
          const compressed = canvas.toDataURL('image/jpeg', params.quality);
          resolve(compressed);
        } catch (err) {
          reject(err);
        }
      };
      img.onerror = () => {
        reject(new Error('Failed to load image for canvas compression'));
      };
      img.src = params.sourceDataUrl;
    });
  },
};

export interface ProcessWallpaperOptions {
  adapter?: WallpaperBrowserAdapter;
  signal?: AbortSignal;
}

export interface ProcessedWallpaperResult {
  dataUrl: string;
  width: number;
  height: number;
}

/**
 * Processes a wallpaper image file through the full bounded pipeline:
 * 1. Checks MIME and file size before read.
 * 2. Reads file to data URL via adapter.
 * 3. Decodes dimensions and verifies <= 16 MP limit.
 * 4. Resizes to max 1280px bounding box.
 * 5. Compresses via canvas stepped JPEG (0.8 -> 0.6 -> 0.4 -> 0.2) until <= 1 MiB cap.
 * Fails clearly without unbounded original-data fallback.
 */
export async function processWallpaperFile(
  file: File | Blob,
  options?: ProcessWallpaperOptions
): Promise<ProcessedWallpaperResult> {
  const adapter = options?.adapter || defaultWallpaperBrowserAdapter;
  const signal = options?.signal;

  // 1. Validate file metadata before reading
  const validation = validateWallpaperFileInput({
    type: file.type,
    size: file.size,
  });
  if (!validation.valid) {
    throw new WallpaperProcessingError(
      validation.errorCode || 'generic',
      validation.error || 'Invalid file metadata'
    );
  }

  if (signal?.aborted) {
    throw new WallpaperProcessingError('aborted', 'Wallpaper processing was aborted');
  }

  // 2. Read file to data URL
  let rawDataUrl: string;
  try {
    rawDataUrl = await adapter.readFileAsDataUrl(file);
  } catch (err: unknown) {
    if (signal?.aborted) {
      throw new WallpaperProcessingError('aborted', 'Wallpaper processing was aborted');
    }
    const msg = err instanceof Error ? err.message : 'FileReader encountered a read error';
    throw new WallpaperProcessingError('read_failed', msg);
  }

  if (signal?.aborted) {
    throw new WallpaperProcessingError('aborted', 'Wallpaper processing was aborted');
  }

  // 3. Decode dimensions and enforce resolution limits
  let dimensions: WallpaperImageInfo;
  try {
    dimensions = await adapter.decodeImageDimensions(rawDataUrl);
  } catch (err: unknown) {
    if (signal?.aborted) {
      throw new WallpaperProcessingError('aborted', 'Wallpaper processing was aborted');
    }
    const msg = err instanceof Error ? err.message : 'Failed to decode image data';
    throw new WallpaperProcessingError('decode_failed', msg);
  }

  if (signal?.aborted) {
    throw new WallpaperProcessingError('aborted', 'Wallpaper processing was aborted');
  }

  if (
    !Number.isFinite(dimensions.width) ||
    !Number.isFinite(dimensions.height) ||
    dimensions.width <= 0 ||
    dimensions.height <= 0
  ) {
    throw new WallpaperProcessingError('invalid_dimensions', 'Invalid image dimensions');
  }

  const pixelCount = dimensions.width * dimensions.height;
  if (pixelCount > MAX_WALLPAPER_DECODED_PIXELS) {
    throw new WallpaperProcessingError(
      'pixel_limit_exceeded',
      'Image resolution exceeds the 16 megapixels limit'
    );
  }

  // 4. Calculate bounded target dimensions
  const target = calculateTargetDimensions(
    dimensions.width,
    dimensions.height,
    MAX_WALLPAPER_OUTPUT_DIMENSION
  );

  // 5. Canvas compression loop
  let compressedUrl: string | null = null;
  for (const quality of WALLPAPER_JPEG_COMPRESSION_STEPS) {
    if (signal?.aborted) {
      throw new WallpaperProcessingError('aborted', 'Wallpaper processing was aborted');
    }
    try {
      const candidate = await adapter.compressToDataUrl({
        sourceDataUrl: rawDataUrl,
        sourceWidth: dimensions.width,
        sourceHeight: dimensions.height,
        targetWidth: target.width,
        targetHeight: target.height,
        quality,
      });

      if (candidate.length <= MAX_WALLPAPER_DATA_URL_LENGTH) {
        compressedUrl = candidate;
        break;
      }
    } catch (err: unknown) {
      if (signal?.aborted) {
        throw new WallpaperProcessingError('aborted', 'Wallpaper processing was aborted');
      }
      const msg = err instanceof Error ? err.message : 'Canvas compression error';
      throw new WallpaperProcessingError('compression_failed', msg);
    }
  }

  if (!compressedUrl) {
    // Fail clearly without unbounded original-data fallback
    throw new WallpaperProcessingError(
      'compression_failed',
      'Image could not be compressed to fit within the 1 MiB storage limit'
    );
  }

  return {
    dataUrl: compressedUrl,
    width: target.width,
    height: target.height,
  };
}

// ---------------------------------------------------------------------------
// Concurrency & Cancellation Coordinator
// ---------------------------------------------------------------------------

export type WallpaperCoordinatorListener = (state: {
  isProcessing: boolean;
  generation: number;
}) => void;

export class WallpaperProcessCoordinator {
  private currentGeneration = 0;
  private abortController: AbortController | null = null;
  private inFlight = false;
  private listeners = new Set<WallpaperCoordinatorListener>();

  start(): { generation: number; signal: AbortSignal } {
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.currentGeneration++;
    this.abortController = new AbortController();
    this.inFlight = true;
    this.notify();
    return {
      generation: this.currentGeneration,
      signal: this.abortController.signal,
    };
  }

  isActive(generation: number): boolean {
    return (
      this.inFlight &&
      generation === this.currentGeneration &&
      (!this.abortController || !this.abortController.signal.aborted)
    );
  }

  finish(generation: number): void {
    if (generation === this.currentGeneration) {
      this.inFlight = false;
      this.abortController = null;
      this.notify();
    }
  }

  cancel(): void {
    if (this.inFlight || this.abortController) {
      if (this.abortController) {
        this.abortController.abort();
        this.abortController = null;
      }
      this.inFlight = false;
      this.currentGeneration++;
      this.notify();
    }
  }

  isProcessing(): boolean {
    return this.inFlight;
  }

  subscribe(listener: WallpaperCoordinatorListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    const state = { isProcessing: this.inFlight, generation: this.currentGeneration };
    for (const listener of this.listeners) {
      listener(state);
    }
  }
}

// ---------------------------------------------------------------------------
// Bundled Wallpaper Presets
// ---------------------------------------------------------------------------

export interface BuiltinWallpaperPreset {
  id: string;
  nameKey: string;
  url: string;
}

export const BUILTIN_WALLPAPERS: readonly BuiltinWallpaperPreset[] = [
  {
    id: 'ninja-1080p',
    nameKey: 'theme.bg_image_preset_1080p',
    url: '/wallpapers/minimalist-ninja-1080p.jpg',
  },
  {
    id: 'ninja-original',
    nameKey: 'theme.bg_image_preset_original',
    url: '/wallpapers/minimalist-ninja.jpg',
  },
] as const;

export const DEFAULT_BUILTIN_WALLPAPER = BUILTIN_WALLPAPERS[0];
