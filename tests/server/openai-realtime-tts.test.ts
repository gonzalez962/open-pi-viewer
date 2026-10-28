import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createHash } from 'node:crypto';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SpeechSettingsSection } from '@features/settings/components/SpeechSettingsSection';
import { DEFAULT_SPEECH_PREFERENCES } from '@core/types/speech';
import { synthesizeTts } from '@server/bridge/speech-runner';

// A loopback WebSocket peer exercises the public runner without a transport-specific test hook.
async function realtimePeer(mode: 'success' | 'error' | 'incomplete' | 'failed' | 'hang') {
  const events: any[] = [];
  const requests: string[] = [];
  const sockets = new Set<net.Socket>();
  const pcm = Buffer.from([1, 2, 3, 4, 5, 6]);
  const key = 'sk-realtime-fixture-secret';
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let pending = Buffer.alloc(0);
    let upgraded = false;
    const send = (event: unknown) => {
      const body = Buffer.from(JSON.stringify(event));
      assert.ok(body.length < 126);
      socket.write(Buffer.concat([Buffer.from([0x81, body.length]), body]));
    };
    socket.on('data', (chunk) => {
      pending = Buffer.concat([pending, Buffer.from(chunk)]);
      if (!upgraded) {
        const end = pending.indexOf('\r\n\r\n');
        if (end < 0) return;
        const headers = pending.subarray(0, end).toString();
        requests.push(headers);
        pending = pending.subarray(end + 4);
        const wsKey = /^sec-websocket-key:\s*(.+)\r?$/im.exec(headers)?.[1]?.trim();
        if (!wsKey) { socket.end('HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\nConnection: close\r\n\r\n'); return; }
        const accept = createHash('sha1').update(wsKey + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        upgraded = true;
        send({ type: 'session.created', session: { id: 'session-fixture', object: 'realtime.session' } });
      }
      while (pending.length >= 2) {
        const opcode = pending[0] & 15;
        const masked = (pending[1] & 128) !== 0;
        let length = pending[1] & 127;
        let offset = 2;
        if (length === 126) { if (pending.length < 4) return; length = pending.readUInt16BE(2); offset = 4; }
        if (length === 127) { socket.destroy(); return; }
        const maskBytes = masked ? 4 : 0;
        if (pending.length < offset + maskBytes + length) return;
        const mask = pending.subarray(offset, offset + maskBytes);
        const body = Buffer.from(pending.subarray(offset + maskBytes, offset + maskBytes + length));
        pending = pending.subarray(offset + maskBytes + length);
        if (masked) for (let i = 0; i < body.length; i++) body[i] ^= mask[i % 4];
        if (opcode === 8) { socket.end(); return; }
        if (opcode !== 1) continue;
        const event = JSON.parse(body.toString());
        events.push(event);
        if (event.type === 'session.update') send({ type: 'session.updated', session: { id: 'session-fixture' } });
        if (event.type === 'response.create') {
          if (mode === 'error') send({ type: 'error', error: { type: 'server_error', message: `failure ${key}` } });
          else if (mode === 'failed') send({ type: 'response.done', response: { status: 'failed' } });
          else if (mode !== 'hang') {
            send({ type: 'response.output_audio.delta', delta: pcm.toString('base64') });
            if (mode === 'success') send({ type: 'response.done', response: { status: 'completed' } });
            else socket.end();
          }
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  return {
    events, requests, pcm, key,
    preferences: { ttsEnabled: true, sttEnabled: false, ttsProvider: 'openai' as const,
      openAiApiKey: key, openAiBaseUrl: `http://127.0.0.1:${port}/v1`,
      openAiTtsModel: 'gpt-realtime-2.1-mini', openAiTtsVoice: 'alloy' },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    },
  };
}

describe('Realtime TTS public interface', () => {
  it('S1.1 sends text through a Realtime session and returns PCM audio as WAV', { timeout: 5000 }, async () => {
    const peer = await realtimePeer('success');
    try {
      const result = await synthesizeTts({ text: 'Hello fixture', preferences: peer.preferences });
      assert.match(peer.requests[0], /^GET \/v1\/realtime\?[^\s]*model=gpt-realtime-2\.1-mini\b/i);
      assert.match(peer.requests[0], new RegExp(`authorization: Bearer ${peer.key}`, 'i'));
      assert.ok(peer.events.some((event) => event.type === 'session.update'));
      assert.ok(peer.events.some((event) => JSON.stringify(event).includes('Hello fixture')));
      assert.ok(peer.events.some((event) => event.type === 'response.create'));
      assert.equal(result.mimeType, 'audio/wav');
      const wav = Buffer.from(result.audioBase64, 'base64');
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
      assert.equal(wav.readUInt32LE(24), 24000);
      assert.equal(wav.readUInt16LE(22), 1);
      assert.equal(wav.readUInt16LE(34), 16);
      assert.deepEqual(wav.subarray(44), peer.pcm);
    } finally { await peer.close(); }
  });

  for (const mode of ['error', 'incomplete', 'failed'] as const) {
    it(`S1.2 rejects a Realtime ${mode} session without exposing credentials`, { timeout: 5000 }, async () => {
      const peer = await realtimePeer(mode);
      try {
        await assert.rejects(synthesizeTts({ text: 'Hello fixture', preferences: peer.preferences }), (error: Error) => {
          assert.ok(error.message);
          assert.equal(error.message.includes(peer.key), false);
          return true;
        });
        assert.match(peer.requests[0], /^GET \/v1\/realtime\?/i);
        assert.ok(peer.events.some((event) => event.type === 'response.create'));
      } finally { await peer.close(); }
    });
  }

  for (const [rate, expected] of [[0.1, 0.25], [1.25, 1.25], [4, 1.5]] as const) {
    it(`S1.1 sends rate ${rate} as Realtime speed ${expected}`, async () => {
      const peer = await realtimePeer('success');
      try {
        await synthesizeTts({ text: 'Hello', preferences: { ...peer.preferences, ttsRate: rate } });
        assert.equal(peer.events.find((event) => event.type === 'session.update')?.session.audio.output.speed, expected);
      } finally { await peer.close(); }
    });
  }

  it('S1.2 rejects an already cancelled request without connecting', async () => {
    const peer = await realtimePeer('hang');
    const controller = new AbortController();
    controller.abort();
    try {
      await assert.rejects(synthesizeTts({ text: 'Hello', preferences: peer.preferences, signal: controller.signal }), /cancel/i);
      assert.deepEqual(peer.requests, []);
    } finally { await peer.close(); }
  });

  it('S1.2 cancels an in-flight session', { timeout: 5000 }, async () => {
    const peer = await realtimePeer('hang');
    const controller = new AbortController();
    try {
      const timer = setTimeout(() => controller.abort(), 100);
      try {
        await assert.rejects(synthesizeTts({ text: 'Hello fixture', preferences: peer.preferences, signal: controller.signal }), /cancel/i);
      } finally { clearTimeout(timer); }
      assert.ok(peer.events.some((event) => event.type === 'response.create'));
    } finally { await peer.close(); }
  });

  it('S2.1 offers a Realtime model and a selectable voice without a free-form voice identifier', () => {
    const html = renderToStaticMarkup(React.createElement(SpeechSettingsSection, {
      preferences: { ...DEFAULT_SPEECH_PREFERENCES, ttsProvider: 'openai' },
      onSpeechPreferencesChange: () => {},
    }));
    assert.match(html, /<option\s+value="gpt-realtime-2\.1-mini"/);
    assert.match(html, /<option\s+value="alloy"/);
    assert.doesNotMatch(html, /Identificador exacto de voz|o escribe id de voz/i);
    assert.doesNotMatch(html, /<option\s+value="tts-1(?:-hd)?"/);
  });

  it('S1.2 does not disclose credentials when an OpenAI synthesis request fails', async () => {
    const original = globalThis.fetch;
    const key = 'sk-realtime-test-secret';
    globalThis.fetch = (async () => new Response(JSON.stringify({ error: { message: `failed ${key}` } }), { status: 401 })) as typeof fetch;
    try {
      await assert.rejects(synthesizeTts({ text: 'hello', preferences: {
        ttsEnabled: true, sttEnabled: false, ttsProvider: 'openai', openAiApiKey: key,
        openAiBaseUrl: 'http://127.0.0.1:1/v1', openAiTtsModel: 'gpt-realtime-2.1-mini',
      } }), (error: Error) => {
        assert.ok(error.message);
        assert.equal(error.message.includes(key), false);
        return true;
      });
    } finally { globalThis.fetch = original; }
  });

  it('S3.1 preserves Wyoming synthesis and WAV playback', async () => {
    const pcm = Buffer.from([1, 2, 3, 4]);
    let received = '';
    const server = net.createServer((socket) => {
      socket.on('data', (data) => {
        received += data.toString();
        if (!received.includes('Hola')) return;
        const format = JSON.stringify({ rate: 22050, width: 2, channels: 1 });
        socket.end(Buffer.concat([
          Buffer.from(JSON.stringify({ type: 'audio-start', data_length: Buffer.byteLength(format) }) + '\n' + format),
          Buffer.from(JSON.stringify({ type: 'audio-chunk', payload_length: pcm.length }) + '\n'), pcm,
          Buffer.from(JSON.stringify({ type: 'audio-stop' }) + '\n'),
        ]));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const port = (server.address() as net.AddressInfo).port;
      const result = await synthesizeTts({ text: 'Hola', preferences: {
        ttsEnabled: true, sttEnabled: false, ttsProvider: 'wyoming',
        wyomingTtsUrl: `tcp://127.0.0.1:${port}`, wyomingTtsVoice: 'test-voice',
      } });
      const wav = Buffer.from(result.audioBase64, 'base64');
      assert.equal(result.mimeType, 'audio/wav');
      assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
      assert.deepEqual(wav.subarray(44), pcm);
      assert.match(received, /test-voice/);
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
