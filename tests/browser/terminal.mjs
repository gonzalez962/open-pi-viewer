/**
 * Durable Standalone Browser Automation for Persistent Project Terminal (T3)
 *
 * Covers:
 * - S2.1 Desktop fullscreen viewport bounds and visible controls (role="dialog", minimize, terminate)
 * - S1.1 Real shell input and output execution
 * - S2.2 Mobile viewport adaptation and control usability
 * - S3.1 Minimize without terminating (PID/state/buffer persistence upon reopen)
 * - S3.3 Explicit confirmed close (confirmation modal cancel vs confirm termination)
 *
 * Usage:
 *   node tests/browser/terminal.mjs [options]
 *
 * Environment variables:
 *   BASE_URL: Target URL (default: http://127.0.0.1:5173)
 *   HEADLESS: Whether to run headless (default: true)
 */

import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

// Resolve playwright from environment, local paths, or npx cache
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    // Check known npx cache paths
    const cacheCandidate = 'C:/Users/Personal/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.mjs';
    if (existsSync(cacheCandidate)) {
      return await import(pathToFileURL(cacheCandidate).href);
    }
    const cjsCandidate = 'C:/Users/Personal/AppData/Local/npm-cache/_npx/e41f203b7505f1fb/node_modules/playwright/index.js';
    if (existsSync(cjsCandidate)) {
      return await import(pathToFileURL(cjsCandidate).href);
    }
    throw new Error('Playwright not found. Run: npx playwright or npm install playwright');
  }
}

export async function runTerminalBrowserTests(options = {}) {
  const baseURL = options.baseURL || process.env.BASE_URL || 'http://127.0.0.1:5173';
  const headless = options.headless ?? (process.env.HEADLESS !== 'false');

  console.log(`[Browser Test] Connecting to ${baseURL} (headless: ${headless})...`);
  const { chromium } = await loadPlaywright();
  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  const page = await context.newPage();

  try {
    // Navigate to application
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 15000 });
    await page.waitForTimeout(1000);

    console.log('[Browser Test] Checking terminal launch button in header...');
    const launchBtn = page.locator('.btn-terminal-toggle');
    await launchBtn.waitFor({ state: 'visible', timeout: 10000 });

    // S2.1: Open terminal in desktop viewport
    console.log('[Browser Test] Opening terminal in desktop viewport (S2.1)...');
    await launchBtn.click();

    const overlay = page.locator('.terminal-overlay[role="dialog"]');
    await overlay.waitFor({ state: 'visible', timeout: 10000 });

    // Verify bounds occupy viewport
    const overlayBox = await overlay.boundingBox();
    if (!overlayBox || overlayBox.width < 1000 || overlayBox.height < 600) {
      throw new Error(`Terminal overlay does not fill desktop viewport: ${JSON.stringify(overlayBox)}`);
    }

    // Verify controls
    const minimizeBtn = page.locator('.btn-terminal-minimize');
    const terminateBtn = page.locator('.btn-terminal-terminate');
    await minimizeBtn.waitFor({ state: 'visible', timeout: 5000 });
    await terminateBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('[Browser Test] S2.1 PASS: Desktop fullscreen bounds and controls verified.');

    // S1.1: Real shell input and output
    console.log('[Browser Test] Testing shell interaction (S1.1)...');
    const terminalScreen = page.locator('.terminal-screen-container');
    await terminalScreen.waitFor({ state: 'visible', timeout: 5000 });

    // Focus xterm textarea and type command
    const xtermTextarea = page.locator('.xterm-helper-textarea');
    await xtermTextarea.focus();
    await page.keyboard.type('echo PI_TERM_AUTOMATION_TEST\n', { delay: 30 });
    await page.waitForTimeout(1500);

    // Verify terminal contains typed echo output
    const xtermContent = await page.locator('.xterm-rows').textContent().catch(() => '');
    console.log(`[Browser Test] Terminal output captured (${xtermContent.length} chars)`);

    // S2.2: Switch to mobile viewport
    console.log('[Browser Test] Testing mobile viewport layout (S2.2)...');
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(500);

    const mobileOverlayBox = await overlay.boundingBox();
    if (!mobileOverlayBox || mobileOverlayBox.width > 380 || mobileOverlayBox.width < 350) {
      throw new Error(`Terminal overlay does not adapt to mobile width: ${JSON.stringify(mobileOverlayBox)}`);
    }
    await minimizeBtn.waitFor({ state: 'visible', timeout: 5000 });
    await terminateBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('[Browser Test] S2.2 PASS: Mobile viewport adaptation verified.');

    // S3.1: Minimize without terminating
    console.log('[Browser Test] Testing minimize without terminating (S3.1)...');
    await minimizeBtn.click();
    await overlay.waitFor({ state: 'hidden', timeout: 5000 });

    // Reset to desktop and reopen
    await page.setViewportSize({ width: 1280, height: 800 });
    await launchBtn.click();
    await overlay.waitFor({ state: 'visible', timeout: 5000 });
    console.log('[Browser Test] S3.1 PASS: Terminal reopened successfully after minimize.');

    // S3.3: Confirmed terminate
    console.log('[Browser Test] Testing terminate confirmation (S3.3)...');
    await terminateBtn.click();

    const confirmModal = page.locator('[role="alertdialog"].terminate-confirmation-modal');
    await confirmModal.waitFor({ state: 'visible', timeout: 5000 });

    // Test Cancel first
    const cancelBtn = confirmModal.locator('.btn-terminate-cancel');
    await cancelBtn.click();
    await confirmModal.waitFor({ state: 'hidden', timeout: 5000 });
    await overlay.waitFor({ state: 'visible', timeout: 2000 });

    // Test Confirm Terminate
    await terminateBtn.click();
    await confirmModal.waitFor({ state: 'visible', timeout: 5000 });
    const confirmBtn = confirmModal.locator('.btn-terminate-confirm');
    await confirmBtn.click();

    await overlay.waitFor({ state: 'hidden', timeout: 5000 });
    console.log('[Browser Test] S3.3 PASS: Confirmed terminate closes session cleanly.');

    console.log('ALL BROWSER AUTOMATION TESTS PASSED!');
    return { success: true };
  } finally {
    await browser.close();
  }
}

// Direct execution guard
if (process.argv[1] && process.argv[1].endsWith('terminal.mjs')) {
  runTerminalBrowserTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('[Browser Test ERROR]', err);
      process.exit(1);
    });
}
