// Run from the repository root: node --test tests/browser/terminal-last-row.mjs
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { chromium } from 'playwright';

let browser;
let assets;

before(async () => {
  const { outputFiles } = await build({
    bundle: true,
    write: false,
    outfile: 'fixture.js',
    stdin: {
      resolveDir: process.cwd(),
      contents: `
        import './src/shared/styles/base.css';
        import './src/features/terminal/terminal.css';
        import { Terminal } from '@xterm/xterm';
        import { FitAddon } from '@xterm/addon-fit';
        const overlay = document.querySelector('.terminal-overlay');
        const mobile = matchMedia('(max-width: 768px)').matches;
        overlay.classList.toggle('is-mobile', mobile);
        const term = new Terminal({
          fontFamily: 'Consolas, "Fira Code", Monaco, monospace',
          fontSize: mobile ? 12 : 13,
          lineHeight: 1.2,
        });
        const fit = new FitAddon();
        term.loadAddon(fit);
        term.open(document.querySelector('.terminal-screen-container'));
        fit.fit();
        window.fixture = { term, fit };
      `,
    },
  });
  assets = Object.fromEntries(outputFiles.map(file => [file.path.split('.').pop(), file.text]));
  browser = await chromium.launch();
});

after(() => browser?.close());

for (const [layout, width, gutter] of [['desktop', 1280, 6], ['mobile', 375, 4]]) {
  test(`${layout}: the last row fits at the bottom without losing the gutter`, async t => {
    const page = await browser.newPage({ viewport: { width, height: 500 } });
    t.after(() => page.close());
    page.setDefaultTimeout(5000);
    await page.setContent(`<!doctype html><div class="terminal-overlay">
      <header class="terminal-header"></header><nav class="terminal-tabs"><button>1</button></nav>
      <main class="terminal-body"><div class="terminal-screen-container"></div></main>
    </div>`);
    await page.addStyleTag({ content: assets.css });
    await page.addScriptTag({ content: assets.js });

    const boundary = await page.evaluate(() => {
      const bodyTop = document.querySelector('.terminal-body').getBoundingClientRect().top;
      const rowHeight = document.querySelector('.xterm-rows > div').getBoundingClientRect().height;
      return bodyTop + 20 * rowHeight;
    });

    // Sweep across both the raw body boundary and the boundary after reserving the gutters.
    const clipped = [];
    for (let offset = -2; offset <= 2 * gutter + 2; offset++) {
      const height = boundary + offset;
      await page.setViewportSize({ width, height });
      await page.evaluate(async () => {
        const { term, fit } = window.fixture;
        fit.fit();
        term.reset();
        await new Promise(resolve => term.write(
          Array.from({ length: 100 }, (_, i) => `line ${i + 1}`).join('\r\n'), resolve,
        ));
        term.scrollToTop();
      });
      await page.waitForFunction(() => document.querySelector('.xterm-rows > div')?.textContent.trim() === 'line 1');
      await page.evaluate(() => window.fixture.term.scrollToBottom());
      await page.waitForFunction(() => document.querySelector('.xterm-rows > div:last-child')?.textContent.trim() === 'line 100');
      const geometry = await page.locator('.xterm-rows > div').last().evaluate(row => {
        const body = row.closest('.terminal-body');
        const bounds = body.getBoundingClientRect();
        const terminal = row.closest('.xterm').getBoundingClientRect();
        return {
          gutters: [terminal.top - bounds.top, bounds.right - terminal.right,
            bounds.bottom - terminal.bottom, terminal.left - bounds.left],
          overflow: getComputedStyle(body).overflow,
          overhang: row.getBoundingClientRect().bottom - terminal.bottom,
        };
      });
      assert.deepEqual(geometry.gutters, [gutter, gutter, gutter, gutter], `gutters at ${height}px`);
      assert.equal(geometry.overflow, 'hidden');
      if (geometry.overhang > 0) clipped.push(`${height}px (+${geometry.overhang}px)`);
    }
    assert.deepEqual(clipped, [], 'last row extends past the terminal at these viewport heights');
  });
}
