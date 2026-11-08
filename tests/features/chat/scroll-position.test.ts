import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from 'playwright';

const bundle = build({
  stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
    import React, {useState} from 'react';
    import {createRoot} from 'react-dom/client';
    import {useChatScroll} from './src/features/chat/hooks/useChatScroll';
    function App() {
      const [context,setContext] = useState({projectId:'A',sessionId:'1',showSettings:false,isHydrated:true});
      const [height,setHeight] = useState(2000);
      const [messages,setMessages] = useState([{}]);
      const hook = useChatScroll({...context,messages});
      window.update = patch => setContext(c=>({...c,...patch}));
      window.grow = () => {setHeight(h=>h+500);setMessages(m=>[...m,{}]);};
      window.hook = hook;
      return <>{!context.showSettings && <main ref={hook.chatViewportRef} onScroll={hook.handleViewportScroll}
        style={{height:200,overflow:'auto'}}><div style={{height}} /></main>}
        <button onClick={hook.handleScrollToBottom}>Bottom</button><output>{String(hook.showScrollBottom)}</output></>;
    }
    createRoot(document.getElementById('root')).render(<App/>);
  ` }, bundle: true, write: false, platform: 'browser', format: 'iife', tsconfig: 'tsconfig.app.json',
  define: { 'process.env.NODE_ENV': '"test"' },
});
async function withPage(run: (page: any) => Promise<void>) {
  const browser = await chromium.launch({headless:true});
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(3000);
    await page.route('http://scroll.test/**', (route: any) => route.fulfill({contentType:'text/html',body:'<div id="root"></div>'}));
    await page.goto('http://scroll.test');
    const script = (await bundle).outputFiles[0].text;
    await page.addScriptTag({content:script});
    await page.waitForFunction('window.hook');
    (page as any).script = script;
    await run(page);
  } finally { await browser.close(); }
}
async function update(page: any, patch: object) {
  await page.evaluate((patch: object)=>(window as any).update(patch),patch);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
}
async function scroll(page: any, top: number) {
  await page.locator('main').evaluate((el: HTMLElement, top: number)=>{el.scrollTop=top;el.dispatchEvent(new Event('scroll',{bubbles:true}));},top);
}
async function position(page: any) { return page.locator('main').evaluate((el: HTMLElement)=>el.scrollTop); }

test('reading positions survive session switches, Settings, projects and reload', async()=>withPage(async page=>{
  assert.equal(await position(page),1800,'new session starts at bottom');
  await scroll(page,400);
  await update(page,{sessionId:'2'});
  assert.equal(await position(page),1800);
  await scroll(page,700);
  await update(page,{sessionId:'1'});
  assert.equal(await position(page),400);
  assert.equal(await page.locator('output').textContent(),'true');
  await update(page,{showSettings:true});
  await update(page,{showSettings:false});
  assert.equal(await position(page),400);
  await update(page,{projectId:'B'});
  assert.equal(await position(page),1800);
  await scroll(page,900);
  await update(page,{projectId:'A'});
  assert.equal(await position(page),400);
  await page.reload();
  await page.addScriptTag({content:page.script});
  await page.waitForFunction('window.hook');
  assert.equal(await position(page),400);
  await update(page,{sessionId:'2'});
  assert.equal(await position(page),700);
}));

test('streaming follows bottom only when pinned and explicit bottom action still works',async()=>withPage(async page=>{
  await scroll(page,400);
  await page.evaluate('window.grow()');
  await update(page,{});
  assert.equal(await position(page),400);
  await page.getByRole('button').click();
  await page.waitForFunction('document.querySelector("main").scrollTop === 2300');
  await page.evaluate('window.grow()');
  await page.waitForFunction('document.querySelector("main").scrollTop === 2800');
  await update(page,{showSettings:true});
  await update(page,{showSettings:false});
  assert.equal(await position(page),2800);
}));

test('restoration waits for hydrated messages and ignores obsolete scheduled jumps',async()=>withPage(async page=>{
  await scroll(page,400);
  await update(page,{sessionId:'2',isHydrated:false});
  await update(page,{isHydrated:true});
  await page.evaluate(()=>{(window as any).hook.pinAndJumpToBottom();(window as any).update({sessionId:'1'});});
  await page.waitForFunction('document.querySelector("main").scrollTop === 400');
  await update(page,{});
  assert.equal(await position(page),400);
}));

test('malformed stored positions fall back to bottom', async()=>withPage(async page=>{
  await page.evaluate(()=>localStorage.setItem('chat-scroll:["A","2"]', '{broken'));
  await update(page,{sessionId:'2'});
  assert.equal(await position(page),1800);
  assert.equal(await page.locator('output').textContent(),'false');
}));

test('unavailable localStorage does not break chat scrolling',async()=>withPage(async page=>{
  await page.evaluate(()=>Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked');}}));
  await scroll(page,400);
  await update(page,{sessionId:'2'});
  assert.equal(await position(page),1800);
  await page.evaluate('window.grow()');
  await page.waitForFunction('document.querySelector("main").scrollTop === 2300');
}));
