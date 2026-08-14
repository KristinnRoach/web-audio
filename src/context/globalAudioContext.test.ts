import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

async function loadWithSinkId(sinkId: string | { readonly type: 'none' }) {
  class FakeAudioContext {
    state = 'running';
    sinkId = sinkId;
    audioWorklet = {};

    createGain() {
      return { gain: { cancelAndHoldAtTime: () => undefined } };
    }

    close() {
      return Promise.resolve();
    }
  }

  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
  vi.stubGlobal('AudioContext', FakeAudioContext);

  return import('./globalAudioContext');
}

describe('getCurrentOutputDeviceId', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns string sink ids', async () => {
    const { getCurrentOutputDeviceId } = await loadWithSinkId('speaker-1');

    expect(getCurrentOutputDeviceId()).toBe('speaker-1');
  });

  it('returns no device id for AudioSinkInfo silent output', async () => {
    const { getCurrentOutputDeviceId } = await loadWithSinkId({ type: 'none' });

    expect(getCurrentOutputDeviceId()).toBe('');
  });
});
