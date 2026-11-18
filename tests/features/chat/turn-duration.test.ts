import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { build } from 'esbuild';
import { chromium, type Browser, type Page } from 'playwright';

const origin = 'http://turn-duration.test';
const owner = { cwd: '/fixture', sessionId: 'one', sessionFile: '/fixture/one.jsonl' };
const model = { provider: 'openai', id: 'fixture-model', name: 'fixture-model' };
const prompt = 'Inspect the fixture';
const answer = 'Inspection complete';
const timestamp = 1704067200000;
const text = (value: string) => [{ type: 'text', text: value }];
const user = { role: 'user', content: text(prompt), timestamp };
const args = { path: 'fixture.txt' };
const tool = { toolCallId: 'call_read_fixture', toolName: 'read' };
const output = { content: text('fixture data'), isError: false };
const result = { role: 'toolResult', timestamp: timestamp + 1900, ...tool, ...output };
const assistant = {
  role: 'assistant', provider: model.provider, model: model.id, api: 'openai-responses',
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
};
const toolCall = { ...assistant, content: [{ type: 'toolCall', id: tool.toolCallId, name: tool.toolName, arguments: args }],
  stopReason: 'toolUse', timestamp: timestamp + 200 };
const final = { ...assistant, content: text(answer), stopReason: 'stop', timestamp: timestamp + 2400 };
const history = [user, toolCall, result, final];

let browser: Browser;
let script: string;
before(async () => {
  const bundle = await build({
    stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
      import { createRoot } from 'react-dom/client';
      import { App } from './src/app/App';
      createRoot(document.getElementById('root')).render(<App />);
    ` },
    bundle: true, write: false, platform: 'browser', format: 'iife', tsconfig: 'tsconfig.app.json',
    loader: { '.css': 'empty' }, define: { 'process.env.NODE_ENV': '"test"' },
  });
  script = bundle.outputFiles[0].text;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); });

type Owner = typeof owner;
type Model = typeof model;
async function withViewer(run: (page: Page) => Promise<void>) {
  const page = await browser.newPage();
  try {
    page.setDefaultTimeout(5000);
    await page.route('**/*', route => route.request().url() === `${origin}/`
      ? route.fulfill({ contentType: 'text/html', body: '<div id="root"></div>' })
      : route.abort());
    const init = (defaults: { owner: Owner; model: Model }) => {
      const { owner, messages = [] } = JSON.parse(sessionStorage.getItem('fixture-reopen') ?? 'null') ?? defaults;
      const callbacks = new Map<number, (event: object) => void>();
      const listeners = new Map<string, Set<number>>();
      let next = 1;
      let elapsed = 0;
      Date.now = () => 1704067200000 + elapsed;
      performance.now = () => elapsed;
      Object.assign(window, {
        isTauri: true,
        __TAURI_INTERNALS__: {
          transformCallback(callback: (event: object) => void) {
            const id = next++;
            callbacks.set(id, callback);
            return id;
          },
          unregisterCallback(id: number) { callbacks.delete(id); },
          async invoke(command: string, args: { event: string; handler: number; eventId: number; payload?: { id: string; streamingBehavior?: string } }) {
            if (command === 'plugin:event|listen') {
              if (!listeners.has(args.event)) listeners.set(args.event, new Set());
              listeners.get(args.event)!.add(args.handler);
              return args.handler;
            }
            if (command === 'plugin:event|unlisten') {
              listeners.get(args.event)?.delete(args.eventId);
              return null;
            }
            if (command === 'connect') return { ...owner, canonicalCwd: owner.cwd, connected: true, messages, activity: 'idle', model: defaults.model };
            if (command === 'send_prompt') return { accepted: true, id: args.payload?.id };
            if (command === 'get_custom_providers') return { providers: {} };
            if (command === 'get_mcp_servers') return { servers: [] };
            if (command === 'get_sdd_profiles') return { profiles: [] };
            return null;
          },
        },
        __TAURI_EVENT_PLUGIN_INTERNALS__: { unregisterListener() {} },
        fixtureEvent(at: number, payload: object) {
          elapsed = at;
          const event = 'pi://event';
          for (const id of listeners.get(event) ?? []) callbacks.get(id)?.({ event, id, payload: { ...owner, ...payload } });
        },
      });
      localStorage.setItem('pi_viewer_projects', JSON.stringify({
        projects: [{ id: 'p1', path: owner.cwd, createdAt: new Date(0).toISOString() }], activeProjectId: 'p1',
      }));
      localStorage.setItem('pi_viewer_connect_config', JSON.stringify({ nodePath: '/node', piEntrypoint: '/pi.js', workingDirectory: owner.cwd }));
    };
    await page.addInitScript({ content: `(() => {
      const __name = value => value;
      (${init.toString()})(${JSON.stringify({ owner, model })});
    })()` });
    await page.goto(origin);
    await mount(page);
    await run(page);
  } finally {
    await page.close();
  }
}

async function mount(page: Page) {
  await page.addScriptTag({ content: script });
  await page.locator('.model-name').getByText(model.id, { exact: true }).waitFor();
}

async function reopen(page: Page, owner: Owner, messages: object[]) {
  await page.evaluate(data => sessionStorage.setItem('fixture-reopen', JSON.stringify(data)), { owner, messages });
  await page.reload();
  await mount(page);
}

async function emit(page: Page, at: number, type: string, data: object = {}) {
  await page.evaluate(({ at, event }) => {
    if (!('fixtureEvent' in window) || typeof window.fixtureEvent !== 'function') throw new Error('missing fixture bridge');
    window.fixtureEvent(at, event);
  }, { at, event: { ...data, type } });
}

async function send(page: Page, value: string) {
  await page.locator('#prompt-input').fill(value);
  await page.locator('.prompt-action-btn.btn-send').click();
  await page.locator('.message-user').filter({ hasText: value }).waitFor();
}

async function message(page: Page, at: number, complete: { role: string; content: object[]; stopReason?: string }) {
  const initial = complete.role === 'assistant' ? { ...complete, content: [], stopReason: 'pending' } : complete;
  await emit(page, at, 'message_start', { message: initial });
  await emit(page, at + 100, 'message_end', { message: complete });
}

async function start(page: Page, observed = true) {
  await send(page, prompt);
  if (observed) await emit(page, 1000, 'agent_start');
  await emit(page, 1100, 'turn_start');
  await message(page, 1200, user);
}

async function throughTools(page: Page) {
  await message(page, 1700, toolCall);
  await emit(page, 2000, 'tool_execution_start', { ...tool, args });
  await emit(page, 9000, 'tool_execution_end', { ...tool, result: output, isError: false, durationMs: 7000 });
  await message(page, 9100, result);
  await emit(page, 9300, 'turn_end', { message: toolCall, toolResults: [result] });
  await emit(page, 9400, 'turn_start');
  await message(page, 10000, final);
  await emit(page, 10200, 'turn_end', { message: final, toolResults: [] });
}

async function lowLevelEnd(page: Page, messages: object[] = history, transport: 'desktop' | 'web' = 'desktop') {
  const end = { messages, willRetry: false };
  await emit(page, 11000, 'agent_end', end);
  // Desktop clones agent_end; web also synthesizes settlement but drops willRetry.
  // Neither synthetic frame has Pi's explicit aborted flag.
  await emit(page, 11000, 'agent_settled', transport === 'desktop' ? end : { messages });
}

async function header(page: Page, response = answer) {
  const card = page.locator('.message-assistant').filter({ has: page.getByText(response, { exact: true }) });
  return card.locator('.message-header').evaluate(header => Array.from(header.children, child => child.textContent).join(' '));
}

const twelveSeconds = /\b(?:12(?:[.,]0+)?\s*(?:s\b|sec(?:ond)?s?\b)|00:12)(?!:\d)/i;
const duration = /\b(?:duration|elapsed|turn time)\b|\b\d+(?:[.,]\d+)?\s*(?:ms|s|sec(?:ond)?s?)\b/i;

test('S3.1 measures the whole observed turn, including tools, only at Pi settlement', () => withViewer(async page => {
  await start(page);
  await throughTools(page);
  assert.equal(await page.locator('.message-assistant').count(), 1, 'tool call and answer share a card');
  assert.doesNotMatch(await header(page), duration, 'a final assistant message is not a settled run');
  await lowLevelEnd(page);
  assert.doesNotMatch(await header(page), duration, 'a bridge-synthesized settle does not prove completion');
  await emit(page, 13000, 'agent_settled', { aborted: false });
  assert.match(await header(page), twelveSeconds, 'expected 12 s from browser-observed start to Pi settle, not 7 s of tool execution or the message timestamps');
}));

test('S3.2 restores the idless Pi response duration on page reload only for its owner', () => withViewer(async page => {
  await start(page);
  await throughTools(page);
  await lowLevelEnd(page, history, 'web');
  assert.doesNotMatch(await header(page), duration, 'web-synthesized settle also lacks completion evidence');
  await emit(page, 13000, 'agent_settled', { aborted: false });
  await reopen(page, owner, history);
  const sameOwner = await header(page);
  // Cold web hydration adds JSONL entry IDs not present on the live RPC messages.
  const copiedHistory = history.map((entry, index) => ({ ...entry, id: `entry-${index}` }));
  await reopen(page, { ...owner, sessionFile: '/fixture/copy.jsonl' }, copiedHistory);
  assert.doesNotMatch(await header(page), duration, 'copy with identical sessionId and payload is not the same file');
  await reopen(page, { ...owner, cwd: '/different-connection', sessionFile: '/different-connection/one.jsonl' }, copiedHistory);
  assert.doesNotMatch(await header(page), duration, 'a different connection cannot claim the duration');
  await reopen(page, owner, copiedHistory);
  const diskHistory = await header(page);
  // If two cards in the same owner have the same raw anchors, neither is a unique match.
  await reopen(page, owner, [...history, ...history]);
  const duplicateCards = page.locator('.message-assistant').filter({ has: page.getByText(answer, { exact: true }) });
  assert.equal(await duplicateCards.count(), 2);
  for (const card of await duplicateCards.all()) assert.doesNotMatch(await card.locator('.message-header').innerText(), duration);
  assert.deepEqual([sameOwner, diskHistory].map(value => twelveSeconds.test(value)), [true, true],
    `expected the saved 12 s in raw RPC and disk-backed history; got ${JSON.stringify([sameOwner, diskHistory])}`);
}));

for (const missing of ['start', 'finish'] as const) {
  test(`S3.3 does not display or restore a duration with no observed ${missing}`, () => withViewer(async page => {
    await start(page, missing !== 'start');
    await throughTools(page);
    await lowLevelEnd(page);
    if (missing !== 'finish') await emit(page, 13000, 'agent_settled', { aborted: false });
    assert.doesNotMatch(await header(page), duration);
    await reopen(page, owner, history);
    assert.doesNotMatch(await header(page), duration);
  }));
}

test('S3.3 cancelled after the final response is not completed, even after reopening', () => withViewer(async page => {
  await start(page);
  await throughTools(page);
  await lowLevelEnd(page);
  await emit(page, 13000, 'agent_settled', { aborted: true });
  assert.doesNotMatch(await header(page), duration);
  await reopen(page, owner, history);
  assert.doesNotMatch(await header(page), duration);
}));

test('S3.3 one run draining a follow-up does not assign elapsed time to either response', () => withViewer(async page => {
  const followUp = 'Inspect the second fixture';
  const followUpUser = { ...user, content: text(followUp), timestamp: timestamp + 2500 };
  const followUpAnswer = 'Second fixture inspected';
  const followUpFinal = { ...final, content: text(followUpAnswer), timestamp: timestamp + 3000 };
  await start(page);
  await send(page, followUp);
  await emit(page, 1400, 'queue_update', { steering: [], followUp: [followUp] });
  await throughTools(page);
  await emit(page, 10300, 'turn_start');
  await emit(page, 10400, 'queue_update', { steering: [], followUp: [] });
  await message(page, 10500, followUpUser);
  await message(page, 10650, followUpFinal);
  await emit(page, 10800, 'turn_end', { message: followUpFinal, toolResults: [] });
  const mixedHistory = [...history, followUpUser, followUpFinal];
  await lowLevelEnd(page, mixedHistory);
  await emit(page, 13000, 'agent_settled', { aborted: false });
  for (const response of [answer, followUpAnswer]) assert.doesNotMatch(await header(page, response), duration);
  await reopen(page, owner, mixedHistory);
  for (const response of [answer, followUpAnswer]) assert.doesNotMatch(await header(page, response), duration);
}));
