#!/usr/bin/env node
/**
 * Setup script to verify and download official speech models (Piper TTS & Sherpa-ONNX STT).
 *
 * Usage:
 *   node scripts/setup-speech-models.mjs [--force] [--verify-only] [--pack=<id>]
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

export const PIPER_VOICES_COMMIT = '5041a7a49ae5b3a0f30e6837769eb03fdbb231bd';
export const SHERPA_STT_COMMIT = 'fe61e648310e068a5558c3d4e4d02c25742820a4';

export const OFFICIAL_SPEECH_PACKS = {
  'es_MX-claude-high': {
    id: 'es_MX-claude-high',
    name: 'Español (México) - Claude High (Piper TTS)',
    kind: 'tts',
    totalSizeBytes: 63127272,
    files: [
      {
        filename: 'es_MX-claude-high.onnx',
        url: `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_COMMIT}/es/es_MX/claude/high/es_MX-claude-high.onnx`,
        sizeBytes: 63122309,
        expectedSha256: '3ef40a71ea63852cd8ab7e6fa7d2ecdcfa67a0b47c9c48e3f10e02ee02083ea0',
      },
      {
        filename: 'es_MX-claude-high.onnx.json',
        url: `https://huggingface.co/rhasspy/piper-voices/resolve/${PIPER_VOICES_COMMIT}/es/es_MX/claude/high/es_MX-claude-high.onnx.json`,
        sizeBytes: 4963,
        expectedSha256: '1afc81f703c0e4cb3b4d7c0dca096b8b54a98806807f0170cf5eb5557723c12d',
      },
    ],
  },
  'es-kroko-64l': {
    id: 'es-kroko-64l',
    name: 'Español - Kroko 64L INT8 (Sherpa-ONNX STT)',
    kind: 'stt',
    totalSizeBytes: 154136604,
    files: [
      {
        filename: 'encoder.int8.onnx',
        url: `https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/${SHERPA_STT_COMMIT}/es/kroko_64l/encoder.int8.onnx`,
        sizeBytes: 153185997,
        expectedSha256: 'e6bb47f5425983960cf70c33f460e4a277ca1ec7f3c59e3747974ad3f431f056',
      },
      {
        filename: 'decoder.int8.onnx',
        url: `https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/${SHERPA_STT_COMMIT}/es/kroko_64l/decoder.int8.onnx`,
        sizeBytes: 606495,
        expectedSha256: '624e8ae2886d5b1957e26ac77df54a00c3b55fdfe2153d7dbf2d687ca943e58b',
      },
      {
        filename: 'joiner.int8.onnx',
        url: `https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/${SHERPA_STT_COMMIT}/es/kroko_64l/joiner.int8.onnx`,
        sizeBytes: 337105,
        expectedSha256: 'f027a07c54ff3565419f95e9c43112196ae188450a796411784917740a9bf9d0',
      },
      {
        filename: 'tokens.txt',
        url: `https://huggingface.co/hudaiapa88/sherpa-stt-onnx/resolve/${SHERPA_STT_COMMIT}/es/kroko_64l/tokens.txt`,
        sizeBytes: 7037,
        expectedSha256: '783ab50c895a41884ced1a46cd57e7a5de27240500b9beacdf91bd94ed1b9d8b',
      },
    ],
  },
};

export function getSpeechModelsRootDir() {
  const home = os.homedir();
  return path.join(home, '.open-pi-viewer', 'models', 'speech');
}

export async function computeFileSha256(filePath) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) return reject(new Error(`Not found: ${filePath}`));
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (d) => hash.update(d));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', reject);
  });
}

export async function downloadFileWithRedirects(url, destPath, onProgress) {
  const tempPath = `${destPath}.tmp-${Date.now()}`;
  return new Promise((resolve, reject) => {
    function doRequest(currentUrl, redirectCount = 0) {
      if (redirectCount > 10) return reject(new Error(`Too many redirects: ${url}`));
      const reqUrl = new URL(currentUrl);
      const client = reqUrl.protocol === 'https:' ? https : http;

      const req = client.get(currentUrl, (res) => {
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const next = new URL(res.headers.location, currentUrl).toString();
          return doRequest(next, redirectCount + 1);
        }
        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          return reject(new Error(`HTTP ${res.statusCode}: ${currentUrl}`));
        }

        const total = res.headers['content-length'] ? parseInt(res.headers['content-length'], 10) : undefined;
        let downloaded = 0;
        const fileStream = fs.createWriteStream(tempPath);

        res.on('data', (c) => {
          downloaded += c.length;
          fileStream.write(c);
          if (onProgress) onProgress(downloaded, total);
        });

        res.on('end', () => {
          fileStream.end(() => {
            try {
              if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
              fs.renameSync(tempPath, destPath);
              resolve();
            } catch (e) {
              reject(e);
            }
          });
        });

        res.on('error', (err) => {
          try { fs.unlinkSync(tempPath); } catch {}
          reject(err);
        });
      });

      req.on('error', (err) => {
        try { fs.unlinkSync(tempPath); } catch {}
        reject(err);
      });
    }

    doRequest(url);
  });
}

export async function installSpeechPack(pack, options = {}) {
  const { force = false, verifyOnly = false, rootDir = getSpeechModelsRootDir() } = options;
  const packDir = path.join(rootDir, pack.id);
  fs.mkdirSync(packDir, { recursive: true });

  console.log(`\n📦 Verificando modelo: ${pack.name}`);
  console.log(`   Directorio: ${packDir}`);

  let allValid = true;

  for (const f of pack.files) {
    const fullPath = path.join(packDir, f.filename);
    let needsDownload = force || !fs.existsSync(fullPath);

    if (!needsDownload) {
      process.stdout.write(`   - Comprobando ${f.filename}... `);
      const sha = await computeFileSha256(fullPath);
      if (sha === f.expectedSha256.toLowerCase()) {
        console.log(`✓ OK (SHA-256 verificado)`);
      } else {
        console.log(`✗ Hash mismatch`);
        needsDownload = true;
      }
    }

    if (needsDownload) {
      if (verifyOnly) {
        console.log(`   ! Faltante o corrupto: ${f.filename}`);
        allValid = false;
        continue;
      }

      console.log(`   ⬇ Descargando ${f.filename} (${(f.sizeBytes / 1024 / 1024).toFixed(2)} MB)...`);
      await downloadFileWithRedirects(f.url, fullPath, (down, tot) => {
        if (tot) {
          const pct = Math.floor((down / tot) * 100);
          process.stdout.write(`\r     Progreso: ${pct}% (${(down / 1024 / 1024).toFixed(1)} / ${(tot / 1024 / 1024).toFixed(1)} MB)`);
        }
      });
      console.log('');

      process.stdout.write(`     Validando SHA-256... `);
      const downloadedSha = await computeFileSha256(fullPath);
      if (downloadedSha === f.expectedSha256.toLowerCase()) {
        console.log(`✓ OK`);
      } else {
        console.log(`✗ Error de integridad`);
        try { fs.unlinkSync(fullPath); } catch {}
        throw new Error(`Checksum mismatch para ${f.filename}`);
      }
    }
  }

  return allValid;
}

async function runCli() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const verifyOnly = args.includes('--verify-only');
  const packArg = args.find((a) => a.startsWith('--pack='));
  const targetPackId = packArg ? packArg.split('=')[1] : null;

  console.log('🎙 Open Pi Viewer - Setup de Modelos Locales de Voz (TTS & STT)');
  console.log(`Directorio base: ${getSpeechModelsRootDir()}`);

  const packsToProcess = targetPackId
    ? [OFFICIAL_SPEECH_PACKS[targetPackId]].filter(Boolean)
    : Object.values(OFFICIAL_SPEECH_PACKS);

  if (packsToProcess.length === 0) {
    console.error(`Pack desconocido: ${targetPackId}`);
    process.exit(1);
  }

  for (const pack of packsToProcess) {
    await installSpeechPack(pack, { force, verifyOnly });
  }

  console.log('\n✨ Todos los modelos base fueron procesados correctamente.\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([a-zA-Z]:)/, '$1'))) {
  runCli().catch((err) => {
    console.error('\n❌ Error en setup de modelos:', err.message);
    process.exit(1);
  });
}
