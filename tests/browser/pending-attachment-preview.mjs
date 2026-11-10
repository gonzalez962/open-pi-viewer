import { build } from 'esbuild';
import { chromium } from 'playwright';
import http from 'node:http';
import assert from 'node:assert/strict';

// The component harness is bundled in memory; it never sends a prompt or uploads files.
const entry = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PendingAttachments } from './src/features/chat/components/PendingAttachments';
const initial = [
  { id:'image', name:'image.png', type:'image', mimeType:'image/png', data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=', size:1 },
  { id:'file', name:'file.txt', type:'text', mimeType:'text/plain', content:'<hello>\\nworld', size:13 },
  { id:'video', name:'video.mp4', type:'video', mimeType:'video/mp4', data:'YWJj', size:1 },
  { id:'audio', name:'audio.mp3', type:'audio', mimeType:'audio/mpeg', data:'YWJj', size:1 },
  { id:'broken', name:'broken.png', type:'image', mimeType:'image/png', data:'YWJj', size:1 },
];
function Harness() {
  const [files, setFiles] = useState(initial);
  const [draft, setDraft] = useState('project-a/session-a');
  return <><button id="switch" onClick={() => setDraft('project-b/session-b')}>Switch draft</button>
    <button id="remove-selected" onClick={() => setFiles(f => f.filter(x => x.id !== 'audio'))}>Remove audio externally</button>
    <PendingAttachments key={draft} draftKey={draft} files={files} onRemove={id => setFiles(f => f.filter(x => x.id !== id))} t={key => key} />
  </>;
}
window.abortCount = 0;
window.addEventListener('keydown', e => { if (e.key === 'Escape') window.abortCount++; });
createRoot(document.getElementById('root')).render(<Harness />);
`;
const result = await build({ stdin: { contents: entry, resolveDir: process.cwd(), loader: 'tsx' }, bundle: true, write: false, platform: 'browser', format: 'iife', tsconfig: 'tsconfig.app.json' });
const js = result.outputFiles[0].contents;
const server = http.createServer((req, res) => {
  if (req.url === '/bundle.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(js); return; }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end('<!doctype html><html><body><div id="root"></div><script src="/bundle.js"></script></body></html>');
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4173, '127.0.0.1', resolve); });
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:4173');
  const trigger = name => page.getByRole('button', { name, exact: true });
  const dialog = page.getByRole('dialog');
  await trigger('image.png').click();
  await dialog.waitFor();
  assert.equal(await dialog.locator('img').count(), 1);
  const previous = dialog.getByRole('button', { name: 'attachment_preview.previous' });
  const next = dialog.getByRole('button', { name: 'attachment_preview.next' });
  assert.equal(await previous.isDisabled(), true);
  assert.equal(await dialog.getByText('1 / 5').count(), 1);
  await page.keyboard.press('ArrowLeft');
  assert.equal(await dialog.getAttribute('aria-label'), 'image.png');
  await next.click();
  assert.equal(await dialog.getAttribute('aria-label'), 'file.txt');
  assert.equal(await dialog.locator('code').textContent(), '<hello>\nworld');
  assert.equal(await dialog.getByText('2 / 5').count(), 1);
  await next.click();
  assert.equal(await dialog.getAttribute('aria-label'), 'video.mp4');
  await dialog.locator('video').evaluate(el => { window.oldVideo = el; el.pause = () => { window.videoPaused = true; }; });
  await dialog.locator('video').focus();
  await page.keyboard.press('ArrowRight');
  assert.equal(await dialog.getAttribute('aria-label'), 'video.mp4');
  await next.click();
  assert.equal(await dialog.getAttribute('aria-label'), 'audio.mp3');
  assert.equal(await page.evaluate(() => window.videoPaused && !window.oldVideo.isConnected), true);
  await page.keyboard.press('ArrowRight');
  await dialog.getByRole('alert').waitFor();
  assert.equal(await next.isDisabled(), true);
  assert.equal(await dialog.getByText('5 / 5').count(), 1);
  await page.keyboard.press('ArrowRight');
  assert.equal(await dialog.getAttribute('aria-label'), 'broken.png');
  await previous.click();
  assert.equal(await dialog.locator('audio').count(), 1);
  assert.equal(await dialog.getByRole('alert').count(), 0);
  await page.getByRole('button', { name: 'action.close' }).click();
  assert.equal(await trigger('image.png').evaluate(el => document.activeElement === el), true);
  await trigger('video.mp4').click();
  const video = dialog.locator('video');
  assert.equal(await video.count(), 1);
  assert.equal(await video.evaluate(el => el.controls && !el.autoplay), true);
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(), 0);
  assert.equal(await page.evaluate(() => window.abortCount), 0);
  assert.equal(await trigger('video.mp4').evaluate(el => document.activeElement === el), true);
  await trigger('audio.mp3').click();
  const audio = dialog.locator('audio');
  assert.equal(await audio.evaluate(el => el.controls && !el.autoplay), true);
  await page.locator('#remove-selected').click();
  assert.equal(await dialog.count(), 0);
  assert.equal(await audio.count(), 0);
  await page.getByRole('button', { name: 'prompt_controls.remove_attachment: file.txt' }).click();
  assert.equal(await dialog.count(), 0);
  assert.equal(await page.getByText('file.txt').count(), 0);
  await trigger('broken.png').click();
  await dialog.getByRole('alert').waitFor();
  await page.locator('#switch').click();
  assert.equal(await dialog.count(), 0);
  console.log('Pending attachment browser interactions passed');
} finally {
  if (browser) await browser.close();
  await new Promise(resolve => server.close(resolve));
}
