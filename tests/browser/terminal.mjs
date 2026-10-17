/**
 * Durable Standalone Browser Automation for Persistent Project Terminal (T3)
 *
 * Implements authoritative behavioral specifications:
 * - S2.1 Desktop fullscreen viewport bounds and controls
 * - S1.1 Real shell command output proven beyond echoed input (unique arithmetic marker)
 * - S2.2 Mobile viewport adaptation, control usability, and backend PTY resize
 * - S3.1 Minimize without terminating, PID/state/buffer persistence, and page reload
 * - S1.2 & S3.2 Project A/B isolation & session survival across project switches
 * - S3.3 Explicit confirmed close: Cancel retains process, Confirm terminates only targeted session,
 *        surviving project unaffected, reopen creates fresh session with new PID and clean buffer.
 *
 * Usage:
 *   node tests/browser/terminal.mjs [options]
 *   npm run test:browser:terminal
 *
 * Environment variables:
 *   BASE_URL: Target URL (if omitted, harness starts isolated production server)
 *   HEADLESS: Whether to run headless (default: true)
 */

import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..', '..');

// Portable Playwright resolver (no hardcoded personal paths)
async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    try {
      return await import('playwright-core');
    } catch (err) {
      throw new Error(
        `Playwright is not installed in node_modules.\n` +
        `Prerequisite commands to execute browser automation:\n` +
        `  npm install\n` +
        `  npx playwright install chromium\n` +
        `Details: ${err.message}`
      );
    }
  }
}

// Find an available loopback port
async function getAvailablePort(startPort = 5188) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on('error', () => {
      resolve(getAvailablePort(startPort + 1));
    });
    server.listen(startPort, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

// Start isolated production server on loopback with authentication disabled
async function startProductionServer(repoRoot, port) {
  const startJs = path.join(repoRoot, 'dist-server', 'start.js');
  if (!fs.existsSync(startJs)) {
    throw new Error(`Production server build not found at ${startJs}. Run npm run build first.`);
  }

  return new Promise((resolve, reject) => {
    const serverProc = spawn(process.execPath, [startJs], {
      cwd: repoRoot,
      env: {
        ...process.env,
        HOST: '127.0.0.1',
        PORT: String(port),
        PI_VIEWER_AUTH_ENABLED: 'false',
        // Clear any secrets or external auth keys
        PI_VIEWER_AUTH_KEY: '',
        PI_AUTH_SECRET: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    let output = '';

    const onData = (data) => {
      const str = data.toString();
      output += str;
      if (str.includes(`Pi Viewer listening on http://127.0.0.1:${port}`) || str.includes('Pi Viewer listening on http://')) {
        started = true;
        resolve({
          proc: serverProc,
          url: `http://127.0.0.1:${port}`,
        });
      }
    };

    serverProc.stdout.on('data', onData);
    serverProc.stderr.on('data', onData);

    serverProc.on('error', (err) => {
      if (!started) reject(new Error(`Failed to start production server: ${err.message}`));
    });

    serverProc.on('exit', (code) => {
      if (!started) {
        reject(new Error(`Production server exited prematurely with code ${code}. Output: ${output}`));
      }
    });

    setTimeout(() => {
      if (!started) {
        serverProc.kill();
        reject(new Error(`Production server startup timed out after 15s. Output: ${output}`));
      }
    }, 15000);
  });
}

// Check if a remote or external server is reachable
async function isServerReachable(url) {
  try {
    const res = await fetch(`${url}/api/auth/status`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return res.status < 500;
  } catch {
    return false;
  }
}

// Backend IPC helper executing over authenticated/loopback web bridge
async function ipcInvoke(baseURL, cmd, args = {}) {
  const res = await fetch(`${baseURL}/api/ipc`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Origin': baseURL,
    },
    body: JSON.stringify({ cmd, args }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Backend IPC ${cmd} failed with HTTP ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.error) {
    throw new Error(`Backend IPC ${cmd} returned error: ${json.error}`);
  }
  return json.result;
}

// Temporary fixture project workspace creation
function createFixtureProjects() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-term-fixture-'));
  const dirA = path.join(baseDir, 'project-alpha');
  const dirB = path.join(baseDir, 'project-beta');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dirB, { recursive: true });

  const canonicalA = fs.realpathSync(dirA);
  const canonicalB = fs.realpathSync(dirB);

  const registry = {
    projects: [
      {
        id: 'fixture-project-alpha',
        path: canonicalA,
        customName: 'Project Alpha',
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
      },
      {
        id: 'fixture-project-beta',
        path: canonicalB,
        customName: 'Project Beta',
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
      },
    ],
    activeProjectId: 'fixture-project-alpha',
  };

  return {
    baseDir,
    dirA: canonicalA,
    dirB: canonicalB,
    registry,
  };
}

// Helper to poll for text in frontend terminal screen
async function waitForTerminalText(page, expectedText, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const screenText = await page.locator('.terminal-screen-container').innerText().catch(() => '');
    if (screenText.includes(expectedText)) {
      return screenText;
    }
    const rowText = await page.locator('.xterm-rows').textContent().catch(() => '');
    if (rowText.includes(expectedText)) {
      return rowText;
    }
    await page.waitForTimeout(200);
  }
  throw new Error(`Timed out waiting for terminal output containing: "${expectedText}"`);
}

// Helper to poll backend for session output replay
async function waitForBackendReplay(baseURL, sessionId, expectedText, timeout = 12000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const session = await ipcInvoke(baseURL, 'terminal_get', { id: sessionId });
    if (session && session.replay && session.replay.includes(expectedText)) {
      return session;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Timed out waiting for backend replay containing: "${expectedText}"`);
}

export async function runTerminalBrowserTests(options = {}) {
  let serverInstance = null;
  let baseURL = options.baseURL || process.env.BASE_URL;
  let fixtures = null;
  let browser = null;
  let context = null;
  const activeSessionIds = new Set();

  try {
    fixtures = createFixtureProjects();
    console.log(`[Browser Test Setup] Created fixture projects:\n  A: ${fixtures.dirA}\n  B: ${fixtures.dirB}`);

    if (baseURL) {
      const reachable = await isServerReachable(baseURL);
      if (!reachable) {
        console.warn(`[Browser Test Setup] BASE_URL ${baseURL} unreachable; starting dedicated server.`);
        baseURL = null;
      }
    }

    if (!baseURL) {
      const port = await getAvailablePort(5188);
      console.log(`[Browser Test Setup] Starting isolated production server on 127.0.0.1:${port}...`);
      serverInstance = await startProductionServer(REPO_ROOT, port);
      baseURL = serverInstance.url;
      console.log(`[Browser Test Setup] Production server listening at ${baseURL}`);
    }

    const headless = options.headless ?? (process.env.HEADLESS !== 'false');
    console.log(`[Browser Test] Loading Playwright (headless: ${headless})...`);
    const { chromium } = await loadPlaywright();

    browser = await chromium.launch({ headless });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    // Seed fixture projects into browser localStorage prior to app initialization
    await context.addInitScript(
      ({ storageKey, registry }) => {
        try {
          if (!localStorage.getItem(storageKey)) {
            localStorage.setItem(storageKey, JSON.stringify(registry));
          }
        } catch (e) {
          console.error('Failed to seed projects into localStorage:', e);
        }
      },
      { storageKey: 'pi_viewer_projects', registry: fixtures.registry }
    );

    const page = await context.newPage();

    console.log(`[Browser Test] Navigating to ${baseURL}...`);
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000);

    // =========================================================================
    // S2.1 Desktop fullscreen viewport bounds and controls
    // =========================================================================
    console.log('[Browser Test S2.1] Verifying desktop fullscreen viewport bounds and controls...');
    const launchBtn = page.locator('.btn-terminal-toggle');
    await launchBtn.waitFor({ state: 'visible', timeout: 15000 });

    await launchBtn.click();

    const overlay = page.locator('.terminal-overlay[role="dialog"]');
    await overlay.waitFor({ state: 'visible', timeout: 10000 });

    // Verify bounds occupy desktop viewport
    const overlayBox = await overlay.boundingBox();
    if (!overlayBox || overlayBox.width < 1000 || overlayBox.height < 600) {
      throw new Error(`S2.1 FAIL: Terminal overlay does not fill desktop viewport: ${JSON.stringify(overlayBox)}`);
    }

    // Verify controls
    const minimizeBtn = overlay.locator('.btn-terminal-minimize');
    const terminateBtn = overlay.locator('.btn-terminal-terminate');
    await minimizeBtn.waitFor({ state: 'visible', timeout: 5000 });
    await terminateBtn.waitFor({ state: 'visible', timeout: 5000 });

    // Verify project name badge in overlay
    const projectBadge = overlay.locator('.terminal-project-badge');
    await projectBadge.waitFor({ state: 'visible', timeout: 5000 });
    const badgeText = await projectBadge.textContent();
    if (!badgeText || !badgeText.includes('Project Alpha')) {
      throw new Error(`S2.1 FAIL: Project badge expected "Project Alpha", got: "${badgeText}"`);
    }

    // Verify PID badge in overlay and record backend session
    const pidBadge = overlay.locator('.terminal-pid-badge');
    await pidBadge.waitFor({ state: 'visible', timeout: 10000 });
    const uiPidTextA = await pidBadge.textContent();
    const pidMatchA = uiPidTextA.match(/\bPID\s+(\d+)\b/);
    if (!pidMatchA) {
      throw new Error(`S2.1 FAIL: Invalid PID badge text: "${uiPidTextA}"`);
    }
    const pidA = parseInt(pidMatchA[1], 10);

    const backendSessionA = await ipcInvoke(baseURL, 'terminal_get', { cwd: fixtures.dirA });
    if (!backendSessionA || backendSessionA.pid !== pidA || !backendSessionA.running) {
      throw new Error(`S2.1 FAIL: Backend session does not match UI PID ${pidA}: ${JSON.stringify(backendSessionA)}`);
    }
    const sessionIdA = backendSessionA.id;
    activeSessionIds.add(sessionIdA);
    const desktopCols = backendSessionA.cols;
    const desktopRows = backendSessionA.rows;
    console.log(`[Browser Test S2.1] PASS: Desktop bounds (${overlayBox.width}x${overlayBox.height}), controls, and Session A established (ID: ${sessionIdA}, PID: ${pidA}).`);

    // =========================================================================
    // S1.1 Real shell command output proven beyond echoed input
    // =========================================================================
    console.log('[Browser Test S1.1] Executing unique arithmetic command to prove real execution beyond echo...');
    const termScreen = overlay.locator('.terminal-screen-container');
    await termScreen.waitFor({ state: 'visible', timeout: 5000 });

    const xtermTextarea = page.locator('.xterm-helper-textarea');
    await xtermTextarea.focus();

    // 47 * 53 = 2491. The literal input string does NOT contain "2491"
    const markerCalc = 47 * 53;
    const markerA = `CALC_RESULT_${markerCalc}`;
    const commandA = `node -e "console.log('CALC_RESULT_' + (47 * 53))"\r`;
    await page.keyboard.type(commandA, { delay: 20 });

    // Assert evaluated result appears in frontend screen buffer and backend replay
    console.log(`[Browser Test S1.1] Waiting for marker "${markerA}"...`);
    await waitForTerminalText(page, markerA, 12000);
    await waitForBackendReplay(baseURL, sessionIdA, markerA, 12000);
    console.log(`[Browser Test S1.1] PASS: Command output "${markerA}" proven in live UI and backend PTY buffer.`);

    // =========================================================================
    // S2.2 Mobile viewport adaptation, control usability, and PTY resize
    // =========================================================================
    console.log('[Browser Test S2.2] Testing mobile viewport layout and backend PTY resize reflection...');
    await page.setViewportSize({ width: 375, height: 667 });
    await page.waitForTimeout(600);

    const mobileBox = await overlay.boundingBox();
    if (!mobileBox || mobileBox.width > 380 || mobileBox.width < 340) {
      throw new Error(`S2.2 FAIL: Terminal overlay does not adapt to mobile width: ${JSON.stringify(mobileBox)}`);
    }

    // Verify controls remain visible and usable without clipping
    await minimizeBtn.waitFor({ state: 'visible', timeout: 5000 });
    await terminateBtn.waitFor({ state: 'visible', timeout: 5000 });

    // Verify backend PTY dimensions updated to smaller mobile column count
    let resizedSession = null;
    const resizeDeadline = Date.now() + 6000;
    while (Date.now() < resizeDeadline) {
      resizedSession = await ipcInvoke(baseURL, 'terminal_get', { id: sessionIdA });
      if (resizedSession && resizedSession.cols > 0 && resizedSession.cols < desktopCols) {
        break;
      }
      await page.waitForTimeout(200);
    }

    if (!resizedSession || resizedSession.cols >= desktopCols || resizedSession.cols <= 0) {
      throw new Error(
        `S2.2 FAIL: PTY resize not reflected in backend: desktop cols=${desktopCols}, mobile cols=${resizedSession?.cols}`
      );
    }
    console.log(`[Browser Test S2.2] PASS: Mobile viewport adaptation and PTY resize verified (cols: ${desktopCols} -> ${resizedSession.cols}).`);

    // Restore desktop viewport
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(500);

    // =========================================================================
    // S3.1 Minimize without terminating, PID/state persistence, and page reload
    // =========================================================================
    console.log('[Browser Test S3.1] Testing minimize without terminating and page reload...');
    await minimizeBtn.click();
    await overlay.waitFor({ state: 'hidden', timeout: 5000 });

    // Backend check: process must remain alive during minimization
    const minimizedBackendA = await ipcInvoke(baseURL, 'terminal_get', { id: sessionIdA });
    if (!minimizedBackendA || minimizedBackendA.pid !== pidA || !minimizedBackendA.running) {
      throw new Error(`S3.1 FAIL: Session A process terminated on minimize: ${JSON.stringify(minimizedBackendA)}`);
    }

    // Reopen terminal: verify PID and output persistence
    await launchBtn.click();
    await overlay.waitFor({ state: 'visible', timeout: 5000 });

    const reopenedPidBadge = overlay.locator('.terminal-pid-badge');
    const reopenedPidText = await reopenedPidBadge.textContent();
    if (!reopenedPidText.includes(String(pidA))) {
      throw new Error(`S3.1 FAIL: Reopened terminal PID badge changed: expected ${pidA}, got "${reopenedPidText}"`);
    }
    await waitForTerminalText(page, markerA, 5000);

    // Test page reload: backend must retain process across browser reload
    console.log('[Browser Test S3.1] Testing page reload retention...');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);

    const reloadedLaunchBtn = page.locator('.btn-terminal-toggle');
    await reloadedLaunchBtn.waitFor({ state: 'visible', timeout: 10000 });
    await reloadedLaunchBtn.click();

    const reloadedOverlay = page.locator('.terminal-overlay[role="dialog"]');
    await reloadedOverlay.waitFor({ state: 'visible', timeout: 10000 });

    const reloadedPidText = await reloadedOverlay.locator('.terminal-pid-badge').textContent();
    if (!reloadedPidText.includes(String(pidA))) {
      throw new Error(`S3.1 FAIL: Reloaded page PID badge changed: expected ${pidA}, got "${reloadedPidText}"`);
    }

    // Send secondary command following reload to prove ongoing terminal reactivity
    const reloadMarker = `RELOAD_OK_${31 * 37}`; // 1147
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`node -e "console.log('RELOAD_OK_' + (31 * 37))"\r`, { delay: 20 });
    await waitForTerminalText(page, reloadMarker, 12000);
    await waitForBackendReplay(baseURL, sessionIdA, reloadMarker, 12000);
    console.log(`[Browser Test S3.1] PASS: Minimize and reload verified; same PID ${pidA} and output continuity preserved.`);

    // =========================================================================
    // S1.2 & S3.2 Project A/B isolation & session survival across switch
    // =========================================================================
    console.log('[Browser Test S1.2 / S3.2] Testing project A/B isolation and multi-session independence...');
    // Minimize Alpha terminal to interact with ProjectDock
    await reloadedOverlay.locator('.btn-terminal-minimize').click();
    await reloadedOverlay.waitFor({ state: 'hidden', timeout: 5000 });

    // Switch to Project Beta
    const projectBetaTile = page.locator('.project-tile[aria-label="Project Beta"]');
    await projectBetaTile.waitFor({ state: 'visible', timeout: 5000 });
    await projectBetaTile.click();
    await page.waitForTimeout(600);

    // Open terminal for Project Beta
    await launchBtn.click();
    await overlay.waitFor({ state: 'visible', timeout: 5000 });

    const badgeBText = await overlay.locator('.terminal-project-badge').textContent();
    if (!badgeBText.includes('Project Beta')) {
      throw new Error(`S1.2 FAIL: Active project badge expected "Project Beta", got "${badgeBText}"`);
    }

    const pidTextB = await overlay.locator('.terminal-pid-badge').textContent();
    const pidMatchB = pidTextB.match(/\bPID\s+(\d+)\b/);
    if (!pidMatchB) {
      throw new Error(`S1.2 FAIL: Invalid PID badge in Project Beta: "${pidTextB}"`);
    }
    const pidB = parseInt(pidMatchB[1], 10);
    if (pidB === pidA) {
      throw new Error(`S1.2 FAIL: Project Beta must have independent PID, but got same PID ${pidA}`);
    }

    const backendSessionB = await ipcInvoke(baseURL, 'terminal_get', { cwd: fixtures.dirB });
    if (!backendSessionB || backendSessionB.pid !== pidB || !backendSessionB.running) {
      throw new Error(`S1.2 FAIL: Backend session B not found or PID mismatch: ${JSON.stringify(backendSessionB)}`);
    }
    const sessionIdB = backendSessionB.id;
    activeSessionIds.add(sessionIdB);

    // Execute unique marker in Project Beta
    const markerB = `BETA_CALC_${59 * 61}`; // 3599
    await page.locator('.xterm-helper-textarea').focus();
    await page.keyboard.type(`node -e "console.log('BETA_CALC_' + (59 * 61))"\r`, { delay: 20 });
    await waitForTerminalText(page, markerB, 12000);
    await waitForBackendReplay(baseURL, sessionIdB, markerB, 12000);

    // Assert Project Beta does NOT contain Project Alpha's marker
    const betaReplay = (await ipcInvoke(baseURL, 'terminal_get', { id: sessionIdB })).replay || '';
    if (betaReplay.includes(markerA) || betaReplay.includes(reloadMarker)) {
      throw new Error('S1.2 FAIL: Project Beta received Project Alpha output (cross-project leak)');
    }

    // Verify Project Alpha session survived in the background
    const alphaSurvived = await ipcInvoke(baseURL, 'terminal_get', { id: sessionIdA });
    if (!alphaSurvived || alphaSurvived.pid !== pidA || !alphaSurvived.running) {
      throw new Error(`S3.2 FAIL: Project Alpha session died while Project Beta ran: ${JSON.stringify(alphaSurvived)}`);
    }
    if ((alphaSurvived.replay || '').includes(markerB)) {
      throw new Error('S1.2 FAIL: Project Alpha received Project Beta output (cross-project leak)');
    }

    // Switch back to Project Alpha and verify its state and PID survive
    await overlay.locator('.btn-terminal-minimize').click();
    await overlay.waitFor({ state: 'hidden', timeout: 5000 });

    const projectAlphaTile = page.locator('.project-tile[aria-label="Project Alpha"]');
    await projectAlphaTile.click();
    await page.waitForTimeout(600);

    await launchBtn.click();
    await overlay.waitFor({ state: 'visible', timeout: 5000 });

    const restoredAlphaPidText = await overlay.locator('.terminal-pid-badge').textContent();
    if (!restoredAlphaPidText.includes(String(pidA))) {
      throw new Error(`S3.2 FAIL: Switching back to Alpha lost PID: expected ${pidA}, got "${restoredAlphaPidText}"`);
    }
    await waitForTerminalText(page, markerA, 5000);
    console.log(`[Browser Test S1.2 / S3.2] PASS: Multi-project isolation and concurrency proven (A: ${pidA}, B: ${pidB}).`);

    // =========================================================================
    // S3.3 Explicit confirmed close: Cancel retains process, Confirm terminates
    // =========================================================================
    console.log('[Browser Test S3.3] Testing termination confirmation (Cancel vs Confirm)...');
    await overlay.locator('.btn-terminal-terminate').click();

    const confirmModal = page.locator('[role="alertdialog"].terminate-confirmation-modal');
    await confirmModal.waitFor({ state: 'visible', timeout: 5000 });

    // Step 1: Cancel terminate
    console.log('[Browser Test S3.3] Testing Cancel termination...');
    const cancelBtn = confirmModal.locator('.btn-terminate-cancel');
    await cancelBtn.click();
    await confirmModal.waitFor({ state: 'hidden', timeout: 5000 });
    await overlay.waitFor({ state: 'visible', timeout: 3000 });

    // Verify Session A is STILL alive on backend
    const cancelCheckA = await ipcInvoke(baseURL, 'terminal_get', { id: sessionIdA });
    if (!cancelCheckA || !cancelCheckA.running) {
      throw new Error('S3.3 FAIL: Session A was killed despite clicking Cancel in termination dialog');
    }
    console.log('[Browser Test S3.3] Cancel confirmed: Session A remains running.');

    // Step 2: Confirm terminate
    console.log('[Browser Test S3.3] Testing Confirm termination...');
    await overlay.locator('.btn-terminal-terminate').click();
    await confirmModal.waitFor({ state: 'visible', timeout: 5000 });

    const confirmBtn = confirmModal.locator('.btn-terminate-confirm');
    await confirmBtn.click();

    await confirmModal.waitFor({ state: 'hidden', timeout: 5000 });
    await overlay.waitFor({ state: 'hidden', timeout: 5000 });

    // Verify Session A is terminated on backend
    let sessionATerminated = false;
    const termDeadline = Date.now() + 6000;
    while (Date.now() < termDeadline) {
      const getA = await ipcInvoke(baseURL, 'terminal_get', { id: sessionIdA }).catch(() => null);
      if (!getA || !getA.running) {
        sessionATerminated = true;
        break;
      }
      await page.waitForTimeout(200);
    }
    if (!sessionATerminated) {
      throw new Error(`S3.3 FAIL: Backend session A was not terminated after confirmed close: ${sessionIdA}`);
    }
    activeSessionIds.delete(sessionIdA);

    // Verify Project Beta session SURVIVES unaffected
    const checkB = await ipcInvoke(baseURL, 'terminal_get', { id: sessionIdB });
    if (!checkB || checkB.pid !== pidB || !checkB.running) {
      throw new Error(`S3.3 FAIL: Terminating Project Alpha improperly killed Project Beta: ${JSON.stringify(checkB)}`);
    }
    console.log(`[Browser Test S3.3] Confirmed termination killed Session A (${sessionIdA}); Session B (${sessionIdB}) survives intact.`);

    // Step 3: Reopen Project Alpha: must create a fresh session with a new PID and clean buffer
    console.log('[Browser Test S3.3] Reopening Project Alpha to verify fresh session and PID...');
    await launchBtn.click();
    await overlay.waitFor({ state: 'visible', timeout: 5000 });

    const freshPidBadge = overlay.locator('.terminal-pid-badge');
    await freshPidBadge.waitFor({ state: 'visible', timeout: 10000 });
    const freshPidText = await freshPidBadge.textContent();
    const freshPidMatch = freshPidText.match(/\bPID\s+(\d+)\b/);
    if (!freshPidMatch) {
      throw new Error(`S3.3 FAIL: Invalid fresh PID badge: "${freshPidText}"`);
    }
    const freshPidA = parseInt(freshPidMatch[1], 10);
    if (freshPidA === pidA || freshPidA === pidB) {
      throw new Error(`S3.3 FAIL: Reopened terminal must have a new PID, but got: ${freshPidA} (prior A: ${pidA}, B: ${pidB})`);
    }

    const freshSessionA = await ipcInvoke(baseURL, 'terminal_get', { cwd: fixtures.dirA });
    if (!freshSessionA || freshSessionA.id === sessionIdA || freshSessionA.pid !== freshPidA) {
      throw new Error(`S3.3 FAIL: Reopened session A must be fresh: ${JSON.stringify(freshSessionA)}`);
    }
    activeSessionIds.add(freshSessionA.id);

    // Verify clean buffer (prior commands not present)
    const freshReplay = freshSessionA.replay || '';
    if (freshReplay.includes(markerA) || freshReplay.includes(reloadMarker)) {
      throw new Error('S3.3 FAIL: Fresh session inherited scrollback buffer from terminated session');
    }
    console.log(`[Browser Test S3.3] PASS: Reopening Project Alpha created fresh session (ID: ${freshSessionA.id}, PID: ${freshPidA}) with clean buffer.`);

    console.log('\n======================================================');
    console.log('ALL BROWSER AUTOMATION TESTS COMPLETED SUCCESSFULLY!');
    console.log('Scenarios verified: S2.1, S1.1, S2.2, S3.1, S1.2, S3.2, S3.3');
    console.log('======================================================\n');
    return { success: true };
  } finally {
    console.log('[Browser Test Teardown] Cleaning up sessions, processes, servers, and fixtures...');
    // 1. Close any remaining active terminal sessions on backend
    if (activeSessionIds.size > 0 && baseURL) {
      for (const id of activeSessionIds) {
        try {
          await ipcInvoke(baseURL, 'terminal_close', { id });
        } catch {}
      }
    }

    // 2. Close browser context and browser
    if (context) {
      try {
        await context.close();
      } catch {}
    }
    if (browser) {
      try {
        await browser.close();
      } catch {}
    }

    // 3. Terminate spawned production server
    if (serverInstance && serverInstance.proc) {
      try {
        serverInstance.proc.kill('SIGTERM');
      } catch {}
    }

    // 4. Remove fixture directories
    if (fixtures && fixtures.baseDir && fs.existsSync(fixtures.baseDir)) {
      try {
        fs.rmSync(fixtures.baseDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

// Direct execution guard
if (process.argv[1] && process.argv[1].endsWith('terminal.mjs')) {
  runTerminalBrowserTests()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('\n[Browser Test Execution ERROR]', err.message);
      if (err.stack) {
        console.error(err.stack);
      }
      process.exit(1);
    });
}
