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

describe('getGlobalAudioContext', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates the global context once', async () => {
    const { getGlobalAudioContext, created } = await loadWithSinkId('');

    expect(getGlobalAudioContext()).toBe(getGlobalAudioContext());
    expect(created).toHaveLength(1);
  });

  it('replaces a closed global context', async () => {
    const { getGlobalAudioContext } = await loadWithSinkId('');
    const first = getGlobalAudioContext();
    await first.close();

    expect(getGlobalAudioContext()).not.toBe(first);
  });
});

describe('createGlobalAudioContext', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates the global context with the given options', async () => {
    const { getGlobalAudioContext, createGlobalAudioContext } = await loadWithSinkId('');

    const context = createGlobalAudioContext({ sampleRate: 44_100 });

    expect(context.sampleRate).toBe(44_100);
    expect(getGlobalAudioContext()).toBe(context);
  });

  it('throws while a global context exists', async () => {
    const { getGlobalAudioContext, createGlobalAudioContext } = await loadWithSinkId('');
    getGlobalAudioContext();

    expect(() => createGlobalAudioContext({ sampleRate: 44_100 })).toThrow(
      'A global AudioContext already exists',
    );
  });

  it('replaces a closed global context', async () => {
    const { getGlobalAudioContext, createGlobalAudioContext } = await loadWithSinkId('');
    const previous = getGlobalAudioContext();
    await previous.close();

    const next = createGlobalAudioContext({ sampleRate: 44_100 });

    expect(next).not.toBe(previous);
    expect(getGlobalAudioContext()).toBe(next);
  });

  it('reuses its options when a closed global context is recreated', async () => {
    const { getGlobalAudioContext, createGlobalAudioContext } = await loadWithSinkId('');
    await createGlobalAudioContext({ sampleRate: 44_100 }).close();

    expect(getGlobalAudioContext().sampleRate).toBe(44_100);
  });
});
