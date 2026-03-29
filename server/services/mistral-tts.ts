/**
 * Mistral Voxtral TTS provider.
 *
 * Uses Mistral's audio speech API and decodes the returned base64 audio payload.
 * Maps Nerve's generic `voice` setting to Mistral `voice_id`.
 * @module
 */

import { config } from '../lib/config.js';
import { getTTSConfig } from '../lib/tts-config.js';
import { MISTRAL_TTS_URL } from '../lib/constants.js';

export interface MistralTTSResult {
  ok: true;
  buf: Buffer;
  contentType: 'audio/mpeg';
}

export interface MistralTTSError {
  ok: false;
  status: number;
  message: string;
}

export async function synthesizeMistral(
  text: string,
  opts?: { voice?: string; model?: string },
): Promise<MistralTTSResult | MistralTTSError> {
  if (!config.mistralApiKey) {
    return { ok: false, status: 500, message: 'Mistral API key not configured' };
  }

  const mistral = getTTSConfig().mistral;
  const effectiveModel = opts?.model || mistral.model;
  const effectiveVoice = opts?.voice || mistral.voice;

  const resp = await fetch(MISTRAL_TTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.mistralApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: effectiveModel,
      input: text,
      response_format: 'mp3',
      ...(effectiveVoice.trim() && { voice_id: effectiveVoice.trim() }),
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    console.error('[tts:mistral] API error:', resp.status, errBody);
    return { ok: false, status: resp.status, message: errBody || 'Mistral TTS failed' };
  }

  let payload: unknown;
  try {
    payload = await resp.json();
  } catch (err) {
    console.error('[tts:mistral] Failed to parse JSON:', (err as Error).message);
    return { ok: false, status: 502, message: 'Mistral returned invalid JSON' };
  }

  const audioData = (payload as { audio_data?: string }).audio_data;
  if (!audioData) {
    console.error('[tts:mistral] Missing audio data in response:', JSON.stringify(payload));
    return { ok: false, status: 502, message: 'Mistral response missing audio data' };
  }

  try {
    const buf = Buffer.from(audioData, 'base64');
    return { ok: true, buf, contentType: 'audio/mpeg' };
  } catch (err) {
    console.error('[tts:mistral] Failed to decode audio:', (err as Error).message);
    return { ok: false, status: 502, message: 'Mistral returned invalid audio data' };
  }
}
