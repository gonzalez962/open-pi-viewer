import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

const origin = 'http://message-model.test';
const owner = { cwd: '/fixture', sessionId: 's1', sessionFile: '/fixture/s1.jsonl' };
const active = { provider: 'openai', id: 'active-session-model', name: 'active-session-model' };
const fixtureOwner = owner;
const activeModel = active;
const timestamp = 1704067200000;

// Pi AssistantMessage (pi-ai/dist/types.d.ts): model and provider are top-level
// strings in message_end and in the raw messages returned by get_messages.
function assistant(text: string, metadata?: { provider: string; model: string }) {
  return {
    role: 'assistant', content: [{ type: 'text', text }], timestamp,
    api: 'openai-responses', stopReason: 'stop',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    ...metadata,
  };
}

let browser: Browser;
let appScript: string;
before(async () => {
  const bundle = await build({
    stdin: {
      resolveDir: process.cwd(), loader: 'tsx', contents: `
        import { createRoot } from 'react-dom/client';
        import { App } from './src/app/App';
        createRoot(document.getElementById('root')).render(<App />);
      `,
    },
    bundle: true, write: false, platform: 'browser', format: 'iife', tsconfig: 'tsconfig.app.json',
    loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
  });
  appScript = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

async function emit(page: Page, channel: string, payload: object) {
  await page.evaluate(({ channel, payload }) => {
    if (!('emitFixture' in window) || typeof window.emitFixture !== 'function') {
      throw new Error('Message model fixture emitter is not installed');
    }
    window.emitFixture(channel, payload);
  }, { channel, payload });
}

async function withViewer(run: (page: Page) => Promise<void>, timezoneId?: string) {
  const page = await browser.newPage({ timezoneId });
  try {
    page.setDefaultTimeout(5000);
    await page.route('**/*', route => route.request().url() === `${origin}/`
      ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
      : route.abort());
    const init = ({ owner, active }: { owner: typeof fixtureOwner; active: typeof activeModel }) => {
      const callbacks = new Map<number, (event: object) => void>();
      const listeners = new Map<string, Set<number>>();
      let next = 1;
      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          transformCallback(callback: (event: object) => void) {
            const id = next++;
            callbacks.set(id, callback);
            return id;
          },
          unregisterCallback(id: number) { callbacks.delete(id); },
          async invoke(command: string, args: { event: string; handler: number; eventId: number }) {
            if (command === 'plugin:event|listen') {
              if (!listeners.has(args.event)) listeners.set(args.event, new Set());
              listeners.get(args.event)!.add(args.handler);
              return args.handler;
            }
            if (command === 'plugin:event|unlisten') {
              listeners.get(args.event)?.delete(args.eventId);
              return null;
            }
            if (command === 'connect') return { ...owner, canonicalCwd: owner.cwd, messages: [], activity: 'idle', model: active };
            if (command === 'get_custom_providers') return { providers: {} };
            if (command === 'get_mcp_servers') return { servers: [] };
            if (command === 'get_sdd_profiles') return { profiles: [] };
            return null;
          },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
        fixtureReady: () => Boolean(listeners.get('pi://event')?.size && listeners.get('pi://status-change')?.size),
        emitFixture(event: string, payload: object) {
          for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload });
        },
      });
      localStorage.setItem('pi_viewer_projects', JSON.stringify({
        projects: [{ id: 'p1', path: owner.cwd, createdAt: new Date(0).toISOString() }], activeProjectId: 'p1',
      }));
      localStorage.setItem('pi_viewer_connect_config', JSON.stringify({ nodePath: '/node', piEntrypoint: '/pi.js', workingDirectory: owner.cwd }));
    };
    await page.addInitScript({ content: `(() => {
      const __name = value => value;
      (${init.toString()})(${JSON.stringify({ owner: fixtureOwner, active: activeModel })});
    })()` });
    await page.goto(origin);
    await page.addScriptTag({ content: appScript });
    await page.waitForFunction('window.fixtureReady()');
    await emit(page, 'pi://status-change', { ...owner, state: 'connected', label: 'Connected', detail: '', model: active });
    await snapshot(page, []);
    await page.locator('.model-name').getByText(active.id, { exact: true }).waitFor();
    await run(page);
  } finally {
    await page.close();
  }
}

function snapshot(page: Page, messages: object[]) {
  return emit(page, 'pi://event', { type: 'runtime_snapshot', ...owner, activity: 'idle', messages });
}

test('places one local date divider between messages across midnight', async () => withViewer(async page => {
  await snapshot(page, [
    { ...assistant('Before midnight'), timestamp: Date.parse('2026-01-02T04:59:00Z') },
    { ...assistant('After midnight'), timestamp: Date.parse('2026-01-02T05:01:00Z') },
    { ...assistant('Same morning'), timestamp: Date.parse('2026-01-02T06:00:00Z') },
  ]);
  await page.getByText('Same morning', { exact: true }).waitFor();
  const rows = page.locator('.message-list > :is(.message-assistant, .message-date-divider)');
  assert.equal(await rows.count(), 3);
  assert.match(await rows.nth(0).innerText(), /Before midnight/);
  assert.equal(await rows.nth(1).locator('time').getAttribute('datetime'), '2026-01-02');
  assert.match(await rows.nth(2).innerText(), /After midnight[\s\S]*Same morning/);
}, 'America/New_York'));
