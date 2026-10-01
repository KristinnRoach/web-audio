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

describe('configureGlobalAudioContext', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('only stores options before first use', async () => {
    const { getGlobalAudioContext, configureGlobalAudioContext, created } =
      await loadWithSinkId('');

    configureGlobalAudioContext({ sampleRate: 44_100 });

    expect(created).toHaveLength(0);
    expect(getGlobalAudioContext().sampleRate).toBe(44_100);
  });

  it('replaces the global context when options change and closes the previous', async () => {
    const { getGlobalAudioContext, configureGlobalAudioContext } = await loadWithSinkId('');
    const previous = getGlobalAudioContext();

    configureGlobalAudioContext({ sampleRate: 44_100 });
    const next = getGlobalAudioContext();

    expect(next).not.toBe(previous);
    expect(next.sampleRate).toBe(44_100);
    expect(previous.state).toBe('closed');
  });

  it('keeps the global context when options are unchanged', async () => {
    const { getGlobalAudioContext, configureGlobalAudioContext } = await loadWithSinkId('');
    configureGlobalAudioContext({ sampleRate: 44_100 });
    const context = getGlobalAudioContext();

    configureGlobalAudioContext({ sampleRate: 44_100 });

    expect(getGlobalAudioContext()).toBe(context);
    expect(context.state).not.toBe('closed');
  });

  it('reuses its options when a closed global context is recreated', async () => {
    const { getGlobalAudioContext, configureGlobalAudioContext } = await loadWithSinkId('');
    configureGlobalAudioContext({ sampleRate: 44_100 });
    await getGlobalAudioContext().close();

    expect(getGlobalAudioContext().sampleRate).toBe(44_100);
  });
});
