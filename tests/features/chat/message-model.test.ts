import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

const origin = 'http://message-model.test';
const owner = { cwd: '/fixture', sessionId: 's1', sessionFile: '/fixture/s1.jsonl' };
const active = { provider: 'openai', id: 'active-session-model', name: 'active-session-model' };
const fixtureOwner = owner;
const activeModel = active;
const child = 'child-task-model';
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
    (window as Window & { emitFixture: (channel: string, payload: object) => void }).emitFixture(channel, payload);
  }, { channel, payload });
}

async function withViewer(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
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

async function live(page: Page, message: ReturnType<typeof assistant>) {
  const start = { ...message, content: [] };
  await emit(page, 'pi://event', { type: 'message_start', ...owner, message: start });
  await emit(page, 'pi://event', { type: 'message_end', ...owner, message });
}

async function cardText(page: Page, answer: string) {
  const card = page.locator('.message-assistant').filter({ hasText: answer });
  return card.innerText();
}

for (const [source, deliver] of [
  ['live', live],
  ['historical', (page: Page, message: ReturnType<typeof assistant>) => snapshot(page, [message])],
] as const) {
  test(`S2.1 displays the reported model on the ${source} assistant card`, async () => withViewer(async page => {
    const model = `${source}-reported-model`;
    const answer = `${source} assistant answer`;
    await deliver(page, assistant(answer, { provider: 'openai', model }));
    const card = await cardText(page, answer);
    assert.ok(!card.includes(active.id), 'card must not show the active session model');
    assert.ok(card.includes(model), `expected ${model} on the ${source} card; got ${JSON.stringify(card)}`);
  }));

  test(`S2.1 does not inherit the active model on a ${source} card with no metadata`, async () => withViewer(async page => {
    const answer = `${source} legacy answer`;
    await deliver(page, assistant(answer));
    assert.ok(!(await cardText(page, answer)).includes(active.id), 'card must not show the active session model');
  }));
}

test('S2.2 one grouped card shows distinct assistant models, not the subagent model', async () => withViewer(async page => {
  const first = { provider: 'openai', model: 'first-response-model' };
  const second = { provider: 'openai', model: 'second-response-model' };
  await snapshot(page, [
    assistant('First response', first),
    { role: 'custom', customType: 'gentle-agents.result', details: { gentleAgents: {
      taskId: 'child', agent: 'worker', status: 'completed', model: child,
    } } },
    assistant('Second response', second),
    assistant('Final response', first),
  ]);
  await page.locator('.subagent-entry').click();
  assert.match(await page.getByRole('dialog').innerText(), /child-task-model/, 'the viewer loaded the separate child report');
  await page.keyboard.press('Escape');
  const text = await cardText(page, 'Final response');
  assert.equal(await page.locator('.message-assistant').count(), 1);
  assert.match(text, /First response/);
  assert.match(text, /Second response/);
  assert.ok(!text.includes(child), 'card must not show the reported subagent model');
  assert.ok(!text.includes(active.id), 'card must not show the active session model');
  assert.deepEqual([text.split(first.model).length - 1, text.split(second.model).length - 1], [1, 1],
    `expected each distinct assistant model once on the card; got ${JSON.stringify(text)}`);
}));
