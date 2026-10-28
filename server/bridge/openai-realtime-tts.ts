import WebSocket from 'ws';
import { pcmToWav } from './wyoming-client';

const MAX_AUDIO_BYTES = 24_000 * 2 * 300;

export async function synthesizeRealtimeTts(options: {
  text: string; apiKey: string; baseUrl: string; model: string; voice: string;
  speed?: number; signal?: AbortSignal;
}): Promise<Buffer> {
  let url: URL;
  try {
    url = new URL(options.baseUrl);
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    if ((url.protocol === 'http:' || url.protocol === 'ws:') && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error();
    url.protocol = url.protocol === 'https:' || url.protocol === 'wss:' ? 'wss:' : 'ws:';
    url.pathname = url.pathname.replace(/\/+$/, '');
    if (!/\/v\d+$/i.test(url.pathname)) url.pathname += '/v1';
    url.pathname += '/realtime';
    url.searchParams.set('model', options.model);
  } catch { throw new Error('Invalid OpenAI Realtime endpoint.'); }

  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new Error('OpenAI Realtime TTS cancelled.')); return; }
    let socket: WebSocket;
    try { socket = new WebSocket(url, { headers: { Authorization: `Bearer ${options.apiKey}` }, maxPayload: MAX_AUDIO_BYTES, handshakeTimeout: 15000 }); }
    catch { reject(new Error('OpenAI Realtime TTS connection failed.')); return; }
    let settled = false;
    let started = false;
    let bytes = 0;
    const chunks: Buffer[] = [];
    const finish = (error?: string, result?: Buffer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', abort);
      socket.terminate();
      if (error) reject(new Error(error));
      else resolve(result!);
    };
    const abort = () => finish('OpenAI Realtime TTS cancelled.');
    const timer = setTimeout(() => finish('OpenAI Realtime TTS timed out.'), 60000);
    options.signal?.addEventListener('abort', abort, { once: true });
    socket.on('error', () => finish('OpenAI Realtime TTS connection failed.'));
    socket.on('close', () => finish('OpenAI Realtime TTS session ended before completion.'));
    socket.on('open', () => socket.send(JSON.stringify({ type: 'session.update', session: {
      type: 'realtime', output_modalities: ['audio'], audio: { output: { format: { type: 'audio/pcm', rate: 24000 }, voice: options.voice,
        speed: Number.isFinite(options.speed) ? Math.max(0.25, Math.min(1.5, options.speed!)) : 1.0 } },
      instructions: 'Read the user-provided text aloud exactly as written. Do not add or change words.',
    } })));
    socket.on('message', (data, binary) => {
      try {
        if (binary) throw new Error();
        const event = JSON.parse(data.toString());
        if (event.type === 'error') { finish('OpenAI Realtime TTS session failed.'); return; }
        if (event.type === 'session.updated' && !started) {
          started = true;
          socket.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: options.text }] } }));
          socket.send(JSON.stringify({ type: 'response.create', response: { output_modalities: ['audio'] } }));
        } else if (event.type === 'response.output_audio.delta') {
          if (!started || typeof event.delta !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(event.delta)) throw new Error();
          const chunk = Buffer.from(event.delta, 'base64');
          bytes += chunk.length;
          if (bytes > MAX_AUDIO_BYTES) throw new Error();
          chunks.push(chunk);
        } else if (event.type === 'response.done') {
          if (!started || event.response?.status !== 'completed' || !bytes || bytes % 2) { finish('OpenAI Realtime TTS response failed or was incomplete.'); return; }
          finish(undefined, pcmToWav(Buffer.concat(chunks), 24000));
        }
      } catch { finish('OpenAI Realtime TTS received an invalid response.'); }
    });
  });
}
