import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  OFFICIAL_SPEECH_PACKS,
  installSpeechPack,
  computeFileSha256,
} from '../../scripts/setup-speech-models.mjs';

describe('CLI setup-speech-models script', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'setup-script-test-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('verifyOnly detects missing files without creating or downloading', async () => {
    const pack = OFFICIAL_SPEECH_PACKS['es_MX-claude-high'];
    const valid = await installSpeechPack(pack, {
      verifyOnly: true,
      rootDir: tempDir,
    });
    assert.equal(valid, false);
  });

  it('verifies existing mock pack files matching expected sha256', async () => {
    const fakePack = {
      id: 'test-pack',
      name: 'Test Pack',
      kind: 'tts',
      totalSizeBytes: 10,
      files: [
        {
          filename: 'model.onnx',
          url: 'http://example.com/fake',
          sizeBytes: 10,
          expectedSha256: '',
        },
      ],
    };

    const packDir = path.join(tempDir, fakePack.id);
    fs.mkdirSync(packDir, { recursive: true });
    const content = '0123456789';
    const filePath = path.join(packDir, 'model.onnx');
    fs.writeFileSync(filePath, content);

    const hash = await computeFileSha256(filePath);
    fakePack.files[0].expectedSha256 = hash;

    const valid = await installSpeechPack(fakePack, {
      verifyOnly: true,
      rootDir: tempDir,
    });
    assert.equal(valid, true);
  });
});
