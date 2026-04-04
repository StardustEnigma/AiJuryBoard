/**
 * ElevenLabs TTS client utilities.
 */

import { log, retry } from './logger.js';

const ELEVENLABS_BASE_URL = process.env.ELEVENLABS_BASE_URL || 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE_ID = process.env.ELEVENLABS_VOICE_ID || 'EXAVITQu4vr4xnSDxMaL';
const DEFAULT_MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
const DEFAULT_OUTPUT_FORMAT = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';

export type ElevenLabsSynthesisOptions = {
  text: string;
  voiceId?: string;
  modelId?: string;
};

function getApiKey(): string {
  const key = (process.env.ELEVENLABS_API_KEY || '').trim();
  if (!key) {
    throw new Error('ELEVENLABS_API_KEY is not set');
  }
  return key;
}

export function isElevenLabsConfigured(): boolean {
  return Boolean((process.env.ELEVENLABS_API_KEY || '').trim());
}

export function resolveElevenLabsDefaults() {
  return {
    voiceId: DEFAULT_VOICE_ID,
    modelId: DEFAULT_MODEL_ID,
    outputFormat: DEFAULT_OUTPUT_FORMAT,
  };
}

export async function synthesizeSpeechWithElevenLabs(options: ElevenLabsSynthesisOptions): Promise<Buffer> {
  const text = options.text.replace(/\s+/g, ' ').trim();
  if (!text) {
    throw new Error('text is required for TTS synthesis');
  }
  if (text.length > 4500) {
    throw new Error('text exceeds ElevenLabs limit (4500 chars)');
  }

  const { voiceId: defaultVoiceId, modelId: defaultModelId, outputFormat } = resolveElevenLabsDefaults();
  const voiceId = (options.voiceId || defaultVoiceId).trim();
  const modelId = (options.modelId || defaultModelId).trim();
  const apiKey = getApiKey();

  const endpoint = `${ELEVENLABS_BASE_URL}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${encodeURIComponent(outputFormat)}`;

  return retry(
    async () => {
      log('🔊', `Calling ElevenLabs TTS (${voiceId}, ${modelId})`);

      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({
          text,
          model_id: modelId,
          voice_settings: {
            stability: 0.35,
            similarity_boost: 0.75,
            style: 0.2,
            use_speaker_boost: true,
          },
        }),
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`ElevenLabs error: ${response.status} ${response.statusText} ${body}`);
      }

      const audioArrayBuffer = await response.arrayBuffer();
      return Buffer.from(audioArrayBuffer);
    },
    'ElevenLabs TTS call',
    3,
    1200
  );
}
