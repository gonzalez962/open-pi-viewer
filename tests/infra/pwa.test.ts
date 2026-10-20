import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  isPwaSupported,
  registerPwaServiceWorker,
  getDeferredInstallPrompt,
  promptPwaInstall,
  subscribePwaInstallAvailability,
  type BeforeInstallPromptEvent,
} from '@infra/pwa';

test('PWA manifest: valid JSON with required standalone PWA properties and existing icons', () => {
  const manifestPath = path.resolve(process.cwd(), 'public/manifest.json');
  assert.ok(fs.existsSync(manifestPath), 'manifest.json must exist in public/');

  const content = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.equal(content.name, 'Pi Viewer');
  assert.equal(content.short_name, 'Pi Viewer');
  assert.equal(content.display, 'standalone');
  assert.equal(content.start_url, '/');
  assert.equal(content.background_color, '#0d1117');
  assert.equal(content.theme_color, '#0d1117');
  assert.ok(Array.isArray(content.icons) && content.icons.length >= 2, 'manifest must have at least 2 icons');

  // Verify all icon paths exist in public/
  for (const icon of content.icons) {
    assert.ok(icon.src, 'icon must have src');
    assert.ok(icon.sizes, 'icon must have sizes');
    assert.ok(icon.type, 'icon must have type');
    const diskPath = path.resolve(process.cwd(), 'public', icon.src.replace(/^\//, ''));
    assert.ok(fs.existsSync(diskPath), `icon file must exist: ${diskPath}`);
  }
});

test('index.html: links manifest and mobile PWA meta tags', () => {
  const htmlPath = path.resolve(process.cwd(), 'index.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  assert.match(html, /<link rel="manifest" href="\/manifest\.json"/);
  assert.match(html, /<meta name="theme-color" content="#0d1117"/);
  assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes"/);
  assert.match(html, /<link rel="apple-touch-icon"/);
  assert.match(html, /<link rel="icon" type="image\/x-icon" href="\/favicon\.ico"/);
});

test('isPwaSupported: detects service worker availability in browser context', () => {
  assert.equal(isPwaSupported(undefined), false);
  assert.equal(isPwaSupported({} as Navigator), false);
  assert.equal(isPwaSupported({ serviceWorker: {} } as unknown as Navigator), true);
});

test('registerPwaServiceWorker: registers /push-sw.js with scope / on load', async () => {
  let registeredUrl = '';
  let registeredOpts: unknown = null;
  const mockSw = {
    register: async (url: string, opts?: unknown) => {
      registeredUrl = url;
      registeredOpts = opts;
      return {} as ServiceWorkerRegistration;
    },
  };

  const listeners: Record<string, () => void> = {};
  const mockWin = {
    document: { readyState: 'loading' },
    addEventListener: (event: string, handler: () => void) => {
      listeners[event] = handler;
    },
  } as unknown as Window;

  const mockNav = {
    serviceWorker: mockSw,
  } as unknown as Navigator;

  registerPwaServiceWorker({ windowObj: mockWin, navigatorObj: mockNav });

  // Trigger load event
  assert.ok(listeners['load'], 'Must register load listener when loading');
  listeners['load']();

  // Allow async register promise tick
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(registeredUrl, '/push-sw.js');
  assert.deepEqual(registeredOpts, { scope: '/' });
});

test('registerPwaServiceWorker: registers immediately if document already complete', async () => {
  let registeredUrl = '';
  const mockSw = {
    register: async (url: string) => {
      registeredUrl = url;
      return {} as ServiceWorkerRegistration;
    },
  };

  const mockWin = {
    document: { readyState: 'complete' },
    addEventListener: () => {},
  } as unknown as Window;

  const mockNav = {
    serviceWorker: mockSw,
  } as unknown as Navigator;

  registerPwaServiceWorker({ windowObj: mockWin, navigatorObj: mockNav });
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(registeredUrl, '/push-sw.js');
});

test('install prompt management: tracks beforeinstallprompt and user prompt response', async () => {
  let promptCalled = false;
  let listenersCount = 0;
  const mockEvent: BeforeInstallPromptEvent = {
    platforms: ['web'],
    userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
    prompt: async () => {
      promptCalled = true;
    },
  } as unknown as BeforeInstallPromptEvent;

  let eventListener: ((e: Event) => void) | null = null;
  const mockWin = {
    document: { readyState: 'complete' },
    addEventListener: (event: string, handler: (e: Event) => void) => {
      if (event === 'beforeinstallprompt') {
        eventListener = handler;
      }
    },
  } as unknown as Window;

  const mockNav = {
    serviceWorker: {
      register: async () => ({} as ServiceWorkerRegistration),
    },
  } as unknown as Navigator;

  registerPwaServiceWorker({ windowObj: mockWin, navigatorObj: mockNav });

  const unsub = subscribePwaInstallAvailability((canInstall) => {
    if (canInstall) listenersCount++;
  });

  assert.equal(getDeferredInstallPrompt(), null);
  assert.ok(eventListener, 'Must listen for beforeinstallprompt');

  // Trigger beforeinstallprompt
  (eventListener as (e: Event) => void)(mockEvent);

  assert.equal(getDeferredInstallPrompt(), mockEvent);
  assert.equal(listenersCount, 1);

  const outcome = await promptPwaInstall();
  assert.equal(outcome, 'accepted');
  assert.equal(promptCalled, true);
  assert.equal(getDeferredInstallPrompt(), null);

  unsub();
});
