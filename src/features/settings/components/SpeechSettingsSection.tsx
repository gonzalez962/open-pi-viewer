import React, { useState, useEffect, useRef } from 'react';
import type { SpeechPreferences } from '../../../core/types/speech';
import { useSpeech } from '../hooks/useSpeech';
import { playWavBase64 } from '../../../infra/audio-player';
import { convertBlobToWav16kMono } from '../../../infra/wav-recorder';

export interface SpeechSettingsSectionProps {
  preferences: SpeechPreferences;
  onSpeechPreferencesChange: (partial: Partial<SpeechPreferences>) => void;
}

const COMMON_PIPER_VOICES = [
  { id: 'es_MX-claude-high', label: 'Español (México) - Claude (High)' },
  { id: 'es_ES-davefx-medium', label: 'Español (España) - Davefx (Medium)' },
  { id: 'es_ES-sharvard-medium', label: 'Español (España) - Sharvard (Medium)' },
  { id: 'es_ES-carlfm-x_low', label: 'Español (España) - Carlfm (X-Low)' },
  { id: 'es_AR-daniela-high', label: 'Español (Argentina) - Daniela (High)' },
  { id: 'en_US-lessac-medium', label: 'English (US) - Lessac (Medium)' },
  { id: 'en_US-amy-medium', label: 'English (US) - Amy (Medium)' },
  { id: 'en_GB-alan-medium', label: 'English (UK) - Alan (Medium)' },
];

const WHISPER_MODELS = [
  { id: 'tiny', label: 'Tiny (~75 MB - Ultra rápido)' },
  { id: 'base', label: 'Base (~140 MB - Balanceado)' },
  { id: 'small', label: 'Small (~460 MB - Alta precisión)' },
  { id: 'medium', label: 'Medium (~1.5 GB - Precisión profesional)' },
];

const WHISPER_LANGUAGES = [
  { id: 'es', label: 'Español (es)' },
  { id: 'en', label: 'English (en)' },
  { id: 'auto', label: 'Detección automática' },
  { id: 'fr', label: 'Français (fr)' },
  { id: 'de', label: 'Deutsch (de)' },
  { id: 'pt', label: 'Português (pt)' },
];

const OPENAI_TTS_VOICES = [
  { id: 'alloy', label: 'Alloy (Neutral, balanceada)' },
  { id: 'echo', label: 'Echo (Masculina, cálida)' },
  { id: 'fable', label: 'Fable (Expresiva, acento británico)' },
  { id: 'onyx', label: 'Onyx (Masculina, profunda)' },
  { id: 'nova', label: 'Nova (Femenina, enérgica)' },
  { id: 'shimmer', label: 'Shimmer (Femenina, clara)' },
];

const OPENAI_TTS_MODELS = [
  { id: 'tts-1', label: 'tts-1 (Baja latencia, optimizado para tiempo real)' },
  { id: 'tts-1-hd', label: 'tts-1-hd (Alta definición)' },
];

export const SpeechSettingsSection: React.FC<SpeechSettingsSectionProps> = ({
  preferences,
  onSpeechPreferencesChange,
}) => {
  const {
    synthesize,
    transcribe,
    checkWyomingStatus,
    isSynthesizing,
    isTranscribing,
  } = useSpeech();

  const [testSynthesizeSuccess, setTestSynthesizeSuccess] = useState(false);
  const [testSynthesizeError, setTestSynthesizeError] = useState<string | null>(null);

  const [testSttRecording, setTestSttRecording] = useState(false);
  const [testSttResult, setTestSttResult] = useState<string | null>(null);
  const [testSttError, setTestSttError] = useState<string | null>(null);
  const testSttRecorderRef = useRef<MediaRecorder | null>(null);
  const testSttChunksRef = useRef<Blob[]>([]);

  const [wyomingTtsHealth, setWyomingTtsHealth] = useState<{ ok: boolean; info?: any; error?: string } | null>(null);
  const [wyomingSttHealth, setWyomingSttHealth] = useState<{ ok: boolean; info?: any; error?: string } | null>(null);
  const [isCheckingWyoming, setIsCheckingWyoming] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  const ttsUrl = preferences.wyomingTtsUrl || 'tcp://127.0.0.1:10200';
  const ttsVoice = preferences.wyomingTtsVoice || 'es_MX-claude-high';
  const sttUrl = preferences.wyomingSttUrl || 'tcp://127.0.0.1:10300';
  const sttModel = preferences.wyomingSttModel || 'tiny';
  const sttLang = preferences.wyomingSttLanguage || 'es';

  const parsePort = (url: string, defaultPort: number) => {
    const parts = url.replace(/^tcp:\/\//, '').split(':');
    return parts[1] || String(defaultPort);
  };

  const ttsPort = parsePort(ttsUrl, 10200);
  const sttPort = parsePort(sttUrl, 10300);

  const generatedDockerRunTts = `docker run -d --name wyoming-piper \\
  --restart unless-stopped \\
  -p 127.0.0.1:${ttsPort}:10200 \\
  -v wyoming_piper_data:/data \\
  rhasspy/wyoming-piper:latest \\
  --voice ${ttsVoice} \\
  --data-dir /data`;

  const generatedDockerRunStt = `docker run -d --name wyoming-whisper \\
  --restart unless-stopped \\
  -p 127.0.0.1:${sttPort}:10300 \\
  -v wyoming_whisper_data:/data \\
  rhasspy/wyoming-whisper:latest \\
  --model ${sttModel} \\
  --language ${sttLang} \\
  --data-dir /data`;

  const generatedDockerCompose = `services:
  wyoming-piper:
    image: rhasspy/wyoming-piper:latest
    container_name: wyoming-piper
    restart: unless-stopped
    ports:
      - "127.0.0.1:${ttsPort}:10200"
    volumes:
      - piper-data:/data
    command:
      - --voice
      - ${ttsVoice}
      - --data-dir
      - /data

  wyoming-whisper:
    image: rhasspy/wyoming-whisper:latest
    container_name: wyoming-whisper
    restart: unless-stopped
    ports:
      - "127.0.0.1:${sttPort}:10300"
    volumes:
      - whisper-data:/data
    command:
      - --model
      - ${sttModel}
      - --language
      - ${sttLang}
      - --data-dir
      - /data

volumes:
  piper-data:
    name: wyoming_piper_data
  whisper-data:
    name: wyoming_whisper_data`;

  const handleCopy = (key: string, text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 2500);
    });
  };

  const refreshWyomingHealth = async () => {
    setIsCheckingWyoming(true);
    try {
      const ttsRes = await checkWyomingStatus(ttsUrl);
      setWyomingTtsHealth(ttsRes);
    } catch (err: any) {
      setWyomingTtsHealth({ ok: false, error: err.message });
    }
    try {
      const sttRes = await checkWyomingStatus(sttUrl);
      setWyomingSttHealth(sttRes);
    } catch (err: any) {
      setWyomingSttHealth({ ok: false, error: err.message });
    } finally {
      setIsCheckingWyoming(false);
    }
  };

  useEffect(() => {
    refreshWyomingHealth();
  }, [ttsUrl, sttUrl]);

  const handleTestTts = async () => {
    setTestSynthesizeError(null);
    setTestSynthesizeSuccess(false);
    try {
      const audioBase64 = await synthesize('Hola, este es un mensaje de prueba de voz con Piper en Docker.', preferences);
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

  return (
    <div className="speech-settings-section" style={{ display: 'flex', flexDirection: 'column', gap: '28px' }}>
      <div className="settings-field-group">
        <h3 style={{ margin: '0 0 8px 0', fontSize: '1.2rem' }}>Servicios de Voz Containerizados (TTS & STT)</h3>
        <p style={{ margin: 0, opacity: 0.75, fontSize: '0.9rem', lineHeight: '1.4' }}>
          La inferencia de voz se ejecuta 100% local a través de contenedores Docker compatibles con el estándar Wyoming Protocol (Piper para síntesis y Faster-Whisper para transcripción).
          No requiere descargas manuales de modelos ni binarios externos en el sistema operativo.
        </p>
      </div>

      {/* Global Docker Compose Quick Box */}
      <div style={{ padding: '16px 20px', borderRadius: '8px', border: '1px solid var(--border-color, #374151)', background: 'var(--card-bg, rgba(255,255,255,0.03))' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '8px' }}>
          <strong style={{ fontSize: '0.95rem' }}>Levantar ambos servicios con Docker Compose</strong>
          <button
            type="button"
            onClick={() => handleCopy('compose', generatedDockerCompose)}
            style={{
              padding: '4px 12px',
              fontSize: '0.78rem',
              borderRadius: '4px',
              cursor: 'pointer',
              background: copiedKey === 'compose' ? '#16a34a' : 'transparent',
              border: '1px solid var(--border-color, #4b5563)',
              color: 'inherit',
            }}
          >
            {copiedKey === 'compose' ? '✓ Copiado' : 'Copiar docker-compose.speech.yml'}
          </button>
        </div>
        <p style={{ fontSize: '0.82rem', opacity: 0.75, margin: '0 0 10px 0' }}>
          Crea el archivo <code>docker-compose.speech.yml</code> o copia este contenido y ejecuta <code>docker compose -f docker-compose.speech.yml up -d</code>.
        </p>
        <pre
          style={{
            margin: 0,
            padding: '10px 14px',
            borderRadius: '6px',
            background: 'rgba(0,0,0,0.3)',
            fontSize: '0.78rem',
            overflowX: 'auto',
            maxHeight: '140px',
            border: '1px solid rgba(255,255,255,0.05)',
          }}
        >
          {generatedDockerCompose}
        </pre>
      </div>

      {/* Global / OpenAI Provider Settings */}
      <div style={{ padding: '20px', border: '1px solid var(--border-color, #374151)', borderRadius: '8px', background: 'rgba(0,0,0,0.1)' }}>
        <h4 style={{ margin: '0 0 4px 0', fontSize: '1.05rem' }}>Configuración de OpenAI Audio API</h4>
        <p style={{ fontSize: '0.82rem', opacity: 0.75, margin: '0 0 16px 0' }}>
          Permite usar <code>/v1/audio/speech</code> y <code>/v1/audio/transcriptions</code> de OpenAI o proxies compatibles.
        </p>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '0.85rem', fontWeight: 500 }}>OpenAI API Key:</label>
            <input
              type="password"
              value={preferences.openAiApiKey || ''}
              onChange={(e) => onSpeechPreferencesChange({ openAiApiKey: e.target.value })}
              placeholder="sk-..."
              style={{ padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--border-color, #4b5563)' }}
            />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
            <label style={{ fontSize: '0.85rem', fontWeight: 500 }}>Base URL de la API:</label>
            <input
              type="text"
              value={preferences.openAiBaseUrl || 'https://api.openai.com/v1'}
              onChange={(e) => onSpeechPreferencesChange({ openAiBaseUrl: e.target.value })}
              placeholder="https://api.openai.com/v1"
              style={{ padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--border-color, #4b5563)' }}
            />
          </div>
        </div>
      </div>

      {/* TTS Section */}
      <div style={{ padding: '20px', border: '1px solid var(--border-color, #374151)', borderRadius: '8px', background: 'rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
          <div>
            <h4 style={{ margin: 0, fontSize: '1.05rem' }}>Text-To-Speech (TTS)</h4>
            <span style={{ fontSize: '0.82rem', opacity: 0.7 }}>Síntesis de voz para respuestas habladas</span>
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

        {/* TTS Provider Selector */}
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '16px' }}>
          <label style={{ fontSize: '0.85rem', fontWeight: 500 }}>Proveedor de TTS:</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={() => onSpeechPreferencesChange({ ttsProvider: 'wyoming' })}
              style={{
                padding: '6px 14px',
                fontSize: '0.82rem',
                borderRadius: '4px',
                cursor: 'pointer',
                background: (preferences.ttsProvider || 'wyoming') === 'wyoming' ? '#3b82f6' : 'rgba(255,255,255,0.06)',
                border: '1px solid var(--border-color, #4b5563)',
                color: (preferences.ttsProvider || 'wyoming') === 'wyoming' ? '#fff' : 'inherit',
              }}
            >
              Wyoming / Piper (Docker Local)
            </button>
            <button
              type="button"
              onClick={() => onSpeechPreferencesChange({ ttsProvider: 'openai' })}
              style={{
                padding: '6px 14px',
                fontSize: '0.82rem',
                borderRadius: '4px',
                cursor: 'pointer',
                background: preferences.ttsProvider === 'openai' ? '#3b82f6' : 'rgba(255,255,255,0.06)',
                border: '1px solid var(--border-color, #4b5563)',
                color: preferences.ttsProvider === 'openai' ? '#fff' : 'inherit',
              }}
            >
              OpenAI API (/v1/audio/speech)
            </button>
          </div>
        </div>

        {preferences.ttsProvider === 'openai' ? (
          /* OpenAI TTS Configuration */
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 500 }}>Modelo de Voz OpenAI:</label>
              <select
                value={preferences.openAiTtsModel || 'tts-1'}
                onChange={(e) => onSpeechPreferencesChange({ openAiTtsModel: e.target.value })}
                style={{ padding: '8px', borderRadius: '4px', border: '1px solid var(--border-color, #4b5563)' }}
              >
                {OPENAI_TTS_MODELS.map((m) => (
                  <option key={m.id} value={m.id}>{m.label}</option>
                ))}
              </select>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 500 }}>Voz OpenAI:</label>
              <select
                value={preferences.openAiTtsVoice || 'alloy'}
                onChange={(e) => onSpeechPreferencesChange({ openAiTtsVoice: e.target.value })}
                style={{ padding: '8px', borderRadius: '4px', border: '1px solid var(--border-color, #4b5563)' }}
              >
                {OPENAI_TTS_VOICES.map((v) => (
                  <option key={v.id} value={v.id}>{v.label}</option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          /* Wyoming TTS Status & Configuration */
          <>
            <div
              style={{
                padding: '12px 16px',
                borderRadius: '6px',
                marginBottom: '16px',
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
                      ? `Servicio Piper Conectado (${wyomingTtsHealth.info?.name || 'wyoming-piper'})`
                      : 'Servicio Piper No Conectado'}
                  </div>
                  <div style={{ fontSize: '0.78rem', opacity: 0.8 }}>
                    {wyomingTtsHealth?.ok
                      ? `Conectado a ${ttsUrl} • Motor: Piper Neural`
                      : `Inicia el contenedor Docker para habilitar síntesis de voz`}
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

            {/* TTS Configuration Fields */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px', marginBottom: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 500 }}>Endpoint TCP de Wyoming:</label>
                <input
                  type="text"
                  value={ttsUrl}
                  onChange={(e) => onSpeechPreferencesChange({ wyomingTtsUrl: e.target.value })}
                  placeholder="tcp://127.0.0.1:10200"
                  style={{ padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--border-color, #4b5563)' }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 500 }}>Voz del Modelo Piper:</label>
                <select
                  value={ttsVoice}
                  onChange={(e) => onSpeechPreferencesChange({ wyomingTtsVoice: e.target.value })}
                  style={{ padding: '8px', borderRadius: '4px', border: '1px solid var(--border-color, #4b5563)' }}
                >
                  {COMMON_PIPER_VOICES.map((v) => (
                    <option key={v.id} value={v.id}>{v.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Docker run command copy box */}
            <div style={{ background: 'rgba(0,0,0,0.25)', padding: '12px', borderRadius: '6px', marginBottom: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '0.78rem', opacity: 0.8 }}>Comando de instalación / arranque individual (Docker CLI):</span>
                <button
                  type="button"
                  onClick={() => handleCopy('docker-tts', generatedDockerRunTts)}
                  style={{
                    padding: '2px 8px',
                    fontSize: '0.75rem',
                    borderRadius: '3px',
                    cursor: 'pointer',
                    background: copiedKey === 'docker-tts' ? '#16a34a' : 'transparent',
                    border: '1px solid var(--border-color, #4b5563)',
                    color: 'inherit',
                  }}
                >
                  {copiedKey === 'docker-tts' ? '✓ Copiado' : 'Copiar comando'}
                </button>
              </div>
              <pre style={{ margin: 0, fontSize: '0.75rem', opacity: 0.9, overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
                {generatedDockerRunTts}
              </pre>
            </div>
          </>
        )}

        {/* Test audio synthesis button */}
        {preferences.ttsEnabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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

      {/* STT Section */}
      <div style={{ padding: '20px', border: '1px solid var(--border-color, #374151)', borderRadius: '8px', background: 'rgba(0,0,0,0.1)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '18px' }}>
          <div>
            <h4 style={{ margin: 0, fontSize: '1.05rem' }}>Speech-To-Text (STT)</h4>
            <span style={{ fontSize: '0.82rem', opacity: 0.7 }}>Transcripción y reconocimiento de voz para mensajes</span>
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

        {/* STT Provider Selector */}
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center', marginBottom: '16px' }}>
          <label style={{ fontSize: '0.85rem', fontWeight: 500 }}>Proveedor de STT:</label>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button
              type="button"
              onClick={() => onSpeechPreferencesChange({ sttProvider: 'wyoming' })}
              style={{
                padding: '6px 14px',
                fontSize: '0.82rem',
                borderRadius: '4px',
                cursor: 'pointer',
                background: (preferences.sttProvider || 'wyoming') === 'wyoming' ? '#3b82f6' : 'rgba(255,255,255,0.06)',
                border: '1px solid var(--border-color, #4b5563)',
                color: (preferences.sttProvider || 'wyoming') === 'wyoming' ? '#fff' : 'inherit',
              }}
            >
              Wyoming / Whisper (Docker Local)
            </button>
            <button
              type="button"
              onClick={() => onSpeechPreferencesChange({ sttProvider: 'openai' })}
              style={{
                padding: '6px 14px',
                fontSize: '0.82rem',
                borderRadius: '4px',
                cursor: 'pointer',
                background: preferences.sttProvider === 'openai' ? '#3b82f6' : 'rgba(255,255,255,0.06)',
                border: '1px solid var(--border-color, #4b5563)',
                color: preferences.sttProvider === 'openai' ? '#fff' : 'inherit',
              }}
            >
              OpenAI API (/v1/audio/transcriptions)
            </button>
          </div>
        </div>

        {preferences.sttProvider === 'openai' ? (
          /* OpenAI STT Configuration */
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '16px', marginBottom: '16px' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 500 }}>Modelo Whisper de OpenAI:</label>
              <input
                type="text"
                value={preferences.openAiSttModel || 'whisper-1'}
                onChange={(e) => onSpeechPreferencesChange({ openAiSttModel: e.target.value })}
                placeholder="whisper-1"
                style={{ padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--border-color, #4b5563)' }}
              />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
              <label style={{ fontSize: '0.85rem', fontWeight: 500 }}>Idioma de Transcripción:</label>
              <select
                value={preferences.openAiSttLanguage || 'es'}
                onChange={(e) => onSpeechPreferencesChange({ openAiSttLanguage: e.target.value })}
                style={{ padding: '8px', borderRadius: '4px', border: '1px solid var(--border-color, #4b5563)' }}
              >
                {WHISPER_LANGUAGES.map((l) => (
                  <option key={l.id} value={l.id}>{l.label}</option>
                ))}
              </select>
            </div>
          </div>
        ) : (
          /* Wyoming STT Status & Configuration */
          <>
            <div
              style={{
                padding: '12px 16px',
                borderRadius: '6px',
                marginBottom: '16px',
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
                      ? `Servicio Whisper Conectado (${wyomingSttHealth.info?.name || 'wyoming-whisper'})`
                      : 'Servicio Whisper No Conectado'}
                  </div>
                  <div style={{ fontSize: '0.78rem', opacity: 0.8 }}>
                    {wyomingSttHealth?.ok
                      ? `Conectado a ${sttUrl} • Motor: Faster-Whisper CTranslate2`
                      : `Inicia el contenedor Docker para habilitar reconocimiento de voz`}
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

            {/* STT Configuration Fields */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '16px', marginBottom: '16px' }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 500 }}>Endpoint TCP de Wyoming:</label>
                <input
                  type="text"
                  value={sttUrl}
                  onChange={(e) => onSpeechPreferencesChange({ wyomingSttUrl: e.target.value })}
                  placeholder="tcp://127.0.0.1:10300"
                  style={{ padding: '8px 12px', borderRadius: '4px', border: '1px solid var(--border-color, #4b5563)' }}
                />
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 500 }}>Tamaño del Modelo Whisper:</label>
                <select
                  value={sttModel}
                  onChange={(e) => onSpeechPreferencesChange({ wyomingSttModel: e.target.value })}
                  style={{ padding: '8px', borderRadius: '4px', border: '1px solid var(--border-color, #4b5563)' }}
                >
                  {WHISPER_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <label style={{ fontSize: '0.85rem', fontWeight: 500 }}>Idioma de Transcripción:</label>
                <select
                  value={sttLang}
                  onChange={(e) => onSpeechPreferencesChange({ wyomingSttLanguage: e.target.value })}
                  style={{ padding: '8px', borderRadius: '4px', border: '1px solid var(--border-color, #4b5563)' }}
                >
                  {WHISPER_LANGUAGES.map((l) => (
                    <option key={l.id} value={l.id}>{l.label}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Docker run command copy box for Whisper */}
            <div style={{ background: 'rgba(0,0,0,0.25)', padding: '12px', borderRadius: '6px', marginBottom: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                <span style={{ fontSize: '0.78rem', opacity: 0.8 }}>Comando de instalación / arranque individual (Docker CLI):</span>
                <button
                  type="button"
                  onClick={() => handleCopy('docker-stt', generatedDockerRunStt)}
                  style={{
                    padding: '2px 8px',
                    fontSize: '0.75rem',
                    borderRadius: '3px',
                    cursor: 'pointer',
                    background: copiedKey === 'docker-stt' ? '#16a34a' : 'transparent',
                    border: '1px solid var(--border-color, #4b5563)',
                    color: 'inherit',
                  }}
                >
                  {copiedKey === 'docker-stt' ? '✓ Copiado' : 'Copiar comando'}
                </button>
              </div>
              <pre style={{ margin: 0, fontSize: '0.75rem', opacity: 0.9, overflowX: 'auto', whiteSpace: 'pre-wrap' }}>
                {generatedDockerRunStt}
              </pre>
            </div>
          </>
        )}

        {/* Test STT recording button */}
        {preferences.sttEnabled && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
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
  );
};
