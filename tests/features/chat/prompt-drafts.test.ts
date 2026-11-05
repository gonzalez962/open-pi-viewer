import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {usePromptState} from './src/features/chat/hooks/usePromptState.ts';
    import {PromptControls} from './src/features/chat/PromptControls.tsx';
    function App() {
      const [context, setContext] = useState({projectId:'A', sessionId:'1', busy:false});
      const hook = usePromptState({...context, isReadyToSend:!context.busy, isBusy:context.busy, canQueue:context.busy,
        pendingPromptId:null, dispatch: action => window.actions.push(action), pinAndJumpToBottom:()=>{}, messages:[], language:'en',
        onNewConversation:()=>{}, onReload:()=>({status:'busy'}), onExport:args=>window.exports.push(args)});
      window.hook = hook; window.setContext = setContext;
      return <form onSubmit={hook.handleSend}><textarea value={hook.prompt} onChange={e=>hook.setPrompt(e.target.value)} />
        <output>{hook.attachedFiles.map(f=>f.name).join(',')}</output>
        <PromptControls modelInfo={{id:'model',provider:'p',input_modalities:['text']}} availableModels={[]} isChangingModel={false}
          thinkingLevel={null} availableThinkingLevels={[]} sessionStats={null} isConnected={true} isBusy={false}
          onSelectModel={async()=>{}} onSelectThinkingLevel={async()=>{}} supportsFiles={true} onAttachFiles={hook.addAttachedFiles} t={key=>key} />
        <button id="submit">submit</button></form>;
    }
    window.actions=[]; window.exports=[];
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', tsconfig: 'tsconfig.app.json',
  define: { 'process.env.NODE_ENV': '"test"' },
  plugins: [{name:'bridge', setup(b) {
    b.onResolve({filter:/^@infra\/bridge$/},()=>({path:'bridge',namespace:'mock'}));
    b.onLoad({filter:/.*/,namespace:'mock'},()=>({contents:`export const sendPromptPi=async id=>({id}); export const abortPi=async()=>{};`,loader:'js'}));
  }}],
});

async function withPage(run: (page: any) => Promise<void>) {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(2000);
    await page.setContent('<div id="root"></div>');
    // about:blank is not a secure context, so Chromium omits randomUUID.
    await page.evaluate("if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', {value: () => 'test-attachment-id'})");
    await page.addScriptTag({content:(await bundle).outputFiles[0].text});
    await page.waitForFunction('window.hook && window.setContext');
    await run(page);
  } finally { await browser.close(); }
}

async function context(page: any, projectId: string, sessionId: string | null, busy = false) {
  await page.evaluate(([projectId, sessionId, busy]: any[]) => (window as any).setContext({projectId,sessionId,busy}), [projectId,sessionId,busy]);
  await page.waitForTimeout(30);
}
async function draft(page: any) {
  return {text: await page.locator('textarea').inputValue(), files: await page.locator('output').textContent()};
}
async function attach(page: any, name: string) {
  await page.locator('input[type=file]').setInputFiles({name,mimeType:'text/plain',buffer:Buffer.from('content')});
  await page.waitForFunction((name: string) => document.querySelector('output')?.textContent?.includes(name), name);
}

test('S1.1 session drafts are isolated and restored', async () => withPage(async page => {
  await page.locator('textarea').fill('session one');
  await context(page,'A','2');
  assert.deepEqual(await draft(page), {text:'',files:''});
  await page.locator('textarea').fill('session two');
  await context(page,'A','1');
  assert.deepEqual(await draft(page), {text:'session one',files:''});
  await context(page,'A','2');
  assert.deepEqual(await draft(page), {text:'session two',files:''});
}));

test('S1.2 project drafts are isolated and restored', async () => withPage(async page => {
  await page.locator('textarea').fill('project A');
  await context(page,'B','1');
  assert.deepEqual(await draft(page), {text:'',files:''});
  await page.locator('textarea').fill('project B');
  await context(page,'A','1');
  assert.equal((await draft(page)).text,'project A');
  await context(page,'B','1');
  assert.equal((await draft(page)).text,'project B');
}));

test('S1.3 unbound drafts are distinct from projects and sessions', async () => withPage(async page => {
  await context(page,'A',null);
  await page.locator('textarea').fill('unbound A');
  await context(page,'B',null);
  assert.equal((await draft(page)).text,'');
  await page.locator('textarea').fill('unbound B');
  await context(page,'A','1');
  assert.equal((await draft(page)).text,'');
  await context(page,'A',null);
  assert.equal((await draft(page)).text,'unbound A');
  await context(page,'B',null);
  assert.equal((await draft(page)).text,'unbound B');
}));

test('S2.1 attachments follow session and project', async () => withPage(async page => {
  await attach(page,'one.txt');
  await context(page,'A','2');
  assert.equal((await draft(page)).files,'');
  await context(page,'B','1');
  assert.equal((await draft(page)).files,'');
  await context(page,'A','1');
  assert.equal((await draft(page)).files,'one.txt');
}));

test('S2.2 late attachment completion belongs to originating session', async () => withPage(async page => {
  await page.evaluate(`{
    const original = File.prototype.text;
    File.prototype.text = function() { return new Promise(resolve => { window.finishFile = () => original.call(this).then(resolve); }); };
  }`);
  await page.locator('input[type=file]').setInputFiles({name:'late.txt',mimeType:'text/plain',buffer:Buffer.from('late')});
  await page.waitForFunction('window.finishFile');
  await context(page,'A','2');
  await page.evaluate(() => (window as any).finishFile());
  await page.waitForTimeout(100);
  assert.equal((await draft(page)).files,'');
  await context(page,'A','1');
  assert.equal((await draft(page)).files,'late.txt');
}));

test('S3.2 export clears text and preserves attachments', async () => withPage(async page => {
  await attach(page,'keep.txt');
  await page.locator('textarea').fill('/export json');
  await page.locator('#submit').click();
  await page.waitForFunction('window.exports.length === 1');
  assert.deepEqual(await draft(page), {text:'',files:'keep.txt'});
  assert.deepEqual(await page.evaluate('window.exports'), ['json']);
  assert.deepEqual(await page.evaluate('window.actions'), []);
}));

test('S3.3 functional setters use latest originating draft', async () => withPage(async page => {
  await page.locator('textarea').fill('A');
  await page.evaluate(() => { (window as any).savedSetter = (window as any).hook.setPrompt; });
  await context(page,'B','1');
  await page.locator('textarea').fill('B');
  await page.evaluate(() => (window as any).savedSetter((value: string) => value + '!'));
  await page.waitForTimeout(30);
  assert.equal((await draft(page)).text,'B');
  await context(page,'A','1');
  assert.equal((await draft(page)).text,'A!');
}));

for (const busy of [false,true]) test(`S3.1 ${busy ? 'queue' : 'send'} clears only its draft`, async () => withPage(async page => {
  await page.locator('textarea').fill('other');
  await context(page,'B','1',busy);
  await page.locator('textarea').fill('send me');
  await attach(page,'send.txt');
  await page.locator('#submit').click();
  await page.waitForFunction(() => (window as any).actions.some((a: any) => a.type === 'PROMPT_SUBMIT' || a.type === 'PROMPT_QUEUED'));
  assert.deepEqual(await draft(page), {text:'',files:''});
  const actions = await page.evaluate('window.actions') as any[];
  assert.equal(actions[0].type,busy ? 'PROMPT_QUEUED' : 'PROMPT_SUBMIT');
  await context(page,'A','1');
  assert.equal((await draft(page)).text,'other');
}));
