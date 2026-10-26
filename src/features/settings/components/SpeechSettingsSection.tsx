import React, { useState, useEffect } from 'react';
import type { SpeechPreferences, CustomModelConfig } from '../../../core/types/speech';
import { OFFICIAL_SPEECH_PACKS } from '../../../core/types/speech';
import { useSpeech } from '../hooks/useSpeech';
import { SpeechModelCard } from './SpeechModelCard';
import { playWavBase64 } from '../../../infra/audio-player';
import { convertBlobToWav16kMono } from '../../../infra/wav-recorder';

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
    deletePack,
    validateCustomModel,
    synthesize,
    transcribe,
    checkWyomingStatus,
    downloadProgress,
    isSynthesizing,
    isTranscribing,
  } = useSpeech();

  const [statuses, setStatuses] = useState<Record<string, any>>({});
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [activePackDownloading, setActivePackDownloading] = useState<string | null>(null);
  const [activePackDeleting, setActivePackDeleting] = useState<string | null>(null);

  const [customTtsValidation, setCustomTtsValidation] = useState<any>(null);
  const [customSttValidation, setCustomSttValidation] = useState<any>(null);
  const [testSynthesizeSuccess, setTestSynthesizeSuccess] = useState(false);
  const [testSynthesizeError, setTestSynthesizeError] = useState<string | null>(null);

  const [testSttRecording, setTestSttRecording] = useState(false);
  const [testSttResult, setTestSttResult] = useState<string | null>(null);
  const [testSttError, setTestSttError] = useState<string | null>(null);
  const testSttRecorderRef = React.useRef<MediaRecorder | null>(null);
  const testSttChunksRef = React.useRef<Blob[]>([]);

  const [wyomingTtsHealth, setWyomingTtsHealth] = useState<{ ok: boolean; info?: any; error?: string } | null>(null);
  const [wyomingSttHealth, setWyomingSttHealth] = useState<{ ok: boolean; info?: any; error?: string } | null>(null);
  const [isCheckingWyoming, setIsCheckingWyoming] = useState(false);

  const ttsPacks = Object.values(OFFICIAL_SPEECH_PACKS).filter((p) => p.kind === 'tts');
  const sttPacks = Object.values(OFFICIAL_SPEECH_PACKS).filter((p) => p.kind === 'stt');

  const refreshWyomingHealth = async () => {
    setIsCheckingWyoming(true);
    try {
      const ttsRes = await checkWyomingStatus(preferences.wyomingTtsUrl || 'tcp://127.0.0.1:10200');
      setWyomingTtsHealth(ttsRes);
    } catch (err: any) {
      setWyomingTtsHealth({ ok: false, error: err.message });
    }
    try {
      const sttRes = await checkWyomingStatus(preferences.wyomingSttUrl || 'tcp://127.0.0.1:10300');
      setWyomingSttHealth(sttRes);
    } catch (err: any) {
      setWyomingSttHealth({ ok: false, error: err.message });
    } finally {
      setIsCheckingWyoming(false);
    }
  };

  const refreshAllStatuses = async () => {
    await refreshWyomingHealth();
    const nextStatuses: Record<string, any> = {};
    for (const pack of Object.values(OFFICIAL_SPEECH_PACKS)) {
      try {
        const res = await checkPackStatus(pack.id);
        nextStatuses[pack.id] = res;
      } catch {}
    }
    setStatuses(nextStatuses);
  };

  useEffect(() => {
    refreshAllStatuses();
  }, []);

  const handleDownload = async (packId: string) => {
    setDownloadError(null);
    setActivePackDownloading(packId);
    try {
      await downloadPack(packId);
      const res = await checkPackStatus(packId);
      setStatuses((prev) => ({ ...prev, [packId]: res }));
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivePackDownloading(null);
    }
  };

  const handleDelete = async (packId: string) => {
    setDownloadError(null);
    setActivePackDeleting(packId);
    try {
      await deletePack(packId);
      const res = await checkPackStatus(packId);
      setStatuses((prev) => ({ ...prev, [packId]: res }));
    } catch (err) {
      setDownloadError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivePackDeleting(null);
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

  const handleToggleTestStt = async () => {
    if (testSttRecording) {
      if (testSttRecorderRef.current) {
        testSttRecorderRef.current.stop();
        setTestSttRecording(false);
      }
      return;
    }

    setTestSttError(null);
    setTestSttResult(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      testSttChunksRef.current = [];
      const mediaRecorder = new MediaRecorder(stream);
      testSttRecorderRef.current = mediaRecorder;

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) testSttChunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        try {
          const rawBlob = new Blob(testSttChunksRef.current, { type: mediaRecorder.mimeType || 'audio/webm' });
          const wavBlob = await convertBlobToWav16kMono(rawBlob);
          const reader = new FileReader();
          reader.onloadend = async () => {
            const base64Data = (reader.result as string)?.split(',')[1];
            if (base64Data) {
              const text = await transcribe(base64Data, preferences);
              setTestSttResult(text ? text.trim() : '(silencio o no detectado)');
            }
          };
          reader.readAsDataURL(wavBlob);
        } catch (err: any) {
          setTestSttError(err.message || String(err));
        } finally {
          stream.getTracks().forEach((t) => t.stop());
        }
      };

      mediaRecorder.start();
      setTestSttRecording(true);
    } catch (err: any) {
      setTestSttError(`Error de micrófono: ${err.message}`);
    }
  };

  const handleTestTts = async () => {
    setTestSynthesizeError(null);
    setTestSynthesizeSuccess(false);
    try {
      const audioBase64 = await synthesize('Hola, este es un mensaje de prueba de voz local.', preferences);
      if (audioBase64) {
        setTestSynthesizeSuccess(true);
        await playWavBase64(audioBase64);
      } else {
        setTestSynthesizeError('No se pudo generar el audio.');
      }
    } catch (err) {
      setTestSynthesizeError(err instanceof Error ? err.message : String(err));
    } finally {
      setTestSynthesizeSuccess(false);
    }
  };

  return (
    <div className="speech-settings-section" style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
      <div className="settings-field-group">
        <h3 style={{ margin: '0 0 8px 0', fontSize: '1.2rem' }}>Modelos Locales de Voz (TTS & STT)</h3>
        <p style={{ margin: 0, opacity: 0.75, fontSize: '0.9rem', lineHeight: '1.4' }}>
          Configura y descarga modelos acústicos ONNX locales para síntesis de voz (Text-to-Speech) y reconocimiento de voz (Speech-to-Text).
          Toda la inferencia se ejecuta 100% en tu máquina sin enviar datos a la nube.
        </p>
      </div>

      {downloadError && (
        <div style={{ padding: '12px 16px', background: 'rgba(239, 68, 68, 0.15)', border: '1px solid rgba(239, 68, 68, 0.4)', borderRadius: '6px', color: '#f87171' }}>
          <strong>Error:</strong> {downloadError}
        </div>
      )}

      {/* TTS Section */}
      <div style={{ padding: '20px', border: '1px solid var(--border-color, #374151)', borderRadius: '8px', background: 'rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
          <div>
            <h4 style={{ margin: 0, fontSize: '1.05rem' }}>Text-To-Speech (TTS) - Piper (Docker / Wyoming)</h4>
            <span style={{ fontSize: '0.82rem', opacity: 0.7 }}>Síntesis de voz neural de baja latencia mediante Wyoming Piper</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <input
              type="checkbox"
              id="tts-master-switch"
              className="notification-switch"
              checked={preferences.ttsEnabled}
              onChange={(e) => onSpeechPreferencesChange({ ttsEnabled: e.target.checked })}
              title={preferences.ttsEnabled ? 'TTS Activado' : 'TTS Desactivado'}
              aria-label="Toggle TTS"
            />
          </div>
        </div>

        {/* Docker Wyoming Service Banner */}
        <div
          style={{
            padding: '12px 16px',
            borderRadius: '6px',
            marginBottom: '14px',
            background: wyomingTtsHealth?.ok ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
            border: `1px solid ${wyomingTtsHealth?.ok ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              style={{
                display: 'inline-block',
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: wyomingTtsHealth?.ok ? '#22c55e' : '#ef4444',
              }}
            />
            <div>
              <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                {wyomingTtsHealth?.ok
                  ? `Servicio Docker Conectado (${wyomingTtsHealth.info?.name || 'wyoming-piper'})`
                  : 'Servicio Docker No Conectado'}
              </div>
              <div style={{ fontSize: '0.78rem', opacity: 0.8 }}>
                {wyomingTtsHealth?.ok
                  ? `Puerto TCP: ${preferences.wyomingTtsUrl || 'tcp://127.0.0.1:10200'} • Modelo en caché de Docker`
                  : `Inicia el contenedor: docker compose -f docker-compose.speech.yml up -d`}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={refreshWyomingHealth}
            disabled={isCheckingWyoming}
            style={{
              padding: '4px 10px',
              fontSize: '0.78rem',
              borderRadius: '4px',
              cursor: 'pointer',
              background: 'transparent',
              border: '1px solid currentColor',
              color: 'inherit',
              opacity: isCheckingWyoming ? 0.5 : 0.9,
            }}
          >
            {isCheckingWyoming ? 'Verificando...' : 'Reconectar'}
          </button>
        </div>

        {/* Always visible catalog of models so user can install/manage them even before activating */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '12px' }}>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="radio"
                name="tts-mode"
                checked={!preferences.ttsCustom?.isCustom}
                onChange={() => onSpeechPreferencesChange({ ttsCustom: { isCustom: false, modelPath: '' } })}
              />
              <span>Catálogo oficial</span>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '12px' }}>
                {ttsPacks.map((pack) => (
                  <SpeechModelCard
                    key={pack.id}
                    pack={pack}
                    statusResult={statuses[pack.id]}
                    downloadProgress={downloadProgress[pack.id]}
                    isSelected={preferences.selectedTtsPackId === pack.id}
                    onSelect={() => onSpeechPreferencesChange({ selectedTtsPackId: pack.id })}
                    onDownload={() => handleDownload(pack.id)}
                    onDelete={() => handleDelete(pack.id)}
                    isDownloading={activePackDownloading === pack.id}
                    isDeleting={activePackDeleting === pack.id}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '0.85rem' }}>Ruta al archivo .onnx de la voz:</label>
              <input
                type="text"
                placeholder="C:/rutas/mi-voz.onnx"
                value={preferences.ttsCustom?.modelPath || ''}
                onChange={(e) => handleCustomTtsPathChange(e.target.value)}
                style={{ padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--border-color, #4b5563)' }}
              />
              {customTtsValidation && (
                <div style={{ fontSize: '0.82rem' }}>
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

          {preferences.ttsEnabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <button
                  type="button"
                  onClick={handleTestTts}
                  disabled={isSynthesizing}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '4px',
                    cursor: isSynthesizing ? 'not-allowed' : 'pointer',
                    backgroundColor: 'var(--card-bg, #262626)',
                    border: '1px solid var(--border-color, #404040)',
                    color: 'inherit',
                    opacity: isSynthesizing ? 0.6 : 1,
                  }}
                >
                  {isSynthesizing ? 'Sintetizando audio...' : 'Probar audio de voz'}
                </button>
                {testSynthesizeSuccess && (
                  <span style={{ color: '#4ade80', fontSize: '0.85rem' }}>
                    Reproduciendo prueba...
                  </span>
                )}
              </div>
              {testSynthesizeError && (
                <div style={{ color: '#f87171', fontSize: '0.82rem' }}>
                  ✗ {testSynthesizeError}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* STT Section */}
      <div style={{ padding: '20px', border: '1px solid var(--border-color, #374151)', borderRadius: '8px', background: 'rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
          <div>
            <h4 style={{ margin: 0, fontSize: '1.05rem' }}>Speech-To-Text (STT) - Faster Whisper (Docker / Wyoming)</h4>
            <span style={{ fontSize: '0.82rem', opacity: 0.7 }}>Reconocimiento y transcripción de voz local mediante Wyoming Whisper</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <input
              type="checkbox"
              id="stt-master-switch"
              className="notification-switch"
              checked={preferences.sttEnabled}
              onChange={(e) => onSpeechPreferencesChange({ sttEnabled: e.target.checked })}
              title={preferences.sttEnabled ? 'STT Activado' : 'STT Desactivado'}
              aria-label="Toggle STT"
            />
          </div>
        </div>

        {/* Docker Wyoming STT Service Banner */}
        <div
          style={{
            padding: '12px 16px',
            borderRadius: '6px',
            marginBottom: '14px',
            background: wyomingSttHealth?.ok ? 'rgba(34, 197, 94, 0.1)' : 'rgba(239, 68, 68, 0.1)',
            border: `1px solid ${wyomingSttHealth?.ok ? 'rgba(34, 197, 94, 0.3)' : 'rgba(239, 68, 68, 0.3)'}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: '12px',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <span
              style={{
                display: 'inline-block',
                width: '10px',
                height: '10px',
                borderRadius: '50%',
                background: wyomingSttHealth?.ok ? '#22c55e' : '#ef4444',
              }}
            />
            <div>
              <div style={{ fontSize: '0.88rem', fontWeight: 600 }}>
                {wyomingSttHealth?.ok
                  ? `Servicio Docker Conectado (${wyomingSttHealth.info?.name || 'wyoming-whisper'})`
                  : 'Servicio Docker No Conectado'}
              </div>
              <div style={{ fontSize: '0.78rem', opacity: 0.8 }}>
                {wyomingSttHealth?.ok
                  ? `Puerto TCP: ${preferences.wyomingSttUrl || 'tcp://127.0.0.1:10300'} • Modelo en caché de Docker`
                  : `Inicia el contenedor: docker compose -f docker-compose.speech.yml up -d`}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={refreshWyomingHealth}
            disabled={isCheckingWyoming}
            style={{
              padding: '4px 10px',
              fontSize: '0.78rem',
              borderRadius: '4px',
              cursor: 'pointer',
              background: 'transparent',
              border: '1px solid currentColor',
              color: 'inherit',
              opacity: isCheckingWyoming ? 0.5 : 0.9,
            }}
          >
            {isCheckingWyoming ? 'Verificando...' : 'Reconectar'}
          </button>
        </div>

        {/* Always visible catalog of models so user can install/manage them even before activating */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', marginTop: '12px' }}>
          <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: '6px', cursor: 'pointer' }}>
              <input
                type="radio"
                name="stt-mode"
                checked={!preferences.sttCustom?.isCustom}
                onChange={() => onSpeechPreferencesChange({ sttCustom: { isCustom: false, modelPath: '' } })}
              />
              <span>Catálogo oficial</span>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: '12px' }}>
                {sttPacks.map((pack) => (
                  <SpeechModelCard
                    key={pack.id}
                    pack={pack}
                    statusResult={statuses[pack.id]}
                    downloadProgress={downloadProgress[pack.id]}
                    isSelected={preferences.selectedSttPackId === pack.id}
                    onSelect={() => onSpeechPreferencesChange({ selectedSttPackId: pack.id })}
                    onDownload={() => handleDownload(pack.id)}
                    onDelete={() => handleDelete(pack.id)}
                    isDownloading={activePackDownloading === pack.id}
                    isDeleting={activePackDeleting === pack.id}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <label style={{ fontSize: '0.85rem' }}>Ruta al encoder .onnx del modelo STT:</label>
              <input
                type="text"
                placeholder="C:/rutas/encoder.int8.onnx"
                value={preferences.sttCustom?.modelPath || ''}
                onChange={(e) => handleCustomSttPathChange(e.target.value)}
                style={{ padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--border-color, #4b5563)' }}
              />
              {customSttValidation && (
                <div style={{ fontSize: '0.82rem' }}>
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

          {preferences.sttEnabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '6px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
                <button
                  type="button"
                  onClick={handleToggleTestStt}
                  disabled={isTranscribing}
                  style={{
                    padding: '6px 14px',
                    borderRadius: '4px',
                    cursor: isTranscribing ? 'not-allowed' : 'pointer',
                    backgroundColor: testSttRecording ? '#dc2626' : 'var(--card-bg, #262626)',
                    border: '1px solid var(--border-color, #404040)',
                    color: testSttRecording ? '#ffffff' : 'inherit',
                    opacity: isTranscribing ? 0.6 : 1,
                  }}
                >
                  {isTranscribing
                    ? 'Transcribiendo con Whisper...'
                    : testSttRecording
                      ? '🛑 Detener grabación y probar'
                      : '🎤 Grabar audio de prueba'}
                </button>
                {testSttResult && (
                  <span style={{ fontSize: '0.88rem', color: '#60a5fa' }}>
                    Transcripción: <strong>"{testSttResult}"</strong>
                  </span>
                )}
              </div>
              {testSttError && (
                <div style={{ color: '#f87171', fontSize: '0.82rem' }}>
                  ✗ {testSttError}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
