/** Tests for the Mistral Voxtral TTS provider service. */
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

describe('synthesizeMistral', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns a clear error when the Mistral key is missing', async () => {
    vi.doMock('../lib/config.js', () => ({
      config: { mistralApiKey: '' },
    }));

    vi.doMock('../lib/tts-config.js', () => ({
      getTTSConfig: () => ({ mistral: { model: 'voxtral-mini-tts-2603', voice: '' } }),
    }));

    const { synthesizeMistral } = await import('./mistral-tts.js');
    await expect(synthesizeMistral('Hello')).resolves.toMatchObject({
      ok: false,
      status: 500,
      message: expect.stringContaining('Mistral'),
    });
  });

  it('posts Voxtral speech requests and decodes MP3 audio', async () => {
    vi.doMock('../lib/config.js', () => ({
      config: { mistralApiKey: 'sk-mistral' },
    }));

    vi.doMock('../lib/tts-config.js', () => ({
      getTTSConfig: () => ({ mistral: { model: 'voxtral-mini-tts-2603', voice: 'alloy_voice' } }),
    }));

    const mp3 = Buffer.from('ID3demo');
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ audio_data: mp3.toString('base64') }), { status: 200 }),
    );

    const { synthesizeMistral } = await import('./mistral-tts.js');
    const result = await synthesizeMistral('Hello there');

    expect(result).toMatchObject({ ok: true, contentType: 'audio/mpeg' });
    if (!result.ok) throw new Error('Expected Mistral synthesis to succeed');
    expect(result.buf.equals(mp3)).toBe(true);

    expect(fetch).toHaveBeenCalledWith(
      'https://api.mistral.ai/v1/audio/speech',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer sk-mistral',
          'Content-Type': 'application/json',
        }),
      }),
    );

    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe('voxtral-mini-tts-2603');
    expect(body.input).toBe('Hello there');
    expect(body.response_format).toBe('mp3');
    expect(body.voice_id).toBe('alloy_voice');
  });

  it('omits voice_id when no voice is configured', async () => {
    vi.doMock('../lib/config.js', () => ({
      config: { mistralApiKey: 'sk-mistral' },
    }));

    vi.doMock('../lib/tts-config.js', () => ({
      getTTSConfig: () => ({ mistral: { model: 'voxtral-mini-tts-2603', voice: '' } }),
    }));

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ audio_data: Buffer.from('ID3demo').toString('base64') }), { status: 200 }),
    );

    const { synthesizeMistral } = await import('./mistral-tts.js');
    await synthesizeMistral('Hello');

    const [, init] = vi.mocked(fetch).mock.calls[0] ?? [];
    const body = JSON.parse(String(init?.body));
    expect(body.voice_id).toBeUndefined();
  });

  it('returns a provider error when Mistral payload is malformed', async () => {
    vi.doMock('../lib/config.js', () => ({
      config: { mistralApiKey: 'sk-mistral' },
    }));

    vi.doMock('../lib/tts-config.js', () => ({
      getTTSConfig: () => ({ mistral: { model: 'voxtral-mini-tts-2603', voice: '' } }),
    }));

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({}), { status: 200 }),
    );

    const { synthesizeMistral } = await import('./mistral-tts.js');
    await expect(synthesizeMistral('Hello')).resolves.toMatchObject({
      ok: false,
      status: 502,
      message: expect.stringContaining('audio'),
    });
  });
});
