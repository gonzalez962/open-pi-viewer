/**
 * Browser Automation for Explorer Create Folder (+ Folder) (T1/S1)
 *
 * Implements real browser-driven interaction specifications:
 * - S1.1: Click "+ Folder", enter valid folder name, submit -> folder is created on disk and appears in UI without manual refresh
 * - S1.2: Open "+ Folder", enter name, cancel or press Escape -> no directory created on disk, form closes
 * - S1.3: Enter existing folder name -> displays visible collision error, leaves disk untouched
 * - S1.4 PRESERVE: Existing search filter and refresh controls remain functional beside "+ Folder"
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

async function loadPlaywright() {
  try {
    return await import('playwright');
  } catch {
    try {
      return await import('playwright-core');
    } catch (err) {
      throw new Error(`Playwright is not available: ${err.message}`);
    }
  }
}

async function getAvailablePort(startPort = 5195) {
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
      if (!started) reject(new Error(`Failed to start server: ${err.message}`));
    });

    serverProc.on('exit', (code) => {
      if (!started) {
        reject(new Error(`Server exited prematurely with code ${code}. Output: ${output}`));
      }
    });

    setTimeout(() => {
      if (!started) {
        serverProc.kill();
        reject(new Error(`Server startup timed out after 15s. Output: ${output}`));
      }
    }, 15000);
  });
}

function createFixtureWorkspace() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-create-folder-browser-'));
  const projectDir = path.join(baseDir, 'project-workspace');
  fs.mkdirSync(projectDir, { recursive: true });

  // Add an initial file to ensure workspace is not empty
  fs.writeFileSync(path.join(projectDir, 'README.md'), '# Fixture Workspace\nInitial content\n');

  const canonicalDir = fs.realpathSync(projectDir);

  const registry = {
    projects: [
      {
        id: 'fixture-project-create-folder',
        path: canonicalDir,
        customName: 'Folder Test Project',
        createdAt: new Date().toISOString(),
        lastOpenedAt: new Date().toISOString(),
      },
    ],
    activeProjectId: 'fixture-project-create-folder',
  };

  return {
    baseDir,
    projectDir: canonicalDir,
    registry,
  };
}

export async function runCreateFolderBrowserTests(options = {}) {
  let serverInstance = null;
  let baseURL = options.baseURL || process.env.BASE_URL;
  let fixtures = null;
  let browser = null;
  let context = null;

  try {
    fixtures = createFixtureWorkspace();
    console.log(`[Browser Test Setup] Created fixture project: ${fixtures.projectDir}`);

    if (!baseURL) {
      const port = await getAvailablePort(5195);
      console.log(`[Browser Test Setup] Starting isolated server on 127.0.0.1:${port}...`);
      serverInstance = await startProductionServer(REPO_ROOT, port);
      baseURL = serverInstance.url;
      console.log(`[Browser Test Setup] Server listening at ${baseURL}`);
    }

    const headless = options.headless ?? (process.env.HEADLESS !== 'false');
    console.log(`[Browser Test] Loading Playwright (headless: ${headless})...`);
    const { chromium } = await loadPlaywright();

    browser = await chromium.launch({ headless });
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
    });

    // Seed fixture project into browser localStorage
    await context.addInitScript(
      ({ projectStorageKey, configStorageKey, registry, config }) => {
        try {
          localStorage.setItem(projectStorageKey, JSON.stringify(registry));
          localStorage.setItem(configStorageKey, JSON.stringify(config));
        } catch (e) {
          console.error('Failed to seed projects into localStorage:', e);
        }
      },
      {
        projectStorageKey: 'pi_viewer_projects',
        configStorageKey: 'pi_viewer_connect_config',
        registry: fixtures.registry,
        config: {
          nodePath: process.execPath,
          piEntrypoint: path.join(REPO_ROOT, 'dist-server', 'start.js'),
          workingDirectory: fixtures.projectDir,
          fileTreeRefreshInterval: 15,
        },
      }
    );

    const page = await context.newPage();
    page.on('console', (msg) => console.log('[PAGE CONSOLE]', msg.type(), msg.text()));
    page.on('pageerror', (err) => console.log('[PAGE ERROR]', err.message));

    console.log(`[Browser Test] Navigating to ${baseURL}...`);
    await page.goto(baseURL, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000);

    // Switch to Files tab in sidebar
    console.log('[Browser Test] Switching to Files tab in sidebar...');
    const filesTab = page.locator('.sidebar-tabs button[role="tab"]').nth(1);
    await filesTab.waitFor({ state: 'visible', timeout: 10000 });
    await filesTab.click();

    // Verify + Folder button is visible and labeled exactly "+ Folder"
    console.log('[Browser Test S1] Verifying "+ Folder" button...');
    const createFolderBtn = page.locator('.btn-tree-create-folder');
    await createFolderBtn.waitFor({ state: 'visible', timeout: 10000 });
    const btnLabel = (await createFolderBtn.innerText()).trim();
    if (btnLabel !== '+ Folder') {
      throw new Error(`S1 FAIL: Expected button label "+ Folder", got: "${btnLabel}"`);
    }
    console.log('[Browser Test S1] PASS: "+ Folder" button is visible and labeled correctly.');

    // =========================================================================
    // S1.2 Cancel / Escape: no directory created
    // =========================================================================
    console.log('[Browser Test S1.2] Testing Cancel/Escape dismiss without creating directory...');
    await createFolderBtn.click();

    const form = page.locator('.create-folder-form');
    await form.waitFor({ state: 'visible', timeout: 5000 });

    const input = page.locator('.create-folder-input');
    await input.waitFor({ state: 'visible', timeout: 5000 });
    await input.fill('cancelled-directory');

    // Press Escape to cancel
    await page.keyboard.press('Escape');
    await form.waitFor({ state: 'hidden', timeout: 5000 });

    // Verify directory was NOT created on disk
    const cancelledPath = path.join(fixtures.projectDir, 'cancelled-directory');
    if (fs.existsSync(cancelledPath)) {
      throw new Error('S1.2 FAIL: Directory was created on disk despite Escape cancellation');
    }
    console.log('[Browser Test S1.2] PASS: Escape cancelled without creating directory.');

    // Also test cancel button click
    await createFolderBtn.click();
    await form.waitFor({ state: 'visible', timeout: 5000 });
    await input.fill('button-cancelled-dir');
    const cancelBtn = page.locator('.btn-create-folder-cancel');
    await cancelBtn.click();
    await form.waitFor({ state: 'hidden', timeout: 5000 });

    const btnCancelledPath = path.join(fixtures.projectDir, 'button-cancelled-dir');
    if (fs.existsSync(btnCancelledPath)) {
      throw new Error('S1.2 FAIL: Directory was created on disk despite cancel button click');
    }
    console.log('[Browser Test S1.2] PASS: Cancel button dismissed without creating directory.');

    // =========================================================================
    // S1.1 Confirm creation: folder created on disk and appears in tree without manual refresh
    // =========================================================================
    console.log('[Browser Test S1.1] Testing valid folder creation and automatic refresh...');
    await createFolderBtn.click();
    await form.waitFor({ state: 'visible', timeout: 5000 });

    await input.fill('alpha-folder');
    const submitBtn = page.locator('.btn-create-folder-submit');
    await submitBtn.click();

    // Form should close automatically upon success
    await form.waitFor({ state: 'hidden', timeout: 8000 });

    // Verify folder exists on disk
    const createdPath = path.join(fixtures.projectDir, 'alpha-folder');
    if (!fs.existsSync(createdPath)) {
      throw new Error(`S1.1 FAIL: Directory not created on disk: ${createdPath}`);
    }

    // Verify folder appears in UI file tree automatically without manual refresh
    const createdNode = page.locator('.tree-node-row .tree-node-name').filter({ hasText: 'alpha-folder' });
    await createdNode.waitFor({ state: 'visible', timeout: 8000 });
    console.log('[Browser Test S1.1] PASS: Folder created on disk and automatically visible in tree.');

    // =========================================================================
    // S1.3 Existing destination: visible collision error without altering disk
    // =========================================================================
    console.log('[Browser Test S1.3] Testing duplicate folder creation visible collision error...');
    await createFolderBtn.click();
    await form.waitFor({ state: 'visible', timeout: 5000 });

    await input.fill('alpha-folder');
    await submitBtn.click();

    // Error banner must become visible
    const errorBanner = page.locator('.create-folder-error');
    await errorBanner.waitFor({ state: 'visible', timeout: 5000 });
    const errorText = await errorBanner.innerText();
    if (!errorText.toLowerCase().includes('already exists')) {
      throw new Error(`S1.3 FAIL: Expected "already exists" error, got: "${errorText}"`);
    }

    // Form must remain open
    if (!(await form.isVisible())) {
      throw new Error('S1.3 FAIL: Form closed despite collision error');
    }

    // Dismiss with Escape
    await page.keyboard.press('Escape');
    await form.waitFor({ state: 'hidden', timeout: 5000 });
    console.log(`[Browser Test S1.3] PASS: Collision error visibly displayed: "${errorText.trim()}".`);

    // =========================================================================
    // S1.4 PRESERVE: Search filtering and refresh controls remain intact
    // =========================================================================
    console.log('[Browser Test S1.4 PRESERVE] Testing search filter and refresh controls...');
    const searchInput = page.locator('.file-tree-controls .sidebar-search-input');
    await searchInput.waitFor({ state: 'visible', timeout: 5000 });

    await searchInput.fill('alpha');
    await page.waitForTimeout(300);

    // Search results should show alpha-folder
    const searchResult = page.locator('.search-result-item .result-name').filter({ hasText: 'alpha-folder' });
    await searchResult.waitFor({ state: 'visible', timeout: 5000 });

    // Clear search
    await searchInput.fill('');
    await page.waitForTimeout(300);

    // Refresh button should remain interactive
    const refreshBtn = page.locator('.btn-tree-refresh');
    await refreshBtn.waitFor({ state: 'visible', timeout: 5000 });
    await refreshBtn.click();
    await page.waitForTimeout(500);

    // Create folder button must still be visible and functional beside filter
    await createFolderBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('[Browser Test S1.4 PRESERVE] PASS: Filter and refresh controls preserved.');

    // =========================================================================
    // T3 / S1: FolderPickerModal "+ Folder" Coverage
    // User clarification: "no veo el boton de add folder en el modal del explorador"
    // =========================================================================
    console.log('\n[Browser Test T3/S1] Opening the ACTUAL folder picker modal...');
    const addProjectBtn = page.locator('.project-dock-footer .project-footer-row').first();
    await addProjectBtn.waitFor({ state: 'visible', timeout: 5000 });
    await addProjectBtn.click();

    const modalOverlay = page.locator('.folder-picker-overlay');
    await modalOverlay.waitFor({ state: 'visible', timeout: 5000 });
    const modalContent = page.locator('.folder-picker-card');
    await modalContent.waitFor({ state: 'visible', timeout: 5000 });
    console.log('[Browser Test T3/S1] PASS: Folder picker modal opened successfully.');

    // Verify + Folder button is visible beside filter inside modal
    console.log('[Browser Test T3/S1] Verifying "+ Folder" button beside filter in modal...');
    const modalCreateFolderBtn = modalContent.locator('.folder-picker-filter-wrap .folder-picker-btn-create-folder');
    await modalCreateFolderBtn.waitFor({ state: 'visible', timeout: 5000 });
    const modalBtnLabel = (await modalCreateFolderBtn.innerText()).trim();
    if (modalBtnLabel !== '+ Folder') {
      throw new Error(`T3/S1 FAIL: Expected button label "+ Folder" next to filter in modal, got: "${modalBtnLabel}"`);
    }
    console.log('[Browser Test T3/S1] PASS: "+ Folder" button visible next to filter in modal.');

    // S1.2 Cancel / Escape in modal form: no directory created, modal dialog survives
    console.log('[Browser Test T3/S1.2] Testing Cancel/Escape dismiss inside modal without creating directory or closing modal...');
    await modalCreateFolderBtn.click();

    const modalForm = modalContent.locator('.create-folder-form');
    await modalForm.waitFor({ state: 'visible', timeout: 5000 });

    const modalInput = modalForm.locator('.create-folder-input');
    await modalInput.waitFor({ state: 'visible', timeout: 5000 });
    await modalInput.fill('modal-cancelled-dir');

    // Press Escape to cancel entry: must dismiss form but leave modal dialog OPEN
    await page.keyboard.press('Escape');
    await modalForm.waitFor({ state: 'hidden', timeout: 5000 });

    if (!(await modalContent.isVisible())) {
      throw new Error('T3/S1.2 FAIL: Escape inside folder creation form closed the entire modal dialog');
    }

    const modalCancelledPath = path.join(fixtures.projectDir, 'modal-cancelled-dir');
    if (fs.existsSync(modalCancelledPath)) {
      throw new Error('T3/S1.2 FAIL: Directory was created on disk despite Escape cancellation');
    }
    console.log('[Browser Test T3/S1.2] PASS: Escape cancelled entry without creating directory or closing modal.');

    // Also test Cancel button click inside modal form
    await modalCreateFolderBtn.click();
    await modalForm.waitFor({ state: 'visible', timeout: 5000 });
    await modalInput.fill('modal-btn-cancelled-dir');
    const modalCancelBtn = modalForm.locator('.btn-create-folder-cancel');
    await modalCancelBtn.click();
    await modalForm.waitFor({ state: 'hidden', timeout: 5000 });

    if (!(await modalContent.isVisible())) {
      throw new Error('T3/S1.2 FAIL: Cancel button click closed the entire modal dialog');
    }
    const modalBtnCancelledPath = path.join(fixtures.projectDir, 'modal-btn-cancelled-dir');
    if (fs.existsSync(modalBtnCancelledPath)) {
      throw new Error('T3/S1.2 FAIL: Directory was created on disk despite cancel button click');
    }
    console.log('[Browser Test T3/S1.2] PASS: Cancel button dismissed entry without creating directory or closing modal.');

    // S1.1 Confirm creation inside modal: folder created in current directory and appears in modal grid
    console.log('[Browser Test T3/S1.1] Testing valid folder creation and list refresh inside modal...');
    await modalCreateFolderBtn.click();
    await modalForm.waitFor({ state: 'visible', timeout: 5000 });

    await modalInput.fill('beta-modal-folder');
    const modalSubmitBtn = modalForm.locator('.btn-create-folder-submit');
    await modalSubmitBtn.click();

    // Form should close automatically upon success
    await modalForm.waitFor({ state: 'hidden', timeout: 8000 });

    // Verify directory exists on disk inside fixtures.projectDir
    const modalCreatedPath = path.join(fixtures.projectDir, 'beta-modal-folder');
    if (!fs.existsSync(modalCreatedPath)) {
      throw new Error(`T3/S1.1 FAIL: Directory not created on disk: ${modalCreatedPath}`);
    }

    // Verify folder appears in modal grid automatically without manual reload
    const modalCreatedItem = modalContent.locator('.folder-picker-item .folder-item-name').filter({ hasText: 'beta-modal-folder' });
    await modalCreatedItem.waitFor({ state: 'visible', timeout: 8000 });
    console.log('[Browser Test T3/S1.1] PASS: Folder created on disk and automatically visible in modal grid.');

    // S1.3 Existing destination: visible collision error inside modal without altering disk
    console.log('[Browser Test T3/S1.3] Testing duplicate folder creation visible collision error in modal...');
    await modalCreateFolderBtn.click();
    await modalForm.waitFor({ state: 'visible', timeout: 5000 });

    await modalInput.fill('beta-modal-folder');
    await modalSubmitBtn.click();

    // Error banner must become visible in modal
    const modalErrorBanner = modalForm.locator('.create-folder-error');
    await modalErrorBanner.waitFor({ state: 'visible', timeout: 5000 });
    const modalErrorText = await modalErrorBanner.innerText();
    if (!modalErrorText.toLowerCase().includes('already exists')) {
      throw new Error(`T3/S1.3 FAIL: Expected "already exists" error in modal, got: "${modalErrorText}"`);
    }

    // Form and modal must remain open
    if (!(await modalForm.isVisible())) {
      throw new Error('T3/S1.3 FAIL: Modal form closed despite collision error');
    }
    if (!(await modalContent.isVisible())) {
      throw new Error('T3/S1.3 FAIL: Modal dialog closed despite collision error');
    }

    // Dismiss with Escape
    await page.keyboard.press('Escape');
    await modalForm.waitFor({ state: 'hidden', timeout: 5000 });
    console.log(`[Browser Test T3/S1.3] PASS: Collision error visibly displayed in modal: "${modalErrorText.trim()}".`);

    // =========================================================================
    // Regression: Navigation resets folder form and does not leave submitting state stuck disabled
    // =========================================================================
    console.log('[Browser Test Regression] Testing navigation while folder form is active resets state cleanly...');
    await modalCreateFolderBtn.click();
    await modalForm.waitFor({ state: 'visible', timeout: 5000 });
    await modalInput.fill('abandoned-during-nav');

    // Double-click into alpha-folder while create form has text
    const alphaFolderItem = modalContent.locator('.folder-picker-item').filter({ hasText: 'alpha-folder' }).first();
    await alphaFolderItem.waitFor({ state: 'visible', timeout: 5000 });
    await alphaFolderItem.dblclick();

    // Navigation must synchronously dismiss the create form
    await modalForm.waitFor({ state: 'hidden', timeout: 5000 });

    // Abandoned folder must not exist on disk
    const abandonedPath = path.join(fixtures.projectDir, 'abandoned-during-nav');
    if (fs.existsSync(abandonedPath)) {
      throw new Error('Regression FAIL: Abandoned folder was created on disk after navigation');
    }

    // Path input should now reflect alpha-folder
    const pathInput = modalContent.locator('.folder-picker-path-input');
    await page.waitForFunction(
      (el) => el.value.includes('alpha-folder'),
      await pathInput.elementHandle()
    );

    // Opening create folder in the newly navigated directory must be fully interactive (not stuck disabled)
    await modalCreateFolderBtn.click();
    await modalForm.waitFor({ state: 'visible', timeout: 5000 });
    await modalInput.fill('sub-child-folder');
    if (await modalSubmitBtn.isDisabled()) {
      throw new Error('Regression FAIL: Submit button is stuck disabled after navigation');
    }

    // Submit new nested folder inside alpha-folder
    await modalSubmitBtn.click();
    await modalForm.waitFor({ state: 'hidden', timeout: 8000 });

    const subChildPath = path.join(fixtures.projectDir, 'alpha-folder', 'sub-child-folder');
    if (!fs.existsSync(subChildPath)) {
      throw new Error(`Regression FAIL: Sub-folder was not created on disk: ${subChildPath}`);
    }

    // Sub folder must appear in the refreshed modal grid
    const subChildItem = modalContent.locator('.folder-picker-item .folder-item-name').filter({ hasText: 'sub-child-folder' });
    await subChildItem.waitFor({ state: 'visible', timeout: 8000 });
    console.log('[Browser Test Regression] PASS: Navigation reset form, no stuck submitting state, nested creation succeeded.');

    // Navigate back up to root using Up button
    const upBtn = modalContent.locator('.folder-picker-btn-up');
    await upBtn.click();
    await page.waitForTimeout(500);

    // =========================================================================
    // Close modal dialog and test mounted isOpen toggle transition
    // =========================================================================
    console.log('[Browser Test T3/S1 Close] Verifying modal closes on Escape when form is closed...');
    await page.keyboard.press('Escape');
    await modalOverlay.waitFor({ state: 'hidden', timeout: 5000 });
    console.log('[Browser Test T3/S1 Close] PASS: Modal dialog closed cleanly on Escape.');

    // Reopen modal to verify stable React hook ordering across isOpen transitions
    console.log('[Browser Test T3/S1 Reopen] Reopening modal to verify stable hook ordering across isOpen transitions...');
    await addProjectBtn.click();
    await modalOverlay.waitFor({ state: 'visible', timeout: 5000 });
    await modalCreateFolderBtn.waitFor({ state: 'visible', timeout: 5000 });
    console.log('[Browser Test T3/S1 Reopen] PASS: Modal reopened cleanly without hook ordering errors.');

    // Close again via close button
    const closeBtn = modalContent.locator('.folder-picker-close-btn');
    await closeBtn.click();
    await modalOverlay.waitFor({ state: 'hidden', timeout: 5000 });
    console.log('[Browser Test T3/S1 Reopen] PASS: Modal closed via close button.');

    console.log('\n=========================================');
    console.log(' ALL BROWSER CREATE FOLDER TESTS PASSED! ');
    console.log('=========================================\n');
  } finally {
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (serverInstance?.proc) {
      serverInstance.proc.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 500));
      if (!serverInstance.proc.killed) {
        serverInstance.proc.kill('SIGKILL');
      }
    }
    if (fixtures?.baseDir) {
      try {
        fs.rmSync(fixtures.baseDir, { recursive: true, force: true });
      } catch {}
    }
  }
}

// Direct execution CLI entry point
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runCreateFolderBrowserTests().catch((err) => {
    console.error('\n[Browser Test Error]', err);
    process.exit(1);
  });
}
