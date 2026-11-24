import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import react from '@vitejs/plugin-react';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const root = fileURLToPath(new URL('../../', import.meta.url));
const fixture = {
  name: 'activity-scroll-fixture',
  configureServer(server) {
    server.middlewares.use(async (req, res, next) => {
      if (req.url !== '/activity-scroll-fixture') return next();
      const html = await server.transformIndexHtml('/activity-scroll-fixture', `
        <!doctype html><div id="fixture"></div>
        <script type="module" src="/activity-scroll-fixture.js"></script>`);
      res.setHeader('Content-Type', 'text/html');
      res.end(html);
    });
  },
  resolveId(id) {
    if (id === '/activity-scroll-fixture.js') return id;
  },
  load(id) {
    if (id !== '/activity-scroll-fixture.js') return;
    return `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { flushSync } from 'react-dom';
      import { ActivityBlocksScrollContainer } from '/src/features/chat/ActivityBlocks.tsx';
      import '/src/features/chat/chat.css';
      const root = createRoot(document.getElementById('fixture'));
      window.renderActivity = (key, count) => {
        flushSync(() => root.render(React.createElement(ActivityBlocksScrollContainer,
          { key, blocksCount: count }, Array.from({ length: count }, (_, index) =>
            React.createElement('div', { key: index, className: 'tool-card', style: { height: 80 } }, index)))));
        const el = document.querySelector('.activity-blocks-scroll-container');
        return { top: el.scrollTop, bottomGap: el.scrollHeight - el.clientHeight - el.scrollTop };
      };
    `;
  },
};

test('Activity blocks open at the bottom without animation and preserve a paused scroll', async () => {
  const cacheDir = await mkdtemp(path.join(os.tmpdir(), 'activity-scroll-'));
  let server, browser;
  try {
    server = await createServer({ configFile: false, root, cacheDir, plugins: [react(), fixture],
      resolve: { alias: Object.fromEntries(['core', 'shared', 'infra', 'features', 'app'].map(name => [`@${name}`, path.join(root, 'src', name)])) },
      server: { host: '127.0.0.1', port: 5195, strictPort: true } });
    await server.listen();
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto('http://127.0.0.1:5195/activity-scroll-fixture');
    await page.waitForFunction(() => typeof window.renderActivity === 'function', null, { timeout: 8000 }).catch(error => {
      throw new Error(`Activity fixture did not load: ${errors.join('; ')}`, { cause: error });
    });
    const result = await page.evaluate(() => {
      const initial = window.renderActivity('project-a/session-1', 9);
      const changed = window.renderActivity('project-b/session-2', 12);
      const el = document.querySelector('.activity-blocks-scroll-container');
      el.scrollTop = 100;
      el.dispatchEvent(new Event('scroll'));
      const paused = window.renderActivity('project-b/session-2', 13);
      return { initial, changed, paused };
    });
    for (const view of [result.initial, result.changed]) {
      assert.ok(view.top > 0, 'activity must overflow and start scrolled');
      assert.ok(Math.abs(view.bottomGap) <= 1, 'activity must already be at the end at commit time');
    }
    assert.equal(result.paused.top, 100);
    assert.ok(result.paused.bottomGap > 40);
  } finally {
    await browser?.close();
    await server?.close();
    await rm(cacheDir, { recursive: true, force: true, maxRetries: 3 });
  }
});
