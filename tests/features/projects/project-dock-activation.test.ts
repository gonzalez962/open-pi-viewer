import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser } from 'playwright';

let browser: Browser;
let script: string;
before(async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import { ProjectDock } from './src/features/projects/ProjectDock';
      function Fixture() {
        const mobile = matchMedia('(max-width: 768px)').matches;
        const [active, setActive] = useState('alpha');
        const [open, setOpen] = useState(true);
        const [orders, setOrders] = useState([]);
        return <>
          <button onClick={() => setOpen(true)}>Open navigation</button>
          <output>{active}</output>
          <div hidden={!open} data-reorders={orders.length} style={{ height: '500px' }}>
            <ProjectDock mobileDrawerOpen={mobile && open} activeProjectId={active}
              projects={['Alpha', 'Worktree', 'Beta'].map(customName => ({ id: customName.toLowerCase(), path: '/' + customName.toLowerCase(), customName, createdAt: '', lastOpenedAt: '' }))}
              getPrimaryPath={path => path === '/worktree' ? '/alpha' : undefined}
              projectOrder={orders.at(-1)} onReorderProjects={order => setOrders(previous => [...previous, order])}
              connectionState="disconnected" agentActivity="idle" isBusy={false} locale="en"
              onRenameProject={() => {}} onRemoveProject={() => {}}
              onSelectProject={project => { setActive(project.id); if (mobile) setOpen(false); }} />
          </div>
        </>;
      }
      createRoot(document.getElementById('root')).render(<Fixture />);
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', tsconfig: 'tsconfig.app.json',
  });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); });

for (const mobile of [true, false]) {
  test(mobile ? 'mobile tap expands before selecting a project' : 'desktop selects a project on the first click', async () => {
    const page = await browser.newPage({ hasTouch: mobile, viewport: { width: mobile ? 390 : 1200, height: 800 } });
    try {
      page.setDefaultTimeout(5000);
      await page.setContent('<div id="root"></div>');
      await page.addStyleTag({ path: 'src/features/projects/projects.css' });
      await page.addScriptTag({ content: script });
      const dock = page.locator('.project-dock');
      const project = dock.getByRole('button', { name: 'Beta', exact: true });
      const active = page.locator('output');
      if (mobile) {
        await project.tap();
        assert.equal(await active.innerText(), 'alpha');
        assert.equal(await dock.isVisible(), true);
        assert.match(await dock.getAttribute('class') ?? '', /\bis-expanded\b/);
        await project.tap();
        assert.equal(await active.innerText(), 'beta');
        assert.equal(await dock.isVisible(), false);
        await page.getByRole('button', { name: 'Open navigation' }).tap();
        await dock.waitFor();
        assert.doesNotMatch(await dock.getAttribute('class') ?? '', /\bis-expanded\b/);

        const alpha = dock.getByRole('button', { name: 'Alpha', exact: true });
        const swipe = (dx: number) => alpha.evaluate((tile, distance) => {
          const touch = { bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: true, pointerId: 7 };
          tile.dispatchEvent(new PointerEvent('pointerdown', { ...touch, clientX: 100 }));
          tile.dispatchEvent(new PointerEvent('pointerup', { ...touch, clientX: 100 + distance }));
          // Force the compatibility click so suppression is exercised even if the UA
          // wouldn't normally produce a click after this much travel.
          tile.dispatchEvent(new PointerEvent('click', { ...touch, clientX: 100 + distance, detail: 1 }));
        }, dx);
        await swipe(80);
        await dock.and(page.locator('.is-expanded')).waitFor();
        assert.equal(await active.innerText(), 'beta');
        await swipe(-80);
        await dock.and(page.locator(':not(.is-expanded)')).waitFor();
        assert.equal(await active.innerText(), 'beta');
        assert.equal(await dock.isVisible(), true);
        await alpha.press('Enter');
        assert.equal(await active.innerText(), 'alpha');
        assert.equal(await dock.isVisible(), false);
      } else {
        await project.click();
        assert.equal(await active.innerText(), 'beta');
        assert.equal(await dock.isVisible(), true);
      }
    } finally {
      await page.close();
    }
  });

  test(mobile ? 'touch handle moves the whole group without selecting a project' : 'keyboard and mouse can move or cancel the whole group', async () => {
    const page = await browser.newPage({ hasTouch: mobile, viewport: { width: mobile ? 390 : 1200, height: 800 } });
    try {
      page.setDefaultTimeout(5000);
      await page.setContent('<div id="root"></div>');
      await page.addStyleTag({ path: 'src/features/projects/projects.css' });
      await page.addScriptTag({ content: script });
      const dock = page.locator('.project-dock');
      const alpha = dock.getByRole('button', { name: 'Alpha', exact: true });
      if (mobile) await alpha.tap(); else await alpha.hover();
      const handle = dock.getByRole('button', { name: 'Reorder Alpha', exact: true });
      const beta = dock.getByRole('button', { name: 'Beta', exact: true });
      const order = () => dock.locator('.project-row .project-tile').evaluateAll(tiles => tiles.map(tile => tile.getAttribute('aria-label')));
      const writes = () => page.locator('[data-reorders]').getAttribute('data-reorders');
      assert.equal(await dock.getByRole('button', { name: 'Reorder Worktree', exact: true }).count(), 0);
      if (!mobile) {
        await handle.press('Enter');
        await handle.press('ArrowDown');
        await dock.locator('.project-row--drop-after').waitFor();
        await handle.press('Escape');
        await dock.locator('.project-row--drop-after').waitFor({ state: 'hidden' });
        assert.equal(await writes(), '0');
        await handle.press('Enter');
        await handle.press('ArrowDown');
        await handle.press('Enter');
        assert.deepEqual(await order(), ['Beta', 'Alpha', 'Worktree']);
        assert.equal(await writes(), '1');
      }
      await handle.hover(); // wait for the expanded width to settle before measuring
      const from = (await handle.boundingBox())!;
      const to = (await beta.boundingBox())!;
      const x = Math.round(from.x + from.width / 2);
      const start = Math.round(from.y + from.height / 2);
      const end = Math.round(to.y + to.height * (mobile ? 0.85 : 0.15));
      if (mobile) {
        const session = await page.context().newCDPSession(page);
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: end }] });
        await dock.locator('.project-row--drop-after').waitFor();
        await session.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
        await dock.locator('.project-row--drop-after').waitFor({ state: 'hidden' });
        assert.equal(await writes(), '0');
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: start }] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: end }] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      } else {
        await page.mouse.click(x, start);
        assert.equal(await writes(), '1');
        await page.mouse.move(x, start);
        await page.mouse.down();
        await page.mouse.move(x, end);
        await dock.locator('.project-row--drop-before').waitFor();
        await page.mouse.up();
      }
      assert.deepEqual(await order(), mobile ? ['Beta', 'Alpha', 'Worktree'] : ['Alpha', 'Worktree', 'Beta']);
      assert.equal(await writes(), mobile ? '1' : '2');
      assert.equal(await page.locator('output').innerText(), 'alpha');
      assert.equal(await dock.isVisible(), true);
    } finally {
      await page.close();
    }
  });
}
