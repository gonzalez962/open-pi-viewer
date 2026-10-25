import React, { useState } from 'react';
import type { OfficialSpeechPack, ModelIntegrityStatus } from '@core/types/speech';

export interface SpeechModelCardProps {
  pack: OfficialSpeechPack;
  statusResult?: {
    status: ModelIntegrityStatus;
    files: Array<{
      filename: string;
      exists: boolean;
      status: ModelIntegrityStatus;
      actualSha256?: string;
      expectedSha256?: string;
    }>;
  };
  downloadProgress?: {
    fileIndex: number;
    totalFiles: number;
    currentFile: string;
    fileDownloadedBytes: number;
    fileTotalBytes?: number;
  };
  isSelected: boolean;
  onSelect: () => void;
  onDownload: () => Promise<void>;
  onDelete: () => Promise<void>;
  isDownloading: boolean;
  isDeleting: boolean;
  isChecking?: boolean;
}

export const SpeechModelCard: React.FC<SpeechModelCardProps> = ({
  pack,
  statusResult,
  downloadProgress,
  isSelected,
  onSelect,
  onDownload,
  onDelete,
  isDownloading,
  isDeleting,
  isChecking = false,
}) => {
  const [showFiles, setShowFiles] = useState(false);
  const status = statusResult?.status || 'missing';

  const isVerified = status === 'verified';
  const isMismatch = status === 'mismatch';
  const isMissing = status === 'missing';

  const sizeMb = (pack.totalSizeBytes / 1024 / 1024).toFixed(1);

  return (
    <div
      className={`speech-model-card ${isSelected ? 'is-selected' : ''}`}
      style={{
        border: isSelected
          ? '2px solid var(--accent-color, #3b82f6)'
          : '1px solid var(--border-color, #374151)',
        borderRadius: '8px',
        padding: '16px',
        backgroundColor: 'var(--card-bg, rgba(255, 255, 255, 0.03))',
        display: 'flex',
        flexDirection: 'column',
        gap: '12px',
        boxShadow: isSelected ? '0 0 0 1px var(--accent-color, #3b82f6)' : 'none',
      }}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h4 style={{ margin: 0, fontSize: '0.98rem', fontWeight: 600 }}>{pack.name}</h4>
            <span
              style={{
                fontSize: '0.72rem',
                padding: '2px 6px',
                borderRadius: '4px',
                textTransform: 'uppercase',
                fontWeight: 'bold',
                backgroundColor: pack.kind === 'tts' ? '#0284c7' : '#7c3aed',
                color: '#fff',
              }}
            >
              {pack.kind.toUpperCase()}
            </span>
          </div>
          <span style={{ fontSize: '0.8rem', opacity: 0.7, marginTop: '2px', display: 'inline-block' }}>
            {pack.engine === 'piper' ? 'Piper ONNX Voice' : 'Sherpa-ONNX Zipformer'} • {sizeMb} MB
          </span>
        </div>

        {/* Status Badge placed cleanly underneath */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          {isChecking ? (
            <span style={{ fontSize: '0.78rem', opacity: 0.8, color: '#f59e0b' }}>⏳ Verificando...</span>
          ) : isVerified ? (
            <span
              style={{
                fontSize: '0.78rem',
                padding: '3px 8px',
                borderRadius: '999px',
                backgroundColor: 'rgba(34, 197, 94, 0.15)',
                color: '#22c55e',
                fontWeight: 600,
                border: '1px solid rgba(34, 197, 94, 0.3)',
              }}
            >
              ✓ Instalado y verificado
            </span>
          ) : isMismatch ? (
            <span
              style={{
                fontSize: '0.78rem',
                padding: '3px 8px',
                borderRadius: '999px',
                backgroundColor: 'rgba(239, 68, 68, 0.15)',
                color: '#ef4444',
                fontWeight: 600,
                border: '1px solid rgba(239, 68, 68, 0.3)',
              }}
            >
              ✗ Integridad corrupta
            </span>
          ) : (
            <span
              style={{
                fontSize: '0.78rem',
                padding: '3px 8px',
                borderRadius: '999px',
                backgroundColor: 'rgba(156, 163, 175, 0.15)',
                color: '#9ca3af',
                border: '1px solid rgba(156, 163, 175, 0.3)',
              }}
            >
              No instalado
            </span>
          )}
        </div>
      </div>

      {/* Checksum details toggle */}
      <div>
        <button
          type="button"
          onClick={() => setShowFiles(!showFiles)}
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted, #9ca3af)',
            fontSize: '0.78rem',
            cursor: 'pointer',
            padding: 0,
            textDecoration: 'underline',
          }}
        >
          {showFiles ? '▲ Ocultar archivos y hashes SHA-256' : '▼ Ver archivos y hashes SHA-256'}
        </button>

        {showFiles && (
          <div
            style={{
              marginTop: '8px',
              padding: '8px 10px',
              background: 'rgba(0,0,0,0.2)',
              borderRadius: '6px',
              fontSize: '0.75rem',
              display: 'flex',
              flexDirection: 'column',
              gap: '4px',
            }}
          >
            {pack.files.map((f) => {
              const fileStat = statusResult?.files?.find((x) => x.filename === f.filename);
              const fileOk = fileStat?.status === 'verified';
              return (
                <div key={f.filename} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace' }}>
                  <span>{f.filename}</span>
                  <span style={{ color: fileOk ? '#22c55e' : '#9ca3af' }}>
                    {fileOk ? '✓ SHA OK' : 'Faltante'} ({f.expectedSha256.slice(0, 10)}...)
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Action Buttons Row */}
      {isDownloading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', marginTop: '4px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.75rem', opacity: 0.85 }}>
            <span>
              {downloadProgress?.currentFile
                ? `Descargando: ${downloadProgress.currentFile} (${downloadProgress.fileIndex + 1}/${downloadProgress.totalFiles})`
                : 'Iniciando descarga...'}
            </span>
            <span>
              {downloadProgress?.fileTotalBytes
                ? `${Math.floor((downloadProgress.fileDownloadedBytes / downloadProgress.fileTotalBytes) * 100)}%`
                : ''}
            </span>
          </div>
          <div
            style={{
              width: '100%',
              height: '6px',
              backgroundColor: 'rgba(255, 255, 255, 0.1)',
              borderRadius: '3px',
              overflow: 'hidden',
            }}
          >
            <div
              style={{
                width: downloadProgress?.fileTotalBytes
                  ? `${Math.min(100, (downloadProgress.fileDownloadedBytes / downloadProgress.fileTotalBytes) * 100)}%`
                  : '30%',
                height: '100%',
                backgroundColor: 'var(--accent-color, #3b82f6)',
                borderRadius: '3px',
                transition: 'width 0.2s ease',
              }}
            />
          </div>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '4px' }}>
        <div style={{ display: 'flex', gap: '8px' }}>
          {isMissing || isMismatch ? (
            <button
              type="button"
              disabled={isDownloading || isDeleting}
              onClick={onDownload}
              style={{
                backgroundColor: 'var(--accent-color, #3b82f6)',
                color: '#fff',
                border: 'none',
                padding: '6px 14px',
                borderRadius: '4px',
                fontSize: '0.82rem',
                fontWeight: 600,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
              }}
            >
              {isDownloading ? '⏳ Descargando...' : '⬇ Instalar modelo base'}
            </button>
          ) : (
            <button
              type="button"
              disabled={isDeleting || isDownloading}
              onClick={onDelete}
              style={{
                backgroundColor: 'transparent',
                border: '1px solid rgba(239, 68, 68, 0.4)',
                color: '#ef4444',
                padding: '5px 10px',
                borderRadius: '4px',
                fontSize: '0.8rem',
                cursor: 'pointer',
              }}
            >
              {isDeleting ? 'Eliminando...' : '🗑 Desinstalar'}
            </button>
          )}
        </div>

        {/* Selection radio/button */}
        <div style={{ display: 'flex', alignItems: 'center' }}>
          <button
            type="button"
            onClick={onSelect}
            style={{
              padding: '5px 12px',
              borderRadius: '999px',
              fontSize: '0.8rem',
              fontWeight: 600,
              cursor: 'pointer',
              border: isSelected
                ? '1px solid var(--accent-color, #3b82f6)'
                : '1px solid var(--border-color, #4b5563)',
              backgroundColor: isSelected
                ? 'var(--accent-color, #3b82f6)'
                : 'transparent',
              color: isSelected ? '#ffffff' : 'inherit',
              transition: 'all 0.15s ease',
            }}
          >
            {isSelected ? '✓ Activo' : 'Usar este modelo'}
          </button>
        </div>
      </div>
    </div>
  );
};
