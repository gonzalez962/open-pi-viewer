import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  computeFileSha256,
  inspectCustomModel,
} from '@server/bridge/speech';

describe('Speech Bridge Model Manager and Checksums', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'speech-bridge-test-'));
  });

  afterEach(() => {
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
});
