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
      this.state = 'closed';
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
    const { configureGlobalAudioContext, getOrCreateGlobalAudioContext } = await loadWithSinkId('');

    configureGlobalAudioContext({ sampleRate: 44_100 });

    expect(getOrCreateGlobalAudioContext().sampleRate).toBe(44_100);
  });

  it('returns null and creates nothing before the global context exists', async () => {
    const { configureGlobalAudioContext, created } = await loadWithSinkId('');

    expect(configureGlobalAudioContext({ sampleRate: 44_100 })).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('keeps the live context when nothing changes', async () => {
    const { configureGlobalAudioContext, getOrCreateGlobalAudioContext } = await loadWithSinkId('');
    const first = getOrCreateGlobalAudioContext();

    expect(configureGlobalAudioContext({ sampleRate: 48_000 })).toBe(first);
    expect(first.state).not.toBe('closed');
  });

  it('closes and replaces the live context when an option changes', async () => {
    const { configureGlobalAudioContext, getOrCreateGlobalAudioContext } = await loadWithSinkId('');
    const first = getOrCreateGlobalAudioContext();

    const next = configureGlobalAudioContext({ sampleRate: 44_100 });

    expect(next).not.toBe(first);
    expect(next?.sampleRate).toBe(44_100);
    expect(first.state).toBe('closed');
    expect(getOrCreateGlobalAudioContext()).toBe(next);
  });

  it('carries the output device over to the replacement context', async () => {
    const { configureGlobalAudioContext, setAudioOutputDevice } = await loadWithSinkId('');
    await setAudioOutputDevice('speaker-1');

    const next = configureGlobalAudioContext({ sampleRate: 44_100 });

    expect((next as unknown as { sinkCalls: string[] }).sinkCalls).toEqual(['speaker-1']);
  });

  it('merges options across calls', async () => {
    const { configureGlobalAudioContext, getOrCreateGlobalAudioContext } = await loadWithSinkId('');
    configureGlobalAudioContext({ sampleRate: 44_100 });
    configureGlobalAudioContext({ latencyHint: 'playback' });

    expect(getOrCreateGlobalAudioContext().sampleRate).toBe(44_100);
  });
});

describe('getOrCreateGlobalAudioContext', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('replaces a closed global context', async () => {
    const { getOrCreateGlobalAudioContext } = await loadWithSinkId('');
    const first = getOrCreateGlobalAudioContext();
    await first.close();

    expect(getOrCreateGlobalAudioContext()).not.toBe(first);
  });
});
