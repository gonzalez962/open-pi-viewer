import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { CustomModelConfig } from '../../src/core/types/speech';

/**
 * Computes SHA-256 hash of a local file in streaming mode.
 */
export async function computeFileSha256(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(filePath)) {
      return reject(new Error(`File not found: ${filePath}`));
    }
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex').toLowerCase()));
    stream.on('error', (err) => reject(err));
  });
}

/**
 * Validates a custom model file on disk and computes its SHA-256 digest.
 */
export async function inspectCustomModel(config: CustomModelConfig): Promise<{
  valid: boolean;
  error?: string;
  computedSha256?: string;
  sizeBytes?: number;
}> {
  if (!config.modelPath || !config.modelPath.trim()) {
    return { valid: false, error: 'Model path is required' };
  }

  const fullPath = path.resolve(config.modelPath.trim());
  if (!fs.existsSync(fullPath)) {
    return { valid: false, error: `Model file does not exist: ${fullPath}` };
  }

  if (!fullPath.toLowerCase().endsWith('.onnx')) {
    return { valid: false, error: 'Model file must have a .onnx extension' };
  }

  try {
    const stat = fs.statSync(fullPath);
    const computedSha256 = await computeFileSha256(fullPath);
    return {
      valid: true,
      computedSha256,
      sizeBytes: stat.size,
    };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
