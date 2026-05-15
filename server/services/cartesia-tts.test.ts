/** Tests for the Cartesia TTS provider service. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const SKYLAR_ID = 'db6b0ed5-d5d3-463d-ae85-518a07d3c2b4';

describe('synthesizeCartesia', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns a clear error when the Cartesia key is missing', async () => {
    vi.doMock('../lib/config.js', () => ({
      config: { cartesiaApiKey: '' },
    }));

    vi.doMock('../lib/tts-config.js', () => ({
      CARTESIA_SKYLAR_VOICE_ID: SKYLAR_ID,
      getTTSConfig: () => ({ cartesia: { model: 'sonic-3.5', voice: 'Skylar', voiceId: SKYLAR_ID } }),
    }));

    const { synthesizeCartesia } = await import('./cartesia-tts.js');
    await expect(synthesizeCartesia('Hello')).resolves.toMatchObject({
      ok: false,
      status: 500,
      message: expect.stringContaining('Cartesia'),
    });
  });

  it('posts Sonic 3.5 bytes request using only the Skylar voice id', async () => {
    vi.doMock('../lib/config.js', () => ({
      config: { cartesiaApiKey: 'sk-car-test' },
    }));

    vi.doMock('../lib/tts-config.js', () => ({
      CARTESIA_SKYLAR_VOICE_ID: SKYLAR_ID,
      getTTSConfig: () => ({ cartesia: { model: 'sonic-3.5', voice: 'Skylar', voiceId: SKYLAR_ID } }),
    }));

    const mp3 = Buffer.from('ID3demo');
    vi.mocked(fetch).mockResolvedValue(new Response(mp3, { status: 200, headers: { 'Content-Type': 'audio/mpeg' } }));

    const { synthesizeCartesia } = await import('./cartesia-tts.js');
    const result = await synthesizeCartesia('Hello there', { voice: 'not-allowed' });

    expect(result).toMatchObject({ ok: true, contentType: 'audio/mpeg' });
    if (!result.ok) throw new Error('Expected Cartesia synthesis to succeed');
    expect(result.buf.equals(mp3)).toBe(true);

    expect(fetch).toHaveBeenCalledWith(
      'https://api.cartesia.ai/tts/bytes',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-API-Key': 'sk-car-test',
          'Cartesia-Version': '2026-03-01',
          'Content-Type': 'application/json',
        }),
      }),
    );

    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      model_id: 'sonic-3.5',
      transcript: 'Hello there',
      voice: { mode: 'id', id: SKYLAR_ID },
      output_format: { container: 'mp3', sample_rate: 44100, bit_rate: 128000 },
    });
  });
});
