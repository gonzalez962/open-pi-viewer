import net from 'node:net';

export interface WyomingEndpoint {
  host: string;
  port: number;
}

export function parseWyomingUrl(urlStr?: string, defaultPort = 10200): WyomingEndpoint {
  if (!urlStr || typeof urlStr !== 'string') {
    return { host: '127.0.0.1', port: defaultPort };
  }
  const clean = urlStr.replace(/^tcp:\/\//i, '').trim();
  const [host, portStr] = clean.split(':');
  const port = parseInt(portStr || String(defaultPort), 10);
  return {
    host: host || '127.0.0.1',
    port: Number.isFinite(port) && port > 0 ? port : defaultPort,
  };
}

export interface WyomingInfo {
  installed: boolean;
  name?: string;
  description?: string;
  version?: string;
  voices?: Array<{ name: string; description?: string; languages?: string[] }>;
  models?: Array<{ name: string; description?: string; languages?: string[] }>;
}

/**
 * Checks connection and requests `describe` event from a Wyoming service.
 */
export async function checkWyomingHealth(
  endpointUrl: string,
  timeoutMs = 3000
): Promise<{ ok: boolean; info?: WyomingInfo; error?: string }> {
  return new Promise((resolve) => {
    const { host, port } = parseWyomingUrl(endpointUrl);
    const socket = new net.Socket();
    let resolved = false;

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve({ ok: false, error: 'Connection timed out' });
      }
    }, timeoutMs);

    socket.connect(port, host, () => {
      const describeEvent = JSON.stringify({ type: 'describe', data: {} }) + '\n';
      socket.write(describeEvent);
    });

    let incomingBuffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      incomingBuffer = Buffer.concat([incomingBuffer, Buffer.from(chunk)]);
      const newlineIdx = incomingBuffer.indexOf(0x0a);
      if (newlineIdx !== -1) {
        try {
          const header = JSON.parse(incomingBuffer.subarray(0, newlineIdx).toString('utf8'));
          const dataLength = header.data_length || 0;
          if (incomingBuffer.length >= newlineIdx + 1 + dataLength) {
            const dataBuf = incomingBuffer.subarray(newlineIdx + 1, newlineIdx + 1 + dataLength);
            let info: WyomingInfo = { installed: true };
            if (dataLength > 0) {
              const data = JSON.parse(dataBuf.toString('utf8'));
              if (data.tts && data.tts.length > 0) {
                const tts = data.tts[0];
                info = {
                  installed: true,
                  name: tts.name,
                  description: tts.description,
                  version: tts.version,
                  voices: tts.voices,
                };
              } else if (data.asr && data.asr.length > 0) {
                const asr = data.asr[0];
                info = {
                  installed: true,
                  name: asr.name,
                  description: asr.description,
                  version: asr.version,
                  models: asr.models,
                };
              }
            }
            if (!resolved) {
              resolved = true;
              clearTimeout(timer);
              socket.end();
              resolve({ ok: true, info });
            }
          }
        } catch (parseErr: any) {
          if (!resolved) {
            resolved = true;
            clearTimeout(timer);
            socket.destroy();
            resolve({ ok: true, info: { installed: true } });
          }
        }
      }
    });

    socket.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        clearTimeout(timer);
        resolve({ ok: false, error: err.message });
      }
    });
  });
}

/**
 * Builds a valid WAV container buffer from raw 16-bit mono PCM samples.
 */
export function pcmToWav(pcmData: Buffer, sampleRate: number, numChannels = 1, bitsPerSample = 16): Buffer {
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  // RIFF chunk descriptor
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcmData.length, 4);
  header.write('WAVE', 8);

  // "fmt " sub-chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
  header.writeUInt16LE(1, 20); // AudioFormat (1 = PCM)
  header.writeUInt16LE(numChannels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);

  // "data" sub-chunk
  header.write('data', 36);
  header.writeUInt32LE(pcmData.length, 40);

  return Buffer.concat([header, pcmData]);
}

/**
 * Synthesizes text to speech using a Wyoming Piper TCP service.
 */
export async function synthesizeWyomingTts(
  text: string,
  endpointUrl = 'tcp://127.0.0.1:10200',
  _rate = 1.0,
  voice?: string
): Promise<{ wavBuffer: Buffer; durationSeconds?: number }> {
  return new Promise((resolve, reject) => {
    const { host, port } = parseWyomingUrl(endpointUrl, 10200);
    const socket = new net.Socket();

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Wyoming TTS request to ${host}:${port} timed out.`));
    }, 15000);

    socket.connect(port, host, () => {
      const payloadObj: Record<string, any> = { text };
      if (voice) {
        payloadObj.voice = { name: voice };
      }
      const payload = JSON.stringify(payloadObj);
      const payloadBytes = Buffer.byteLength(payload, 'utf8');
      const header = JSON.stringify({
        type: 'synthesize',
        version: '1.10.2',
        data_length: payloadBytes,
      }) + '\n';
      socket.write(header);
      socket.write(payload);
    });

    const audioChunks: Buffer[] = [];
    let audioRate = 22050;
    let audioWidth = 2;
    let audioChannels = 1;
    let incomingBuffer = Buffer.alloc(0);

    socket.on('data', (chunk) => {
      incomingBuffer = Buffer.concat([incomingBuffer, Buffer.from(chunk)]);

      while (incomingBuffer.length > 0) {
        const newlineIdx = incomingBuffer.indexOf(0x0a);
        if (newlineIdx === -1) break;

        let header: any;
        try {
          header = JSON.parse(incomingBuffer.subarray(0, newlineIdx).toString('utf8'));
        } catch {
          break;
        }

        const dataLength = header.data_length || 0;
        const payloadLength = header.payload_length || 0;
        const total = newlineIdx + 1 + dataLength + payloadLength;
        if (incomingBuffer.length < total) break;

        const dataStart = newlineIdx + 1;
        const dataBuf = incomingBuffer.subarray(dataStart, dataStart + dataLength);
        const payloadBuf = payloadLength ? incomingBuffer.subarray(dataStart + dataLength, total) : null;
        incomingBuffer = incomingBuffer.subarray(total);

        if (header.type === 'audio-start') {
          try {
            const data = JSON.parse(dataBuf.toString('utf8'));
            if (data.rate) audioRate = data.rate;
            if (data.width) audioWidth = data.width;
            if (data.channels) audioChannels = data.channels;
          } catch {}
        } else if (header.type === 'audio-chunk') {
          if (payloadBuf && payloadBuf.length > 0) {
            audioChunks.push(payloadBuf);
          }
        } else if (header.type === 'audio-stop') {
          socket.end();
        }
      }
    });

    socket.on('end', () => {
      clearTimeout(timer);
      const pcmData = Buffer.concat(audioChunks);
      if (pcmData.length === 0) {
        return reject(new Error('Wyoming TTS produced no audio samples.'));
      }
      const bitsPerSample = audioWidth * 8;
      const wavBuffer = pcmToWav(pcmData, audioRate, audioChannels, bitsPerSample);
      const durationSeconds = pcmData.length / (audioRate * audioChannels * audioWidth);
      resolve({ wavBuffer, durationSeconds });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Wyoming TTS connection error: ${err.message}`));
    });
  });
}

/**
 * Transcribes audio PCM or WAV using a Wyoming Whisper TCP service.
 */
export async function transcribeWyomingStt(
  audioBuffer: Buffer,
  sampleRate = 16000,
  endpointUrl = 'tcp://127.0.0.1:10300',
  language = 'es'
): Promise<string> {
  // If input is WAV, skip the 44-byte WAV header if present
  let pcmData = audioBuffer;
  let detectedRate = sampleRate;

  if (
    audioBuffer.length >= 44 &&
    audioBuffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    audioBuffer.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    detectedRate = audioBuffer.readUInt32LE(24);
    pcmData = audioBuffer.subarray(44);
  }

  return new Promise((resolve, reject) => {
    const { host, port } = parseWyomingUrl(endpointUrl, 10300);
    const socket = new net.Socket();

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Wyoming STT request to ${host}:${port} timed out.`));
    }, 25000);

    socket.connect(port, host, () => {
      // 1. Transcribe event
      const transPayload = JSON.stringify({ language });
      socket.write(
        JSON.stringify({ type: 'transcribe', data_length: Buffer.byteLength(transPayload) }) +
          '\n' +
          transPayload
      );

      // 2. Audio-start
      const startPayload = JSON.stringify({ rate: detectedRate, width: 2, channels: 1 });
      socket.write(
        JSON.stringify({ type: 'audio-start', data_length: Buffer.byteLength(startPayload) }) +
          '\n' +
          startPayload
      );

      // 3. Audio chunks (stream in slices of 4096 bytes)
      const chunkSize = 4096;
      for (let offset = 0; offset < pcmData.length; offset += chunkSize) {
        const slice = pcmData.subarray(offset, Math.min(offset + chunkSize, pcmData.length));
        const chunkInfo = JSON.stringify({ rate: detectedRate, width: 2, channels: 1 });
        socket.write(
          JSON.stringify({
            type: 'audio-chunk',
            data_length: Buffer.byteLength(chunkInfo),
            payload_length: slice.length,
          }) +
            '\n' +
            chunkInfo
        );
        socket.write(slice);
      }

      // 4. Audio-stop
      socket.write(JSON.stringify({ type: 'audio-stop', data_length: 0 }) + '\n');
    });

    let incomingBuffer = Buffer.alloc(0);
    let transcript = '';

    socket.on('data', (chunk) => {
      incomingBuffer = Buffer.concat([incomingBuffer, Buffer.from(chunk)]);

      while (incomingBuffer.length > 0) {
        const newlineIdx = incomingBuffer.indexOf(0x0a);
        if (newlineIdx === -1) break;

        let header: any;
        try {
          header = JSON.parse(incomingBuffer.subarray(0, newlineIdx).toString('utf8'));
        } catch {
          break;
        }

        const total = newlineIdx + 1 + (header.data_length || 0) + (header.payload_length || 0);
        if (incomingBuffer.length < total) break;

        const dataBuf = incomingBuffer.subarray(newlineIdx + 1, newlineIdx + 1 + (header.data_length || 0));
        incomingBuffer = incomingBuffer.subarray(total);

        if (header.type === 'transcript') {
          try {
            const data = JSON.parse(dataBuf.toString('utf8'));
            transcript = data.text || '';
          } catch {}
          socket.end();
        }
      }
    });

    socket.on('end', () => {
      clearTimeout(timer);
      resolve(transcript.trim());
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Wyoming STT connection error: ${err.message}`));
    });
  });
}
