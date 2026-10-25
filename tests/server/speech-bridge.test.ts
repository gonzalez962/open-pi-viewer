import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  setSpeechModelsDirForTest,
  getSpeechModelsRootDir,
  getPackDir,
  computeFileSha256,
  inspectOfficialPack,
  inspectCustomModel,
  deleteOfficialPack,
} from '../../server/bridge/speech';
import { OFFICIAL_SPEECH_PACKS } from '../../src/core/types/speech';

describe('Speech Bridge Model Manager and Checksums', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-bridge-test-'));
    setSpeechModelsDirForTest(tempDir);
  });

  afterEach(() => {
    setSpeechModelsDirForTest(null);
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it('computes exact sha256 checksum for a file', async () => {
    const testFile = path.join(tempDir, 'test.txt');
    const content = 'Open Pi Viewer Speech Test';
    fs.writeFileSync(testFile, content, 'utf8');

    const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
    const actualHash = await computeFileSha256(testFile);

    assert.equal(actualHash, expectedHash);
  });

  it('inspectOfficialPack reports missing when files do not exist', async () => {
    const pack = OFFICIAL_SPEECH_PACKS['es_MX-claude-high'];
    const res = await inspectOfficialPack(pack);

    assert.equal(res.status, 'missing');
    assert.equal(res.packId, 'es_MX-claude-high');
    assert.equal(res.files.every((f) => f.status === 'missing'), true);
  });

  it('inspectOfficialPack detects verified files vs mismatch files', async () => {
    const pack = OFFICIAL_SPEECH_PACKS['es_MX-claude-high'];
    const packDir = getPackDir(pack.id);
    fs.mkdirSync(packDir, { recursive: true });

    // File 1: wrong content -> mismatch
    const f1 = pack.files[0];
    fs.writeFileSync(path.join(packDir, f1.filename), 'corrupted-onnx-bytes');

    // File 2: missing
    const res = await inspectOfficialPack(pack);
    assert.equal(res.status, 'mismatch');
    assert.equal(res.files[0].status, 'mismatch');
    assert.equal(res.files[1].status, 'missing');
  });

  it('inspectCustomModel rejects missing files or non-onnx files', async () => {
    const missingRes = await inspectCustomModel({
      isCustom: true,
      modelPath: path.join(tempDir, 'nonexistent.onnx'),
    });
    assert.equal(missingRes.valid, false);
    assert.match(missingRes.error ?? '', /does not exist/);

    const txtFile = path.join(tempDir, 'model.txt');
    fs.writeFileSync(txtFile, 'not an onnx');
    const nonOnnxRes = await inspectCustomModel({
      isCustom: true,
      modelPath: txtFile,
    });
    assert.equal(nonOnnxRes.valid, false);
    assert.match(nonOnnxRes.error ?? '', /\.onnx extension/);
  });

  it('inspectCustomModel computes sha256 and validates genuine onnx file', async () => {
    const dummyOnnx = path.join(tempDir, 'custom-voice.onnx');
    const content = Buffer.from('FAKE-ONNX-MODEL-HEADER');
    fs.writeFileSync(dummyOnnx, content);

    const expectedHash = crypto.createHash('sha256').update(content).digest('hex');
    const res = await inspectCustomModel({
      isCustom: true,
      modelPath: dummyOnnx,
    });

    assert.equal(res.valid, true);
    assert.equal(res.computedSha256, expectedHash);
    assert.equal(res.sizeBytes, content.length);
  });

  it('deleteOfficialPack removes pack directory and files', async () => {
    const pack = OFFICIAL_SPEECH_PACKS['es_MX-claude-high'];
    const packDir = getPackDir(pack.id);
    fs.mkdirSync(packDir, { recursive: true });
    fs.writeFileSync(path.join(packDir, 'test.onnx'), 'data');

    assert.equal(fs.existsSync(packDir), true);
    const delRes = await deleteOfficialPack(pack.id);
    assert.equal(delRes.success, true);
    assert.equal(fs.existsSync(packDir), false);
  });
});
