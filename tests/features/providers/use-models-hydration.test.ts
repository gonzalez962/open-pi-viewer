import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';

test('model hydration uses the current model and preserves stats and real switches', { timeout: 45000 }, async () => {
  const bundle = await build({
    stdin: { contents: `
            import React, {useReducer} from 'react';
            import {createRoot} from 'react-dom/client';
            import {useModels} from './src/features/providers/hooks/useModels.ts';
            import {chatReducer, INITIAL_STATE} from './src/core/reducer/index.ts';
            function App() {
              const [state, dispatch] = useReducer(chatReducer, {...INITIAL_STATE, connectionStatus:'connected', sessionId:'s', modelInfo:{id:'a',provider:'p'}});
              const hook = useModels({connectionStatus:state.connectionStatus, sessionId:state.sessionId, projectId:'p1', cwd:'/p1', modelInfo:state.modelInfo, availableModels:state.availableModels, dispatch});
              window.state = state; window.dispatch = dispatch; window.hook = hook;
              return null;
            }
            createRoot(document.getElementById('root')).render(React.createElement(App));
          `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    tsconfig: 'tsconfig.app.json',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'mock-bridge', setup(builder) {
      builder.onResolve({ filter: /^@infra\/bridge$/ }, () => ({ path: 'bridge', namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
            export const getEnabledModelsPi = async () => [];
            export const getAvailableModelsPi = async () => [{id:'a',provider:'p',input_modalities:['text']},{id:'b',provider:'p',input_modalities:['text']}];
            export const getAvailableThinkingLevelsPi = async () => [];
            export const getSessionStatsPi = () => new Promise(resolve => { window.resolveStats = resolve });
            export const getCustomProvidersPi = async () => ({providers:{}});
            export const getModelThinkingLevelsPi = async () => ({});
            export const setThinkingLevelPi = async () => {};
            export const saveEnabledModelsPi = async () => {};
            export const setModelPi = async (provider, id) => ({provider,id});
          `, loader: 'js' }));
    } }],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction('window.resolveStats && window.dispatch');
    await page.evaluate(`window.dispatch({type:'SESSION_READY',payload:{sessionId:'s',messages:[],model:{id:'b',provider:'p'}}})`);
    await page.waitForFunction(`window.state.modelInfo.id === 'b'`);
    await page.evaluate(`window.resolveStats({sessionId:'s',contextUsage:{tokens:1200,contextWindow:10000,percent:12}})`);
    await page.waitForFunction('window.hook.isSessionInitialized');
    const hydrated = await page.evaluate('window.state') as any;
    assert.equal(hydrated.modelInfo.id, 'b');
    assert.deepEqual(hydrated.modelInfo.input_modalities, ['text']);
    assert.equal(hydrated.sessionStats?.contextUsage?.tokens, 1200);
    await page.evaluate(`window.hook.handleSelectModel('p','a')`);
    await page.waitForFunction(`window.state.modelInfo.id === 'a'`);
    const switched = await page.evaluate('window.state') as any;
    assert.equal(switched.sessionStats, null);
  } finally {
    await browser.close();
  }
});
