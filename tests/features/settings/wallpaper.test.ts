import assert from 'node:assert';
import test from 'node:test';

import {
  ALLOWED_WALLPAPER_MIME_TYPES,
  MAX_WALLPAPER_INPUT_FILE_SIZE,
  MAX_WALLPAPER_OUTPUT_DIMENSION,
  validateWallpaperFileInput,
  calculateTargetDimensions,
  formatCssUrl,
  computeWallpaperStyles,
  processWallpaperFile,
  WallpaperProcessCoordinator,
  WallpaperProcessingError,
  mapWallpaperErrorToTranslationKey,
  type WallpaperBrowserAdapter,
  type WallpaperCanvasRenderParams,
} from '@features/settings/wallpaper';
import {
  MAX_WALLPAPER_DATA_URL_LENGTH,
  type BackgroundImageConfig,
} from '@infra/preferences';
import { AppearanceLifecycleController } from '@features/settings/appearance';

// ---------------------------------------------------------------------------
// 1. Bounded Input Validation (MIME & File Size)
// ---------------------------------------------------------------------------

test('wallpaper: validateWallpaperFileInput accepts standard raster types within 5 MiB', () => {
  for (const mime of ALLOWED_WALLPAPER_MIME_TYPES) {
    const valid = validateWallpaperFileInput({
      type: mime,
      size: 2 * 1024 * 1024,
    });
    assert.equal(valid.valid, true, `MIME ${mime} should be accepted`);
    assert.equal(valid.error, undefined);
  }
});

test('wallpaper: validateWallpaperFileInput rejects SVG and non-raster formats', () => {
  const rejectedMimes = [
    'image/svg+xml',
    'image/tiff',
    'image/vnd.microsoft.icon',
    'application/pdf',
    'text/plain',
    'video/mp4',
    '',
  ];

  for (const mime of rejectedMimes) {
    const result = validateWallpaperFileInput({
      type: mime,
      size: 1024,
    });
    assert.equal(result.valid, false, `MIME ${mime} must be rejected`);
    assert.match(result.error ?? '', /format|type/i);
  }
});

test('wallpaper: validateWallpaperFileInput rejects files exceeding 5 MiB or non-positive sizes', () => {
  // Exceeds 5 MiB
  const oversized = validateWallpaperFileInput({
    type: 'image/jpeg',
    size: MAX_WALLPAPER_INPUT_FILE_SIZE + 1,
  });
  assert.equal(oversized.valid, false);
  assert.match(oversized.error ?? '', /size|limit|5/i);

  // Exactly 5 MiB is allowed
  const exact = validateWallpaperFileInput({
    type: 'image/jpeg',
    size: MAX_WALLPAPER_INPUT_FILE_SIZE,
  });
  assert.equal(exact.valid, true);

  // Empty or invalid sizes
  const zeroSize = validateWallpaperFileInput({
    type: 'image/jpeg',
    size: 0,
  });
  assert.equal(zeroSize.valid, false);

  const negativeSize = validateWallpaperFileInput({
    type: 'image/jpeg',
    size: -10,
  });
  assert.equal(negativeSize.valid, false);
});

// ---------------------------------------------------------------------------
// 2. Safe URL Validation & CSS URL Escaping
// ---------------------------------------------------------------------------

test('wallpaper: formatCssUrl properly escapes URLs using JSON stringification and rejects unsafe URLs', () => {
  // Bundled wallpapers
  assert.equal(
    formatCssUrl('/wallpapers/minimalist-ninja-1080p.jpg'),
    'url("/wallpapers/minimalist-ninja-1080p.jpg")'
  );

  // Safe HTTPS URL
  assert.equal(
    formatCssUrl('https://example.com/bg.png'),
    'url("https://example.com/bg.png")'
  );

  // Injection attempt: quotes and newlines safely JSON-escaped
  const injected = 'https://example.com/test"style="bad\n';
  const escaped = formatCssUrl(injected);
  assert.equal(escaped, 'url("https://example.com/test\\"style=\\"bad\\n")');

  // Unsafe schemes rejected cleanly (returns undefined)
  assert.equal(formatCssUrl('javascript:alert(1)'), undefined);
  assert.equal(formatCssUrl('vbscript:msgbox(1)'), undefined);
  assert.equal(formatCssUrl('/wallpapers/../../etc/passwd'), undefined);
  assert.equal(formatCssUrl(''), undefined);
  assert.equal(formatCssUrl(null), undefined);
});

// ---------------------------------------------------------------------------
// 3. Wallpaper Layer Styles Computation (fit repeat mapping)
// ---------------------------------------------------------------------------

test('wallpaper: computeWallpaperStyles maps fit "repeat" to backgroundSize "auto" and respects validated bounds', () => {
  const repeatConfig: BackgroundImageConfig = {
    enabled: true,
    url: '/wallpapers/minimalist-ninja-1080p.jpg',
    fit: 'repeat',
    position: 'center',
    repeat: false,
    opacity: 0.6,
    blur: 5,
  };

  const styles = computeWallpaperStyles(repeatConfig);
  assert.ok(styles, 'Styles should be computed');
  // Critical requirement: backgroundSize for repeat must be valid "auto"
  assert.equal(styles.backgroundSize, 'auto', 'fit repeat backgroundSize must be auto');
  assert.equal(styles.backgroundRepeat, 'repeat');
  assert.equal(styles.backgroundPosition, 'center');
  assert.equal(styles.opacity, 0.6);
  assert.equal(styles.filter, 'blur(5px)');
});

test('wallpaper: computeWallpaperStyles handles cover, contain, stretch, and clamps bounds', () => {
  const stretchConfig: BackgroundImageConfig = {
    enabled: true,
    url: 'https://example.com/img.jpg',
    fit: '100% 100%',
    position: 'top',
    repeat: false,
    opacity: 1.5, // Should clamp to 1
    blur: 45, // Should clamp to 30
  };

  const styles = computeWallpaperStyles(stretchConfig);
  assert.ok(styles);
  assert.equal(styles.backgroundSize, '100% 100%');
  assert.equal(styles.backgroundPosition, 'top');
  assert.equal(styles.opacity, 1);
  assert.equal(styles.filter, 'blur(30px)');

  // Disabled or empty URL returns undefined
  assert.equal(computeWallpaperStyles({ ...stretchConfig, enabled: false }), undefined);
  assert.equal(computeWallpaperStyles({ ...stretchConfig, url: '' }), undefined);
  assert.equal(computeWallpaperStyles(null), undefined);
});

// ---------------------------------------------------------------------------
// 4. Output Dimension Bounding (Max 1280px)
// ---------------------------------------------------------------------------

test('wallpaper: calculateTargetDimensions scales down to max 1280px maintaining aspect ratio', () => {
  // Landscape larger than 1280
  const landscape = calculateTargetDimensions(2560, 1440, MAX_WALLPAPER_OUTPUT_DIMENSION);
  assert.equal(landscape.width, 1280);
  assert.equal(landscape.height, 720);

  // Portrait larger than 1280
  const portrait = calculateTargetDimensions(1080, 1920, MAX_WALLPAPER_OUTPUT_DIMENSION);
  assert.equal(portrait.width, 720);
  assert.equal(portrait.height, 1280);

  // Already within 1280
  const small = calculateTargetDimensions(800, 600, MAX_WALLPAPER_OUTPUT_DIMENSION);
  assert.equal(small.width, 800);
  assert.equal(small.height, 600);

  // Exact 1280
  const exact = calculateTargetDimensions(1280, 1280, MAX_WALLPAPER_OUTPUT_DIMENSION);
  assert.equal(exact.width, 1280);
  assert.equal(exact.height, 1280);
});

// ---------------------------------------------------------------------------
// 5. Injected Browser Adapter & Processing Pipeline
// ---------------------------------------------------------------------------

function createMockAdapter(overrides?: Partial<WallpaperBrowserAdapter>): WallpaperBrowserAdapter {
  return {
    readFileAsDataUrl: async () => 'data:image/jpeg;base64,mockrawdata',
    decodeImageDimensions: async () => ({ width: 1920, height: 1080 }),
    compressToDataUrl: async (params: WallpaperCanvasRenderParams) =>
      `data:image/jpeg;base64,compressed_q${params.quality}_${params.targetWidth}x${params.targetHeight}`,
    ...overrides,
  };
}

test('wallpaper: processWallpaperFile succeeds within bounds using adapter', async () => {
  const adapter = createMockAdapter();
  const mockFile = {
    type: 'image/jpeg',
    size: 1024 * 500,
  } as unknown as File;

  const result = await processWallpaperFile(mockFile, { adapter });
  assert.ok(result.dataUrl.startsWith('data:image/jpeg;base64,'));
  assert.equal(result.width, 1280);
  assert.equal(result.height, 720);
});

test('wallpaper: processWallpaperFile rejects decoded images exceeding 16 megapixels', async () => {
  // 5000 x 4000 = 20 MP > 16 MP limit
  const adapter = createMockAdapter({
    decodeImageDimensions: async () => ({ width: 5000, height: 4000 }),
  });
  const mockFile = {
    type: 'image/jpeg',
    size: 2 * 1024 * 1024,
  } as unknown as File;

  await assert.rejects(
    async () => {
      await processWallpaperFile(mockFile, { adapter });
    },
    /16 megapixels|resolution limit/i
  );
});

test('wallpaper: processWallpaperFile steps down JPEG compression quality to fit under 1 MiB', async () => {
  const attemptedQualities: number[] = [];

  const adapter = createMockAdapter({
    compressToDataUrl: async (params) => {
      attemptedQualities.push(params.quality);
      if (params.quality >= 0.8) {
        // Exceeds 1 MiB cap
        return 'data:image/jpeg;base64,' + 'x'.repeat(MAX_WALLPAPER_DATA_URL_LENGTH + 10);
      }
      // Fits under 1 MiB at lower quality
      return 'data:image/jpeg;base64,' + 'x'.repeat(500000);
    },
  });

  const mockFile = {
    type: 'image/jpeg',
    size: 3 * 1024 * 1024,
  } as unknown as File;

  const result = await processWallpaperFile(mockFile, { adapter });
  assert.ok(result.dataUrl.length <= MAX_WALLPAPER_DATA_URL_LENGTH);
  assert.deepEqual(attemptedQualities, [0.8, 0.6]);
});

test('wallpaper: processWallpaperFile fails clearly when all compression attempts exceed 1 MiB without unbounded fallback', async () => {
  const adapter = createMockAdapter({
    compressToDataUrl: async () => {
      // Always exceeds 1 MiB
      return 'data:image/jpeg;base64,' + 'x'.repeat(MAX_WALLPAPER_DATA_URL_LENGTH + 100);
    },
  });

  const mockFile = {
    type: 'image/jpeg',
    size: 3 * 1024 * 1024,
  } as unknown as File;

  await assert.rejects(
    async () => {
      await processWallpaperFile(mockFile, { adapter });
    },
    /1 MiB|storage limit|compress/i
  );
});

test('wallpaper: processWallpaperFile surfaces FileReader and decode errors gracefully', async () => {
  // FileReader read error
  const failReadAdapter = createMockAdapter({
    readFileAsDataUrl: async () => {
      throw new Error('Disk read failure');
    },
  });

  await assert.rejects(
    async () => {
      await processWallpaperFile({ type: 'image/png', size: 1000 } as File, {
        adapter: failReadAdapter,
      });
    },
    /Disk read failure/
  );

  // Decode error
  const failDecodeAdapter = createMockAdapter({
    decodeImageDimensions: async () => {
      throw new Error('Corrupt image headers');
    },
  });

  await assert.rejects(
    async () => {
      await processWallpaperFile({ type: 'image/png', size: 1000 } as File, {
        adapter: failDecodeAdapter,
      });
    },
    /Corrupt image headers/
  );
});

// ---------------------------------------------------------------------------
// 6. Concurrency & Request Cancellation (Async race protection)
// ---------------------------------------------------------------------------

test('wallpaper: WallpaperProcessCoordinator invalidates previous requests on new start and cancel', () => {
  const coordinator = new WallpaperProcessCoordinator();

  const req1 = coordinator.start();
  assert.equal(req1.generation, 1);
  assert.equal(coordinator.isActive(req1.generation), true);
  assert.equal(req1.signal.aborted, false);

  // Start req2 supersedes req1
  const req2 = coordinator.start();
  assert.equal(req2.generation, 2);
  assert.equal(coordinator.isActive(req1.generation), false, 'Req 1 must be inactive');
  assert.equal(req1.signal.aborted, true, 'Req 1 signal must be aborted');
  assert.equal(coordinator.isActive(req2.generation), true);

  // Cancel aborts req2
  coordinator.cancel();
  assert.equal(coordinator.isActive(req2.generation), false);
  assert.equal(req2.signal.aborted, true);
});

// ---------------------------------------------------------------------------
// 7. Draft / Live Preview Lifecycle & Persistence Atomicity
// ---------------------------------------------------------------------------

test('wallpaper: updating wallpaper in draft updates preview without persisting until confirmed', () => {
  let savedState: any = {
    theme: 'dark',
    customBackground: null,
  };
  let commitCalls = 0;

  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => savedState,
    commitAppearance: (candidate) => {
      commitCalls++;
      savedState = { ...savedState, ...candidate };
      return { success: true };
    },
  });

  controller.begin();
  assert.equal(commitCalls, 0);

  // Update wallpaper in draft
  const newImageConfig: BackgroundImageConfig = {
    enabled: true,
    url: '/wallpapers/minimalist-ninja-1080p.jpg',
    fit: 'cover',
    position: 'center',
    repeat: false,
    opacity: 0.5,
    blur: 0,
  };

  controller.update({
    customBackground: {
      image: newImageConfig,
    },
  });

  assert.equal(commitCalls, 0, 'Updating wallpaper must not write to storage early');
  assert.equal(controller.getState().isDirty, true);
  assert.deepEqual(
    controller.getState().effectiveAppearance.customBackground?.image,
    newImageConfig
  );

  // Cancel restores prior appearance completely
  controller.cancel();
  assert.equal(commitCalls, 0);
  assert.equal(controller.getState().effectiveAppearance.customBackground, null);

  // Draft, update, confirm persists atomically
  controller.begin();
  controller.update({
    customBackground: {
      image: newImageConfig,
    },
  });
  const res = controller.confirm();
  assert.equal(res.success, true);
  assert.equal(commitCalls, 1);
  assert.deepEqual(savedState.customBackground?.image, newImageConfig);
});

test('wallpaper: persistence failure retains draft and leaves live state uncorrupted', () => {
  let commitAttempts = 0;
  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => ({ theme: 'dark', customBackground: null }),
    commitAppearance: () => {
      commitAttempts++;
      return { success: false, error: 'Simulated localStorage QuotaExceededError' };
    },
  });

  controller.begin();
  controller.update({
    customBackground: {
      image: {
        enabled: true,
        url: '/wallpapers/minimalist-ninja-1080p.jpg',
        fit: 'cover',
        position: 'center',
        repeat: false,
        opacity: 0.5,
        blur: 0,
      },
    },
  });

  const res = controller.confirm();
  assert.equal(res.success, false);
  assert.equal(commitAttempts, 1);
  // Draft retained, not lost
  assert.equal(controller.getState().isDrafting, true);
  assert.ok(controller.getState().error?.includes('QuotaExceededError'));
});

// ---------------------------------------------------------------------------
// 8. Typed WallpaperProcessingError & Localization Mapping
// ---------------------------------------------------------------------------

test('wallpaper: WallpaperProcessingError exposes stable error codes and maps to localized keys', async () => {
  const err = new WallpaperProcessingError('pixel_limit_exceeded', 'Diagnostics in English');
  assert.equal(err.name, 'WallpaperProcessingError');
  assert.equal(err.code, 'pixel_limit_exceeded');
  assert.equal(err.message, 'Diagnostics in English');
  assert.equal(mapWallpaperErrorToTranslationKey(err), 'theme.bg_image_error_pixel_limit');

  assert.equal(
    mapWallpaperErrorToTranslationKey(new WallpaperProcessingError('invalid_type', 'bad mime')),
    'theme.bg_image_error_invalid_type'
  );
  assert.equal(
    mapWallpaperErrorToTranslationKey(new WallpaperProcessingError('file_too_large', 'oversized')),
    'theme.bg_image_error_too_large'
  );
  assert.equal(
    mapWallpaperErrorToTranslationKey(new WallpaperProcessingError('compression_failed', 'cannot fit')),
    'theme.bg_image_error_compression'
  );
  assert.equal(
    mapWallpaperErrorToTranslationKey(new WallpaperProcessingError('read_failed', 'disk error')),
    'theme.bg_image_error_read_failed'
  );
  assert.equal(
    mapWallpaperErrorToTranslationKey(new WallpaperProcessingError('decode_failed', 'corrupt')),
    'theme.bg_image_error_decode_failed'
  );
  assert.equal(
    mapWallpaperErrorToTranslationKey(new Error('arbitrary unknown')),
    'theme.bg_image_error_generic'
  );
});

// ---------------------------------------------------------------------------
// 9. WallpaperProcessCoordinator Subscription & Synchronous Lifecycle Invalidation
// ---------------------------------------------------------------------------

test('wallpaper: WallpaperProcessCoordinator notifies subscribers and supports synchronous cancellation', () => {
  const coordinator = new WallpaperProcessCoordinator();
  const events: Array<{ isProcessing: boolean; generation: number }> = [];

  const unsubscribe = coordinator.subscribe((state) => {
    events.push({ ...state });
  });

  const req1 = coordinator.start();
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { isProcessing: true, generation: 1 });
  assert.equal(coordinator.isProcessing(), true);

  coordinator.cancel();
  assert.equal(events.length, 2);
  assert.deepEqual(events[1], { isProcessing: false, generation: 2 });
  assert.equal(coordinator.isProcessing(), false);
  assert.equal(req1.signal.aborted, true);
  assert.equal(coordinator.isActive(req1.generation), false);

  unsubscribe();
  coordinator.start();
  assert.equal(events.length, 2, 'Unsubscribed listener should not receive further events');
});

// ---------------------------------------------------------------------------
// 10. Competing Intent Deferred Sequences (Upload vs Manual URL, Toggle, Builtin, Clear, Confirm, Cancel, Reset)
// ---------------------------------------------------------------------------

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

test('wallpaper deferred: competing manual URL cancels pending upload and ignores stale resolution', async () => {
  const coordinator = new WallpaperProcessCoordinator();
  const deferred = createDeferred<string>();

  const adapter = createMockAdapter({
    readFileAsDataUrl: () => deferred.promise,
  });

  const { generation, signal } = coordinator.start();
  const uploadPromise = processWallpaperFile({ type: 'image/jpeg', size: 1000 } as File, {
    adapter,
    signal,
  });

  assert.equal(coordinator.isProcessing(), true);

  // User applies manual URL while upload is in flight
  coordinator.cancel();
  assert.equal(coordinator.isProcessing(), false);
  assert.equal(coordinator.isActive(generation), false);

  // Later, deferred upload resolves
  deferred.resolve('data:image/jpeg;base64,stale_upload_result');

  // Upload should reject with aborted or resolve but coordinator inactive
  try {
    await uploadPromise;
  } catch (err: any) {
    assert.ok(err instanceof WallpaperProcessingError || err.message.includes('abort'));
  }
  assert.equal(coordinator.isActive(generation), false);
});

test('wallpaper deferred: toggle disable cancels pending upload and prevents stale re-enable', async () => {
  const coordinator = new WallpaperProcessCoordinator();
  const deferred = createDeferred<string>();

  const adapter = createMockAdapter({
    readFileAsDataUrl: () => deferred.promise,
  });

  const { generation, signal } = coordinator.start();
  let draftEnabled = true;
  let draftUrl = '';

  const uploadPromise = (async () => {
    try {
      const res = await processWallpaperFile({ type: 'image/jpeg', size: 1000 } as File, {
        adapter,
        signal,
      });
      if (coordinator.isActive(generation)) {
        draftEnabled = true;
        draftUrl = res.dataUrl;
      }
    } catch {
      // Ignored if superseded
    }
  })();

  // Competing user intent: uncheck enable toggle
  coordinator.cancel();
  draftEnabled = false;

  // Deferred upload finishes later
  deferred.resolve('data:image/jpeg;base64,stale_toggle_data');
  await uploadPromise;

  assert.equal(draftEnabled, false, 'Stale upload must never re-enable wallpaper');
  assert.equal(draftUrl, '', 'Stale upload must not overwrite draft URL');
});

test('wallpaper deferred: parent confirm/cancel/reset synchronously cancels pending upload', async () => {
  const coordinator = new WallpaperProcessCoordinator();
  const deferred = createDeferred<string>();

  const adapter = createMockAdapter({
    readFileAsDataUrl: () => deferred.promise,
  });

  let savedState: any = { theme: 'dark', customBackground: null };
  const controller = new AppearanceLifecycleController({
    getSavedAppearance: () => savedState,
    commitAppearance: (c) => {
      savedState = { ...savedState, ...c };
      return { success: true };
    },
  });

  controller.begin();

  // Start upload
  const { generation, signal } = coordinator.start();
  let uploadApplied = false;

  const inFlightUpload = (async () => {
    try {
      const res = await processWallpaperFile({ type: 'image/jpeg', size: 1000 } as File, {
        adapter,
        signal,
      });
      if (coordinator.isActive(generation)) {
        uploadApplied = true;
        controller.update({ customBackground: { image: { enabled: true, url: res.dataUrl, fit: 'cover', position: 'center', repeat: false, opacity: 0.5, blur: 0 } } });
      }
    } catch {}
  })();

  // Parent confirm is invoked: coordinator cancels BEFORE atomic commit
  coordinator.cancel();
  const saveRes = controller.confirm();
  assert.equal(saveRes.success, true);

  // In-flight upload completes in the background afterwards
  deferred.resolve('data:image/jpeg;base64,late_save_data');
  await inFlightUpload;

  assert.equal(uploadApplied, false, 'Upload must not apply after parent confirm');
  assert.equal(savedState.customBackground, null, 'Saved state must not contain late upload');
  assert.equal(controller.getState().isDrafting, false);
});
