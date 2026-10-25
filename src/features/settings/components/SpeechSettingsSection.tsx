import React, { useState, useEffect } from 'react';
import type { SpeechPreferences, CustomModelConfig } from '@core/types/speech';
import { OFFICIAL_SPEECH_PACKS, DEFAULT_SPEECH_PREFERENCES } from '@core/types/speech';
import { useSpeech } from '../hooks/useSpeech';

export interface SpeechSettingsSectionProps {
  preferences: SpeechPreferences;
  onSpeechPreferencesChange: (partial: Partial<SpeechPreferences>) => void;
  pickFileFn?: (filterName?: string, extensions?: string[]) => Promise<string | null>;
}

export const SpeechSettingsSection: React.FC<SpeechSettingsSectionProps> = ({
  preferences,
  onSpeechPreferencesChange,
}) => {
  const {
    checkPackStatus,
    downloadPack,
    validateCustomModel,
    synthesize,
    isDownloading,
  } = useSpeech();

  const [ttsPackStatus, setTtsPackStatus] = useState<any>(null);
  const [sttPackStatus, setSttPackStatus] = useState<any>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [customTtsValidation, setCustomTtsValidation] = useState<any>(null);
  const [customSttValidation, setCustomSttValidation] = useState<any>(null);
  const [testSynthesizeSuccess, setTestSynthesizeSuccess] = useState(false);

  const ttsPackId = preferences.selectedTtsPackId || DEFAULT_SPEECH_PREFERENCES.selectedTtsPackId;
  const sttPackId = preferences.selectedSttPackId || DEFAULT_SPEECH_PREFERENCES.selectedSttPackId;

  // Refresh pack integrity statuses
  const refreshStatuses = async () => {
    try {
      const ttsRes = await checkPackStatus(ttsPackId);
      setTtsPackStatus(ttsRes);
      const sttRes = await checkPackStatus(sttPackId);
      setSttPackStatus(sttRes);
    } catch {}
  };

  useEffect(() => {
    refreshStatuses();
  }, [ttsPackId, sttPackId]);

  const handleDownloadTts = async () => {
    setDownloadError(null);
    try {
      await downloadPack(ttsPackId);
      await refreshStatuses();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDownloadStt = async () => {
    setDownloadError(null);
    try {
      await downloadPack(sttPackId);
      await refreshStatuses();
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    }
  };

  const handleCustomTtsPathChange = async (path: string) => {
    const config: CustomModelConfig = {
      isCustom: true,
      modelPath: path,
    };
    onSpeechPreferencesChange({ ttsCustom: config });
    if (path.trim()) {
      const res = await validateCustomModel(config);
      setCustomTtsValidation(res);
      if (res.valid && res.computedSha256) {
        onSpeechPreferencesChange({
          ttsCustom: { ...config, computedSha256: res.computedSha256 },
        });
      }
    } else {
      setCustomTtsValidation(null);
    }
  };

  const handleCustomSttPathChange = async (path: string) => {
    const config: CustomModelConfig = {
      isCustom: true,
      modelPath: path,
    };
    onSpeechPreferencesChange({ sttCustom: config });
    if (path.trim()) {
      const res = await validateCustomModel(config);
      setCustomSttValidation(res);
      if (res.valid && res.computedSha256) {
        onSpeechPreferencesChange({
          sttCustom: { ...config, computedSha256: res.computedSha256 },
        });
      }
    } else {
      setCustomSttValidation(null);
    }
  };

  const handleTestTts = async () => {
    try {
      const audioBase64 = await synthesize('Hola, este es un mensaje de prueba de voz local.', preferences);
      if (audioBase64) {
        const audio = new Audio(`data:audio/wav;base64,${audioBase64}`);
        audio.play();
        setTestSynthesizeSuccess(true);
        setTimeout(() => setTestSynthesizeSuccess(false), 3000);
      }
    } catch {}
  };

  return (
    <div className="speech-settings-section" style={{ display: 'flex', flexDirection: 'column', gap: '24px' }}>
      <div className="settings-field-group">
        <h3 style={{ margin: '0 0 8px 0', fontSize: '1.1rem' }}>Local Speech (TTS & STT)</h3>
        <p style={{ margin: 0, opacity: 0.7, fontSize: '0.9rem' }}>
          Configura síntesis de voz (Text-to-Speech) y reconocimiento de voz (Speech-to-Text) locales y privados usando modelos ONNX.
        </p>
      </div>

      {downloadError && (
        <div style={{ padding: '10px 14px', background: 'rgba(255, 60, 60, 0.15)', border: '1px solid rgba(255, 60, 60, 0.4)', borderRadius: '6px', color: '#ff6b6b' }}>
          <strong>Error de descarga/verificación:</strong> {downloadError}
        </div>
      )}

      {/* TTS Section */}
      <div style={{ padding: '16px', border: '1px solid var(--border-color, #444)', borderRadius: '8px', background: 'rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div>
            <h4 style={{ margin: 0, fontSize: '1rem' }}>Text-To-Speech (TTS) - Piper</h4>
            <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>Síntesis de voz local mediante modelos acústicos ONNX</span>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <span>{preferences.ttsEnabled ? 'Activado' : 'Desactivado'}</span>
            <input
              type="checkbox"
              checked={preferences.ttsEnabled}
              onChange={(e) => onSpeechPreferencesChange({ ttsEnabled: e.target.checked })}
            />
          </label>
        </div>

        {preferences.ttsEnabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="tts-mode"
                  checked={!preferences.ttsCustom?.isCustom}
                  onChange={() => onSpeechPreferencesChange({ ttsCustom: { isCustom: false, modelPath: '' } })}
                />
                <span>Modelo oficial (es_MX Claude High)</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="tts-mode"
                  checked={Boolean(preferences.ttsCustom?.isCustom)}
                  onChange={() => onSpeechPreferencesChange({ ttsCustom: { isCustom: true, modelPath: preferences.ttsCustom?.modelPath || '' } })}
                />
                <span>Modelo personalizado (.onnx)</span>
              </label>
            </div>

            {!preferences.ttsCustom?.isCustom ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>Estado del pack oficial: <strong>{ttsPackStatus?.status || 'Verificando...'}</strong></span>
                  {ttsPackStatus?.status !== 'verified' && (
                    <button
                      type="button"
                      disabled={isDownloading}
                      onClick={handleDownloadTts}
                      style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}
                    >
                      {isDownloading ? 'Descargando...' : 'Descargar pack (~60 MB)'}
                    </button>
                  )}
                </div>
                {ttsPackStatus?.files && (
                  <div style={{ fontSize: '0.8rem', opacity: 0.8 }}>
                    {ttsPackStatus.files.map((f: any) => (
                      <div key={f.filename} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace' }}>
                        <span>{f.filename}</span>
                        <span>{f.status === 'verified' ? '✓ SHA-256 Verificado' : '✗ Falta descargar'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '0.85rem' }}>Ruta al archivo .onnx de la voz:</label>
                <input
                  type="text"
                  placeholder="C:/rutas/mi-voz.onnx"
                  value={preferences.ttsCustom?.modelPath || ''}
                  onChange={(e) => handleCustomTtsPathChange(e.target.value)}
                  style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color, #555)' }}
                />
                {customTtsValidation && (
                  <div style={{ fontSize: '0.8rem' }}>
                    {customTtsValidation.valid ? (
                      <span style={{ color: '#4ade80' }}>
                        ✓ Modelo ONNX válido (SHA-256: {customTtsValidation.computedSha256?.slice(0, 16)}...)
                      </span>
                    ) : (
                      <span style={{ color: '#f87171' }}>✗ {customTtsValidation.error}</span>
                    )}
                  </div>
                )}
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginTop: '8px' }}>
              <button
                type="button"
                onClick={handleTestTts}
                style={{ padding: '6px 14px', borderRadius: '4px', cursor: 'pointer' }}
              >
                Probar audio de voz
              </button>
              {testSynthesizeSuccess && <span style={{ color: '#4ade80', fontSize: '0.85rem' }}>Reproduciendo prueba...</span>}
            </div>
          </div>
        )}
      </div>

      {/* STT Section */}
      <div style={{ padding: '16px', border: '1px solid var(--border-color, #444)', borderRadius: '8px', background: 'rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '16px' }}>
          <div>
            <h4 style={{ margin: 0, fontSize: '1rem' }}>Speech-To-Text (STT) - Sherpa-ONNX</h4>
            <span style={{ fontSize: '0.8rem', opacity: 0.7 }}>Reconocimiento de voz local mediante modelos Zipformer INT8</span>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer' }}>
            <span>{preferences.sttEnabled ? 'Activado' : 'Desactivado'}</span>
            <input
              type="checkbox"
              checked={preferences.sttEnabled}
              onChange={(e) => onSpeechPreferencesChange({ sttEnabled: e.target.checked })}
            />
          </label>
        </div>

        {preferences.sttEnabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
            <div style={{ display: 'flex', gap: '12px', alignItems: 'center' }}>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="stt-mode"
                  checked={!preferences.sttCustom?.isCustom}
                  onChange={() => onSpeechPreferencesChange({ sttCustom: { isCustom: false, modelPath: '' } })}
                />
                <span>Modelo oficial (Español Kroko 64L INT8)</span>
              </label>
              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="stt-mode"
                  checked={Boolean(preferences.sttCustom?.isCustom)}
                  onChange={() => onSpeechPreferencesChange({ sttCustom: { isCustom: true, modelPath: preferences.sttCustom?.modelPath || '' } })}
                />
                <span>Modelo personalizado (.onnx)</span>
              </label>
            </div>

            {!preferences.sttCustom?.isCustom ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span>Estado del pack oficial: <strong>{sttPackStatus?.status || 'Verificando...'}</strong></span>
                  {sttPackStatus?.status !== 'verified' && (
                    <button
                      type="button"
                      disabled={isDownloading}
                      onClick={handleDownloadStt}
                      style={{ padding: '6px 12px', cursor: 'pointer', borderRadius: '4px' }}
                    >
                      {isDownloading ? 'Descargando...' : 'Descargar pack (~147 MB)'}
                    </button>
                  )}
                </div>
                {sttPackStatus?.files && (
                  <div style={{ fontSize: '0.8rem', opacity: 0.8 }}>
                    {sttPackStatus.files.map((f: any) => (
                      <div key={f.filename} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace' }}>
                        <span>{f.filename}</span>
                        <span>{f.status === 'verified' ? '✓ SHA-256 Verificado' : '✗ Falta descargar'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                <label style={{ fontSize: '0.85rem' }}>Ruta al encoder .onnx del modelo STT:</label>
                <input
                  type="text"
                  placeholder="C:/rutas/encoder.int8.onnx"
                  value={preferences.sttCustom?.modelPath || ''}
                  onChange={(e) => handleCustomSttPathChange(e.target.value)}
                  style={{ padding: '6px 10px', borderRadius: '4px', border: '1px solid var(--border-color, #555)' }}
                />
                {customSttValidation && (
                  <div style={{ fontSize: '0.8rem' }}>
                    {customSttValidation.valid ? (
                      <span style={{ color: '#4ade80' }}>
                        ✓ Modelo ONNX válido (SHA-256: {customSttValidation.computedSha256?.slice(0, 16)}...)
                      </span>
                    ) : (
                      <span style={{ color: '#f87171' }}>✗ {customSttValidation.error}</span>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
