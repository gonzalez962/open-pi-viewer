import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { build } from 'esbuild';

test('S1.2 profile restoration refetches recorded context after a real model switch', { timeout: 25000 }, async () => {
  const bundle = await build({
    stdin: { contents: `
      import React, {useReducer} from 'react';
      import {createRoot} from 'react-dom/client';
      import {useModels} from './src/features/providers/hooks/useModels.ts';
      import {useProfileRuntime} from './src/features/profiles/hooks/useProfileRuntime.ts';
      import {chatReducer, INITIAL_STATE} from './src/core/reducer/index.ts';
      import {calculateContextMetrics, getModelStatsKey} from './src/core/prompt-controls-utils.ts';
      const profile = {name:'default', scope:'project', is_active:true, agent_count:0, default_model:'cpam/agy_p1/gemini-3.8-flash-high'};
      window.trace = [];
      function reducer(state, action) {
        const next = chatReducer(state, action);
        window.trace.push({action:action.type, from:getModelStatsKey(state.modelInfo), to:getModelStatsKey(next.modelInfo), metrics:calculateContextMetrics(next.sessionStats, next.modelInfo)});
        return next;
      }
      function App() {
        const [state, dispatch] = useReducer(reducer, {...INITIAL_STATE, connectionStatus:'connected', sessionId:'s', modelInfo:{id:'initial-model',provider:'other'}});
        const hook = useModels({connectionStatus:state.connectionStatus, sessionId:state.sessionId, projectId:'p1', cwd:'/p1', modelInfo:state.modelInfo, availableModels:state.availableModels, dispatch});
        useProfileRuntime({cwd:'/p1', sessionId:state.sessionId, isConnected:true, isBusy:false, isSessionInitialized:hook.isSessionInitialized, isProfilesLoaded:true, effectiveProfile:profile, availableModels:state.availableModels, onSelectModel:hook.handleSelectModel, onSelectThinkingLevel:hook.handleSelectThinkingLevel});
        window.state = state;
        return null;
      }
      createRoot(document.getElementById('root')).render(React.createElement(App));
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife',
    tsconfig: 'tsconfig.app.json', define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'mock-bridge', setup(builder) {
      builder.onResolve({ filter: /^@infra\/bridge$/ }, () => ({ path: 'bridge', namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
        export const getEnabledModelsPi = async () => [];
        export const getAvailableModelsPi = async () => [{id:'initial-model',provider:'other',input_modalities:['text']},{id:'agy_p1/gemini-3.8-flash-high',provider:'cpam',input_modalities:['text']}];
        export const getAvailableThinkingLevelsPi = async () => [];
        window.statsCalls = []; window.selections = [];
        export const getSessionStatsPi = options => new Promise(resolve => { window.statsCalls.push({options,resolve}) });
        export const getCustomProvidersPi = async () => ({providers:{}});
        export const getModelThinkingLevelsPi = async () => ({});
        export const setThinkingLevelPi = async () => {};
        export const saveEnabledModelsPi = async () => {};
        export const setModelPi = async (provider,id) => { window.selections.push({provider,id}); return {provider,id,contextWindow:370000}; };
      `, loader: 'js' }));
    } }],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction('window.statsCalls.length === 1');
    await page.evaluate(`window.statsCalls[0].resolve({sessionId:'s',contextUsage:{tokens:43879,contextWindow:370000,percent:11.85918918918919},tokens:{total:258863}})`);
    await page.waitForFunction(`window.selections.length === 1 && window.trace.filter(x => x.action === 'MODEL_CHANGE_SUCCESS').length >= 2`);
    const beforeRefresh = await page.evaluate(`({trace:window.trace, selections:window.selections})`) as any;
    assert.deepEqual(beforeRefresh.selections, [{provider:'cpam',id:'agy_p1/gemini-3.8-flash-high'}]);
    assert.equal(beforeRefresh.trace.find((x: any) => x.action === 'SET_SESSION_STATS').metrics.contextTokens, 43879);
    const switched = beforeRefresh.trace.filter((x: any) => x.action === 'MODEL_CHANGE_SUCCESS').at(-1);
    assert.equal(switched.from, 'other/initial-model');
    assert.equal(switched.to, 'cpam/agy_p1/gemini-3.8-flash-high');
    assert.equal(switched.metrics.contextTokens, 0);
    await page.waitForFunction('window.statsCalls.length === 2');
    assert.deepEqual(await page.evaluate('window.statsCalls[1].options'), {workingDirectory:'/p1',sessionId:'s'});
    await page.evaluate(`window.statsCalls[1].resolve({sessionId:'s',contextUsage:{tokens:43879,contextWindow:370000,percent:11.85918918918919},tokens:{total:258863}})`);
    await page.waitForFunction(`window.trace.filter(x => x.action === 'SET_SESSION_STATS').length === 2`);
    const metrics = await page.evaluate(`window.trace.filter(x => x.action === 'SET_SESSION_STATS').at(-1).metrics`) as any;
    assert.equal(metrics.contextTokens, 43879);
  } finally {
    await browser.close();
  }
});

test('D7 selection refresh rejects stale owners and selections and accepts zero', { timeout: 45000 }, async () => {
  const bundle = await build({
    stdin: { contents: `
      import React, {useReducer, useState} from 'react';
      import {createRoot} from 'react-dom/client';
      import {useModels} from './src/features/providers/hooks/useModels.ts';
      import {chatReducer, INITIAL_STATE} from './src/core/reducer/index.ts';
      function App() {
        const [state, dispatch] = useReducer(chatReducer, {...INITIAL_STATE, connectionStatus:'connected', sessionId:'s', modelInfo:{id:'a',provider:'p',input_modalities:['text']}});
        const [owner, setOwner] = useState({projectId:'p1',cwd:'/p1',sessionId:'s',connectionStatus:'connected'});
        const hook = useModels({...owner, modelInfo:state.modelInfo, availableModels:state.availableModels, dispatch});
        window.state = state; window.hook = hook; window.setOwner = setOwner; window.owner = owner;
        return null;
      }
      createRoot(document.getElementById('root')).render(React.createElement(App));
    `, resolveDir: process.cwd(), loader: 'tsx' },
    bundle: true, write: false, platform: 'browser', format: 'iife', tsconfig: 'tsconfig.app.json',
    define: { 'process.env.NODE_ENV': '"test"' },
    plugins: [{ name: 'mock-bridge', setup(builder) {
      builder.onResolve({ filter: /^@infra\/bridge$/ }, () => ({ path: 'bridge', namespace: 'mock' }));
      builder.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: `
        window.calls = [];
        export const getEnabledModelsPi = async () => [];
        export const getAvailableModelsPi = async () => [];
        export const getAvailableThinkingLevelsPi = async () => [];
        export const getSessionStatsPi = options => new Promise((resolve,reject) => window.calls.push({options,resolve,reject}));
        export const getCustomProvidersPi = async () => ({providers:{}});
        export const getModelThinkingLevelsPi = async () => ({});
        export const setThinkingLevelPi = async () => {};
        export const saveEnabledModelsPi = async () => {};
        export const setModelPi = async (provider,id) => ({provider,id});
      `, loader: 'js' }));
    } }],
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    page.setDefaultTimeout(5000);
    await page.setContent('<div id="root"></div>');
    await page.addScriptTag({ content: bundle.outputFiles[0].text });
    await page.waitForFunction('window.calls.length === 1');
    await page.evaluate(`window.calls[0].resolve(null)`);
    await page.waitForFunction('window.hook.isSessionInitialized');
    await page.evaluate(() => { (window as any).first = (window as any).hook.handleSelectModel('p','b'); });
    await page.waitForFunction('window.calls.length === 2');
    await page.evaluate(() => { (window as any).second = (window as any).hook.handleSelectModel('p','c'); });
    await page.waitForFunction('window.calls.length === 3');
    await page.evaluate(`window.calls[2].resolve({sessionId:'s',contextUsage:{tokens:12,contextWindow:100,percent:12}}); window.second`);
    await page.waitForFunction('window.state.sessionStats?.contextUsage?.tokens === 12');
    await page.evaluate(`window.calls[1].resolve({sessionId:'s',contextUsage:{tokens:99,contextWindow:100,percent:99}}); window.first`);
    assert.equal(await page.evaluate('window.state.sessionStats.contextUsage.tokens'), 12);
    for (const change of ["projectId:'p2'", "cwd:'/p2'", "sessionId:'other'", "connectionStatus:'disconnected'"]) {
      const count = await page.evaluate('window.calls.length') as number;
      await page.evaluate(() => { (window as any).pending = (window as any).hook.handleSelectModel('p','c'); });
      await page.waitForFunction(`window.calls.length === ${count + 1}`);
      await page.evaluate(`window.setOwner({...window.owner,${change}})`);
      await page.waitForFunction(`JSON.stringify(window.owner) !== JSON.stringify({projectId:'p1',cwd:'/p1',sessionId:'s',connectionStatus:'connected'})`);
      await page.evaluate(`window.setOwner({projectId:'p1',cwd:'/p1',sessionId:'s',connectionStatus:'connected'})`);
      await page.waitForFunction(`window.owner.projectId === 'p1' && window.owner.cwd === '/p1' && window.owner.sessionId === 's' && window.owner.connectionStatus === 'connected'`);
      await page.evaluate(`window.calls[${count}].resolve({sessionId:'s',contextUsage:{tokens:99,contextWindow:100,percent:99}}); window.pending`);
      assert.equal(await page.evaluate('window.state.sessionStats.contextUsage.tokens'), 12);
    }
    const count = await page.evaluate('window.calls.length') as number;
    await page.evaluate(() => { (window as any).pending = (window as any).hook.handleSelectModel('p','c'); });
    await page.waitForFunction(`window.calls.length === ${count + 1}`);
    await page.evaluate(`window.calls[${count}].resolve({sessionId:'other',contextUsage:{tokens:99,contextWindow:100,percent:99}}); window.pending`);
    assert.equal(await page.evaluate('window.state.sessionStats.contextUsage.tokens'), 12);
    await page.evaluate(() => { (window as any).pending = (window as any).hook.handleSelectModel('p','c'); });
    await page.waitForFunction(`window.calls.length === ${count + 2}`);
    await page.evaluate(`window.calls[${count + 1}].resolve({sessionId:'s',contextUsage:{tokens:0,contextWindow:100,percent:0}}); window.pending`);
    await page.waitForFunction('window.state.sessionStats?.contextUsage?.tokens === 0');
    await page.evaluate(() => { (window as any).pending = (window as any).hook.handleSelectModel('p','c'); });
    await page.waitForFunction(`window.calls.length === ${count + 3}`);
    await page.evaluate(`window.calls[${count + 2}].reject(new Error('offline')); window.pending`);
    assert.equal(await page.evaluate('window.state.sessionStats.contextUsage.tokens'), 0);
  } finally {
    await browser.close();
  }
});

test('model hydration uses the current model and preserves stats and real switches', { timeout: 45000 }, async () => {
  const bundle = await build({
    stdin: { contents: `
            import React, {useReducer} from 'react';
            import {createRoot} from 'react-dom/client';
            import {useModels} from './src/features/providers/hooks/useModels.ts';
            import {chatReducer, INITIAL_STATE} from './src/core/reducer/index.ts';
            function App() {
              const [state, dispatch] = useReducer(chatReducer, {...INITIAL_STATE, connectionStatus:'connected', sessionId:'s'});
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
            export const getSessionStatsPi = () => new Promise(resolve => { if (!window.resolveStats) window.resolveStats = resolve; else window.resolveSwitchStats = resolve; });
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
    await page.evaluate(`window.dispatch({type:'SET_SESSION_STATS',payload:{stats:{sessionId:'s',contextUsage:{tokens:1200,contextWindow:10000,percent:12}}}})`);
    await page.waitForFunction(`window.state.sessionStats?.contextUsage?.tokens === 1200`);
    await page.evaluate(`window.dispatch({type:'SESSION_READY',payload:{sessionId:'s',messages:[],model:{id:'b',provider:'p'}}})`);
    await page.waitForFunction(`window.state.modelInfo.id === 'b'`);
    await page.evaluate(`window.resolveStats(null)`);
    await page.waitForFunction('window.hook.isSessionInitialized');
    const hydrated = await page.evaluate('window.state') as any;
    assert.equal(hydrated.modelInfo.id, 'b');
    assert.deepEqual(hydrated.modelInfo.input_modalities, ['text']);
    assert.equal(hydrated.sessionStats?.contextUsage?.tokens, 1200);
    await page.evaluate(() => { (window as any).selection = (window as any).hook.handleSelectModel('p','a'); });
    await page.waitForFunction(`window.state.modelInfo.id === 'a'`);
    const switched = await page.evaluate('window.state') as any;
    assert.equal(switched.sessionStats, null);
    await page.waitForFunction('window.resolveSwitchStats');
    await page.evaluate(`window.resolveSwitchStats(null); window.selection`);
  } finally {
    await browser.close();
  }
});
