/**
 * The terminal's adapters type as a keyboard: every `sendText` asks the proxy
 * for `advance`, so a character typed past a full field moves on to the next
 * one (the operator who types a 10-character user and goes on typing gets the
 * password in the Password field). Without it the proxy treats the text as a
 * field write and refuses the overflow.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RestAdapter } from './RestAdapter';
import { WebSocketAdapter } from './WebSocketAdapter';

afterEach(() => vi.restoreAllMocks());

describe('sendText is keyboard typing', () => {
  it('RestAdapter posts advance: true', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ success: true }) });
    vi.stubGlobal('fetch', fetchMock);
    await new RestAdapter({ baseUrl: 'http://proxy' }).sendText('LEGACYBPRD');
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://proxy/send-text');
    expect(JSON.parse(init.body)).toEqual({ text: 'LEGACYBPRD', advance: true });
    vi.unstubAllGlobals();
  });

  it('WebSocketAdapter sends advance: true', async () => {
    const adapter = new WebSocketAdapter();
    const sent = vi
      .spyOn(adapter as unknown as { sendAndWaitForScreen: (m: object) => Promise<unknown> }, 'sendAndWaitForScreen')
      .mockResolvedValue({ success: true });
    await adapter.sendText('LEGACYBPRD');
    expect(sent).toHaveBeenCalledWith({ type: 'text', text: 'LEGACYBPRD', advance: true });
  });
});
