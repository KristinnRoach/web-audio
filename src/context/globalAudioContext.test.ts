import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

async function loadWithSinkId(sinkId: string | { readonly type: 'none' }) {
  const created: FakeAudioContext[] = [];

  class FakeAudioContext {
    state = 'running';
    sinkId = sinkId;
    audioWorklet = {};
    sampleRate: number;
    sinkCalls: string[] = [];

    constructor(options: AudioContextOptions = {}) {
      this.sampleRate = options.sampleRate ?? 48000;
      created.push(this);
    }

    // On the prototype, where canSetOutputDevice looks for it
    async setSinkId(id: string) {
      this.sinkCalls.push(id);
      this.sinkId = id;
    }

    createGain() {
      return { gain: { cancelAndHoldAtTime: () => undefined } };
    }

    close() {
      return Promise.resolve();
    }
  }

  vi.stubGlobal('window', { AudioContext: FakeAudioContext });
  vi.stubGlobal('AudioContext', FakeAudioContext);

  const mod = await import('./globalAudioContext');
  return { ...mod, created, FakeAudioContext };
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

  it('reads a passed context without creating the global one', async () => {
    const { getCurrentOutputDeviceId, created, FakeAudioContext } =
      await loadWithSinkId('speaker-1');
    const own = new FakeAudioContext();
    own.sinkId = 'speaker-2';
    const before = created.length;

    expect(getCurrentOutputDeviceId(own as unknown as AudioContext)).toBe('speaker-2');
    expect(created).toHaveLength(before);
  });
});

describe('setAudioOutputDevice', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('routes a passed context and maps "default" to the system default', async () => {
    const { setAudioOutputDevice, created, FakeAudioContext } = await loadWithSinkId('');
    const own = new FakeAudioContext();
    const before = created.length;

    await setAudioOutputDevice('speaker-1', own as unknown as AudioContext);
    await setAudioOutputDevice('default', own as unknown as AudioContext);

    expect(own.sinkCalls).toEqual(['speaker-1', '']);
    expect(created).toHaveLength(before);
  });
});

describe('configureGlobalAudioContext', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('sets the sample rate the global context is created with', async () => {
    const { configureGlobalAudioContext, getGlobalAudioContext } = await loadWithSinkId('');

    configureGlobalAudioContext({ sampleRate: 44_100 });

    expect(getGlobalAudioContext().sampleRate).toBe(44_100);
  });

  it('throws once the global context exists at a different rate', async () => {
    const { configureGlobalAudioContext, getGlobalAudioContext } = await loadWithSinkId('');
    getGlobalAudioContext();

    expect(() => configureGlobalAudioContext({ sampleRate: 44_100 })).toThrow(/48000 Hz/);
    expect(() => configureGlobalAudioContext({ sampleRate: 48_000 })).not.toThrow();
  });
});
