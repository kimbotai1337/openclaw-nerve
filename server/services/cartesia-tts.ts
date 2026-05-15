/**
 * Cartesia TTS provider.
 *
 * Generates non-streaming MP3 audio through Cartesia's `/tts/bytes` endpoint.
 * Nerve intentionally exposes only the Skylar voice for now.
 * @module
 */

import { config } from '../lib/config.js';
import { CARTESIA_SKYLAR_VOICE_ID, getTTSConfig } from '../lib/tts-config.js';

const CARTESIA_TTS_URL = 'https://api.cartesia.ai/tts/bytes';
const CARTESIA_VERSION = '2026-03-01';

export interface CartesiaTTSResult {
  ok: true;
  buf: Buffer;
  contentType: 'audio/mpeg';
}

export interface CartesiaTTSError {
  ok: false;
  status: number;
  message: string;
}

export async function synthesizeCartesia(
  text: string,
  opts?: { voice?: string; model?: string },
): Promise<CartesiaTTSResult | CartesiaTTSError> {
  if (!config.cartesiaApiKey) {
    return { ok: false, status: 500, message: 'Cartesia API key not configured' };
  }

  const cartesia = getTTSConfig().cartesia;
  const effectiveModel = opts?.model || cartesia.model;
  // Only Skylar is exposed; ignore arbitrary request voices entirely.
  const effectiveVoice = CARTESIA_SKYLAR_VOICE_ID;

  const resp = await fetch(CARTESIA_TTS_URL, {
    method: 'POST',
    headers: {
      'X-API-Key': config.cartesiaApiKey,
      'Cartesia-Version': CARTESIA_VERSION,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model_id: effectiveModel,
      transcript: text,
      voice: {
        mode: 'id',
        id: effectiveVoice,
      },
      output_format: {
        container: 'mp3',
        sample_rate: 44100,
        bit_rate: 128000,
      },
    }),
  });

  if (!resp.ok) {
    const errBody = await resp.text();
    console.error('[tts:cartesia] API error:', resp.status, errBody);
    return { ok: false, status: resp.status, message: errBody || 'Cartesia TTS failed' };
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  return { ok: true, buf, contentType: 'audio/mpeg' };
}
