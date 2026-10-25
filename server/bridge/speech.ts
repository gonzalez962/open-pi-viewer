import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { getHomeDir } from '../config';
import {
  OFFICIAL_SPEECH_PACKS,
  type OfficialSpeechPack,
  type ModelIntegrityStatus,
  type CustomModelConfig,
} from '../../src/core/types/speech';

export interface ModelFileStatus {
  filename: string;
  exists: boolean;
  sizeBytes?: number;
  expectedSizeBytes?: number;
  expectedSha256?: string;
  actualSha256?: string;
  status: ModelIntegrityStatus;
}

export interface PackStatusResult {
  packId: string;
  status: ModelIntegrityStatus;
  packDir: string;
  files: ModelFileStatus[];
  totalExpectedBytes: number;
  totalActualBytes: number;
}

let speechModelsDirOverride: string | null = null;

export function setSpeechModelsDirForTest(dir: string | null): void {
  speechModelsDirOverride = dir;
}

/**
 * Resolves the base directory where local speech models are stored.
 * Defaults to ~/.open-pi-viewer/models/speech.
 */
export function getSpeechModelsRootDir(): string {
  if (speechModelsDirOverride) {
    return speechModelsDirOverride;
  }
  const home = getHomeDir();
  return path.join(home, '.open-pi-viewer', 'models', 'speech');
}

/**
 * Resolves directory for a specific speech pack.
 */
export function getPackDir(packId: string): string {
  return path.join(getSpeechModelsRootDir(), packId);
}

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
 * Inspects the status and file integrity of an official pack.
 */
export async function inspectOfficialPack(pack: OfficialSpeechPack): Promise<PackStatusResult> {
  const packDir = getPackDir(pack.id);
  const fileStatuses: ModelFileStatus[] = [];
  let allVerified = true;
  let anyMissing = false;
  let anyMismatch = false;
  let totalActualBytes = 0;

  for (const f of pack.files) {
    const fullPath = path.join(packDir, f.filename);
    if (!fs.existsSync(fullPath)) {
      anyMissing = true;
      allVerified = false;
      fileStatuses.push({
        filename: f.filename,
        exists: false,
        expectedSizeBytes: f.sizeBytes,
        expectedSha256: f.expectedSha256,
        status: 'missing',
      });
      continue;
    }

    try {
      const stat = fs.statSync(fullPath);
      totalActualBytes += stat.size;
      const sha256 = await computeFileSha256(fullPath);
      const matches = sha256.toLowerCase() === f.expectedSha256.toLowerCase();

      if (matches) {
        fileStatuses.push({
          filename: f.filename,
          exists: true,
          sizeBytes: stat.size,
          expectedSizeBytes: f.sizeBytes,
          expectedSha256: f.expectedSha256,
          actualSha256: sha256,
          status: 'verified',
        });
      } else {
        anyMismatch = true;
        allVerified = false;
        fileStatuses.push({
          filename: f.filename,
          exists: true,
          sizeBytes: stat.size,
          expectedSizeBytes: f.sizeBytes,
          expectedSha256: f.expectedSha256,
          actualSha256: sha256,
          status: 'mismatch',
        });
      }
    } catch {
      anyMismatch = true;
      allVerified = false;
      fileStatuses.push({
        filename: f.filename,
        exists: true,
        expectedSizeBytes: f.sizeBytes,
        expectedSha256: f.expectedSha256,
        status: 'mismatch',
      });
    }
  }

  let overallStatus: ModelIntegrityStatus = 'missing';
  if (allVerified && !anyMissing && !anyMismatch) {
    overallStatus = 'verified';
  } else if (anyMismatch) {
    overallStatus = 'mismatch';
  } else {
    overallStatus = 'missing';
  }

  return {
    packId: pack.id,
    status: overallStatus,
    packDir,
    files: fileStatuses,
    totalExpectedBytes: pack.totalSizeBytes,
    totalActualBytes,
  };
}

/**
 * Downloads a file from a URL to a local destination, with optional HTTP follow-redirects.
 */
export async function downloadFileWithRedirects(
  url: string,
  destPath: string,
  onProgress?: (downloadedBytes: number, totalBytes?: number) => void
): Promise<void> {
  const parsed = new URL(url);
  const client = parsed.protocol === 'https:' ? https : http;

  return new Promise((resolve, reject) => {
    const tempPath = `${destPath}.tmp-${Date.now()}`;
    const fileStream = fs.createWriteStream(tempPath);

    function doRequest(currentUrl: string, redirectCount = 0) {
      if (redirectCount > 10) {
        fileStream.close();
        try { fs.unlinkSync(tempPath); } catch {}
        return reject(new Error(`Too many redirects while downloading ${url}`));
      }

      const reqUrl = new URL(currentUrl);
      const reqClient = reqUrl.protocol === 'https:' ? https : http;

      const req = reqClient.get(currentUrl, (res) => {
        // Handle HTTP 3xx redirect
        if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          return doRequest(nextUrl, redirectCount + 1);
        }

        if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
          fileStream.close();
          try { fs.unlinkSync(tempPath); } catch {}
          return reject(new Error(`Download failed with HTTP ${res.statusCode}: ${currentUrl}`));
        }

        const totalBytes = res.headers['content-length']
          ? parseInt(res.headers['content-length'], 10)
          : undefined;

        let downloadedBytes = 0;
        res.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          fileStream.write(chunk);
          if (onProgress) {
            onProgress(downloadedBytes, totalBytes);
          }
        });

        res.on('end', () => {
          fileStream.end(() => {
            try {
              // Move atomic tmp to dest
              if (fs.existsSync(destPath)) {
                fs.unlinkSync(destPath);
              }
              fs.renameSync(tempPath, destPath);
              resolve();
            } catch (err) {
              reject(err);
            }
          });
        });

        res.on('error', (err) => {
          fileStream.close();
          try { fs.unlinkSync(tempPath); } catch {}
          reject(err);
        });
      });

      req.on('error', (err) => {
        fileStream.close();
        try { fs.unlinkSync(tempPath); } catch {}
        reject(err);
      });
    }

    doRequest(url);
  });
}

/**
 * Downloads and verifies an official speech pack.
 * Verifies SHA-256 for each downloaded file immediately upon download.
 */
export async function downloadOfficialPack(
  packId: string,
  onProgress?: (progress: {
    packId: string;
    fileIndex: number;
    totalFiles: number;
    currentFile: string;
    fileDownloadedBytes: number;
    fileTotalBytes?: number;
  }) => void
): Promise<PackStatusResult> {
  const pack = OFFICIAL_SPEECH_PACKS[packId];
  if (!pack) {
    throw new Error(`Unknown speech pack: ${packId}`);
  }

  const packDir = getPackDir(packId);
  fs.mkdirSync(packDir, { recursive: true });

  for (let i = 0; i < pack.files.length; i++) {
    const f = pack.files[i];
    const dest = path.join(packDir, f.filename);

    // If file already exists with matching SHA-256, skip re-downloading
    if (fs.existsSync(dest)) {
      const existingSha = await computeFileSha256(dest);
      if (existingSha.toLowerCase() === f.expectedSha256.toLowerCase()) {
        continue;
      }
    }

    await downloadFileWithRedirects(f.url, dest, (downloaded, total) => {
      if (onProgress) {
        onProgress({
          packId,
          fileIndex: i,
          totalFiles: pack.files.length,
          currentFile: f.filename,
          fileDownloadedBytes: downloaded,
          fileTotalBytes: total ?? f.sizeBytes,
        });
      }
    });

    // Verify SHA-256 immediately after download
    const downloadedSha = await computeFileSha256(dest);
    if (downloadedSha.toLowerCase() !== f.expectedSha256.toLowerCase()) {
      try { fs.unlinkSync(dest); } catch {}
      throw new Error(
        `SHA-256 checksum mismatch for ${f.filename}: expected ${f.expectedSha256}, got ${downloadedSha}`
      );
    }
  }

  return inspectOfficialPack(pack);
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
