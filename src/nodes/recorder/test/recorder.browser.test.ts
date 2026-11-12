import { afterEach, describe, it, expect, vi } from 'vite-plus/test';
import { Recorder, type RecorderEvents } from '../Recorder';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, timeoutMs = 2000) {
  const end = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > end) throw new Error('Timed out waiting for condition');
    await wait(10);
  }
}

// A take recorded before a fresh context renders audio can be too short to decode.
async function runningContext() {
  const ctx = new AudioContext();
  await until(() => ctx.currentTime > 0.05);
  return ctx;
}

async function setup({ level = 1 } = {}) {
  const ctx = await runningContext();
  const source = new ConstantSourceNode(ctx, { offset: level });
  source.start();
  const recorder = new Recorder(ctx);
  const input = { type: 'audio-node', node: source } as const;
  return { ctx, source, recorder, input };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

function peak(buffer: AudioBuffer) {
  return Math.max(...buffer.getChannelData(0).map(Math.abs));
}

describe('Recorder', () => {
  afterEach(() => vi.restoreAllMocks());

  it('does not arm when disposed while start() is pending', async () => {
    const stop = vi.spyOn(MediaStreamTrack.prototype, 'stop');
    const { ctx, recorder, input } = await setup();
    const states: string[] = [];
    recorder.onMessage('state-change', (msg) => states.push(msg.state));

    const pending = recorder.arm({ input });
    recorder.dispose();
    await pending;

    expect(recorder.state).toBe('IDLE');
    expect(recorder.initialized).toBe(false);
    expect(states).toEqual(['REQUESTING_INPUT']);
    expect(stop).toHaveBeenCalledOnce();
    await expect(recorder.start({ input })).rejects.toThrow('disposed');
    await ctx.close();
  });

  it('start() records immediately and reports each lifecycle state', async () => {
    const { ctx, recorder, input } = await setup();
    const states: string[] = [];
    const events: string[] = [];
    recorder.onMessage('state-change', (msg) => states.push(msg.state));
    recorder.onMessage('record:armed', () => events.push('armed'));
    recorder.onMessage('record:start', () => events.push('start'));
    let delivered: AudioBuffer | undefined;
    recorder.onMessage('record:stop', (msg) => (delivered = msg.buffer));

    await recorder.start({ input });
    expect(recorder.state).toBe('RECORDING');
    const startedAt = ctx.currentTime;
    // A busy CI runner can advance wall time before it has rendered enough audio to decode.
    await until(() => ctx.currentTime - startedAt >= 0.2);
    const buffer = await recorder.stop();

    expect(delivered).toBe(buffer);
    expect(events).toEqual(['start']);
    expect(states).toEqual(['REQUESTING_INPUT', 'RECORDING', 'FINALIZING', 'IDLE']);
    await ctx.close();
  });

  it('arm() waits for the start threshold, then records', async () => {
    const { ctx, source, recorder, input } = await setup({ level: 0 });
    const armed: number[] = [];
    recorder.onMessage('record:armed', (msg) => armed.push(msg.thresholdDb));

    await recorder.arm({ input, startThresholdDb: -20 });
    await wait(100);
    expect(recorder.state).toBe('ARMED');
    expect(armed).toEqual([-20]);

    source.offset.value = 1;
    await until(() => recorder.isRecording);
    await wait(100);
    expect((await recorder.stop())!.duration).toBeGreaterThan(0);
    await ctx.close();
  });

  it('start() while armed records the prepared take, keeping stopOnSilence', async () => {
    const { ctx, source, recorder, input } = await setup({ level: 0 });
    const stops = vi.fn();
    recorder.onMessage('record:stop', stops);

    await recorder.arm({ input, stopOnSilence: { thresholdDb: -50, durationMs: 100 } });
    await recorder.start({ input: { type: 'microphone' } }); // options ignored: shares the take
    expect(recorder.state).toBe('RECORDING');

    // Silence only counts after sound, so the forced take needs some before it can stop.
    source.offset.value = 1;
    await wait(150);
    source.offset.value = 0;
    await until(() => recorder.state === 'IDLE');
    await wait(150);
    expect(stops).toHaveBeenCalledOnce();
    await ctx.close();
  });

  it('stop() resolves null when idle or armed, cancelling the armed take', async () => {
    const { ctx, recorder, input } = await setup({ level: 0 });
    const cancelled = vi.fn();
    recorder.onMessage('record:cancelled', cancelled);

    expect(await recorder.stop()).toBeNull();
    await recorder.arm({ input });
    expect(await recorder.stop()).toBeNull();
    expect(recorder.state).toBe('IDLE');
    expect(cancelled).toHaveBeenCalledOnce();
    await ctx.close();
  });

  it('shares a pending startup and leaves an active take intact', async () => {
    const { ctx, recorder, input } = await setup();
    const starts = vi.fn();
    recorder.onMessage('record:start', starts);

    await Promise.all([recorder.start({ input }), recorder.start({ input })]);
    await recorder.start({ input });
    await recorder.arm({ input });

    expect(recorder.state).toBe('RECORDING');
    expect(starts).toHaveBeenCalledOnce();
    await wait(100);
    await recorder.stop();
    await ctx.close();
  });

  it('cancel during acquisition releases the late input without arming', async () => {
    const ctx = new AudioContext();
    const destination = ctx.createMediaStreamDestination();
    const [track] = destination.stream.getAudioTracks();
    const gum = deferred<MediaStream>();
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, 'getUserMedia')
      .mockReturnValue(gum.promise);
    const recorder = new Recorder(ctx);
    const events = vi.fn();
    recorder.onMessage('record:start', events);
    recorder.onMessage('record:stop', events);

    const pending = recorder.start();
    const shared = recorder.start();
    expect(recorder.state).toBe('REQUESTING_INPUT');
    expect(recorder.cancel()).toBe(true);
    await Promise.all([pending, shared]);
    gum.resolve(destination.stream);
    await until(() => track.readyState === 'ended');

    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(track.readyState).toBe('ended');
    expect(recorder.state).toBe('IDLE');
    expect(events).not.toHaveBeenCalled();
    await ctx.close();
  });

  it('dispose settles startup even while permission is unanswered', async () => {
    const { ctx, recorder } = await setup();
    const gum = deferred<MediaStream>();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockReturnValue(gum.promise);
    const pending = recorder.start();
    recorder.dispose();
    await pending;

    const destination = ctx.createMediaStreamDestination();
    const [track] = destination.stream.getAudioTracks();
    gum.resolve(destination.stream);
    await until(() => track.readyState === 'ended');
    expect(recorder.state).toBe('IDLE');
    await ctx.close();
  });

  it('does not trigger on silence even with a very low start threshold', async () => {
    const { ctx, recorder, input } = await setup({ level: 0 });
    await recorder.arm({ input, startThresholdDb: -160 });
    await wait(100);
    expect(recorder.state).toBe('ARMED');
    recorder.cancel();
    await ctx.close();
  });

  it('ignores replacement options when sharing an active take', async () => {
    const { ctx, recorder, input } = await setup();
    await recorder.start({ input });
    await recorder.start({ mediaRecorderOptions: { mimeType: 'audio/not-a-format' } });
    expect(recorder.state).toBe('RECORDING');
    recorder.cancel();
    await ctx.close();
  });

  it('repeated stop() during finalization shares one result', async () => {
    const { ctx, recorder, input } = await setup();
    const stops = vi.fn();
    let fromStateHandler: Promise<AudioBuffer | null> | undefined;
    recorder.onMessage('state-change', ({ state }) => {
      if (state === 'FINALIZING') fromStateHandler = recorder.stop();
    });
    recorder.onMessage('record:stop', stops);

    await recorder.start({ input });
    await wait(100);
    const first = recorder.stop();
    expect(recorder.state).toBe('FINALIZING');
    expect(fromStateHandler).toBe(first);
    expect(recorder.stop()).toBe(first);
    await first;
    expect(stops).toHaveBeenCalledOnce();
    await ctx.close();
  });

  it('cancel and dispose during finalization resolve stop() with null', async () => {
    for (const end of ['cancel', 'dispose'] as const) {
      const { ctx, recorder, input } = await setup();
      const stops = vi.fn();
      recorder.onMessage('record:stop', stops);

      await recorder.start({ input });
      await wait(100);
      const result = recorder.stop();
      recorder[end]();

      expect(await result).toBeNull();
      expect(stops).not.toHaveBeenCalled();
      expect(recorder.state).toBe('IDLE');
      await ctx.close();
    }
  });

  it('a record:stop handler can start the next take on the same input', async () => {
    const { ctx, recorder, input } = await setup();
    let restarted: Promise<unknown> | undefined;
    recorder.onMessage('record:stop', () => (restarted ??= recorder.start({ input })));

    await recorder.start({ input });
    await wait(100);
    await recorder.stop();
    await restarted;
    expect(recorder.state).toBe('RECORDING');

    await wait(300);
    const second = await recorder.stop();
    expect(peak(second!)).toBeGreaterThan(0.5); // input still connected
    await ctx.close();
  });

  it('cancel and dispose settle stop() without waiting for decoding', async () => {
    for (const end of ['cancel', 'dispose'] as const) {
      const { ctx, recorder, input } = await setup();
      const decoded = deferred<AudioBuffer>();
      const decode = vi.spyOn(ctx, 'decodeAudioData').mockReturnValue(decoded.promise);
      const stops = vi.fn();
      recorder.onMessage('record:stop', stops);
      await recorder.start({ input });
      const result = recorder.stop();
      await until(() => decode.mock.calls.length === 1);
      recorder[end]();
      expect(await result).toBeNull();
      decoded.resolve(ctx.createBuffer(1, 128, ctx.sampleRate));
      await wait(20);
      expect(stops).not.toHaveBeenCalled();
      expect(recorder.state).toBe('IDLE');
      await ctx.close();
    }
  });

  it('does not emit completion after an idle-state handler disposes it', async () => {
    const { ctx, recorder, input } = await setup();
    const stops = vi.fn();
    recorder.onMessage('record:stop', stops);
    recorder.onMessage('state-change', ({ state }) => {
      if (state === 'IDLE') recorder.dispose();
    });
    await recorder.start({ input });
    await wait(100);
    await recorder.stop();
    expect(stops).not.toHaveBeenCalled();
    await ctx.close();
  });

  it('releases input when MediaRecorder.start() fails', async () => {
    const { ctx, recorder, input } = await setup();
    const stop = vi.spyOn(MediaStreamTrack.prototype, 'stop');
    vi.spyOn(MediaRecorder.prototype, 'start').mockImplementationOnce(() => {
      throw new Error('capture failed');
    });
    const errors = vi.fn();
    recorder.onMessage('record:error', errors);
    await expect(recorder.start({ input })).rejects.toThrow('capture failed');
    expect(recorder.state).toBe('IDLE');
    expect(stop).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledOnce();
    await ctx.close();
  });

  it('stopOnSilence completes once during an immediate take', async () => {
    const { ctx, source, recorder, input } = await setup();
    const stops = vi.fn();
    recorder.onMessage('record:stop', stops);

    await recorder.start({ input, stopOnSilence: { thresholdDb: -40, durationMs: 100 } });
    await wait(150);
    source.offset.value = 0;
    await until(() => recorder.state === 'IDLE');
    await wait(200);

    expect(stops).toHaveBeenCalledOnce();
    expect(recorder.initialized).toBe(false);
    await ctx.close();
  });

  it('does not count silence until the take has had sound', async () => {
    const { ctx, source, recorder, input } = await setup({ level: 0 });
    await recorder.start({ input, stopOnSilence: { thresholdDb: -40, durationMs: 100 } });
    await wait(400);
    expect(recorder.isRecording).toBe(true);

    source.offset.value = 1;
    await wait(150);
    source.offset.value = 0;
    await until(() => recorder.state === 'IDLE');
    await ctx.close();
  });

  it('trims the silence wait off a take that stopped on silence', async () => {
    const { ctx, source, recorder, input } = await setup();
    const takes: AudioBuffer[] = [];
    recorder.onMessage('record:stop', ({ buffer }) => takes.push(buffer));
    const record = async (trim: boolean) => {
      source.offset.value = 1;
      await recorder.start({ input, stopOnSilence: { thresholdDb: -40, durationMs: 500, trim } });
      await wait(300);
      source.offset.value = 0;
      await until(() => takes.length === (trim ? 2 : 1));
    };
    await record(false);
    await record(true);

    expect(takes[0].duration - takes[1].duration).toBeGreaterThan(0.3);
    expect(takes[1].duration).toBeGreaterThan(0.2);
    expect(peak(takes[1])).toBeGreaterThan(0.5);
    await ctx.close();
  });

  it('monitors levels without arming, then records the monitored input', async () => {
    const { ctx, recorder, input } = await setup();
    const connect = vi.spyOn(input.node, 'connect');
    const starts = vi.fn();
    const cancels = vi.fn();
    const levels: RecorderEvents['record:level'][] = [];
    recorder.onMessage('record:start', starts);
    recorder.onMessage('record:cancelled', cancels);
    recorder.onMessage('record:level', (level) => levels.push(level));

    await recorder.monitor({ input });
    expect(recorder.state).toBe('MONITORING');
    await until(() => levels.some((l) => l.peakDb > -1));
    await wait(100);
    expect(recorder.isMonitoring).toBe(true);
    expect(starts).not.toHaveBeenCalled();
    expect(levels.at(-1)!.startThresholdDb).toBeNull();

    await recorder.arm({ input, startThresholdDb: -20, metering: true });
    await until(() => recorder.isRecording);
    expect(connect).toHaveBeenCalledOnce();
    await wait(200); // long enough to decode
    const buffer = await recorder.stop();
    expect(peak(buffer!)).toBeGreaterThan(0.5);

    // Ending monitoring discards no take, so nothing is reported as cancelled.
    await recorder.monitor({ input });
    expect(await recorder.stop()).toBeNull();
    expect(recorder.state).toBe('IDLE');
    expect(cancels).not.toHaveBeenCalled();
    await recorder.start({ input });
    await expect(recorder.monitor({ input })).rejects.toThrow('take is active');
    recorder.cancel();
    await ctx.close();
  });

  it('measures the noise floor and suggests thresholds above it', async () => {
    const { ctx, recorder, input } = await setup({ level: 0.01 });
    const measured = await recorder.measureNoiseFloor({ input, durationMs: 200 });
    expect(measured!.noiseFloorDb).toBeCloseTo(-40, 1);
    expect(measured!.startThresholdDb).toBeCloseTo(-28, 1);
    expect(measured!.stopThresholdDb).toBeCloseTo(-34, 1);
    expect(recorder.state).toBe('IDLE');
    expect(recorder.initialized).toBe(false);

    // Already monitoring: measures on the open input and keeps monitoring.
    await recorder.monitor({ input });
    const wider = await recorder.measureNoiseFloor({ durationMs: 100, marginDb: 20 });
    expect(wider!.startThresholdDb).toBeCloseTo(-20, 1);
    expect(recorder.isMonitoring).toBe(true);

    const cancelled = recorder.measureNoiseFloor({ durationMs: 5000 });
    await wait(50);
    recorder.cancel();
    expect(await cancelled).toBeNull();

    await expect(recorder.measureNoiseFloor({ durationMs: 0 })).rejects.toThrow(RangeError);
    await recorder.start({ input });
    await expect(recorder.measureNoiseFloor()).rejects.toThrow('take is active');
    recorder.cancel();
    await ctx.close();
  });

  it.each([0, 0.01])('ignores one click among 20 noise readings at %s', async (level) => {
    const { ctx, recorder, input } = await setup();
    let time = 0;
    let readings = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    vi.spyOn(AnalyserNode.prototype, 'getFloatTimeDomainData').mockImplementation((data) => {
      readings++;
      data.fill(readings === 20 ? 1 : level);
      time += 20;
    });
    const measured = await recorder.measureNoiseFloor({ input, durationMs: 400 });
    expect(readings).toBe(20);
    expect(measured!.noiseFloorDb).toBe(
      level === 0 ? -Infinity : 20 * Math.log10(Math.fround(level)),
    );
    expect(recorder.state).toBe('IDLE');
    await ctx.close();
  });

  it.each([
    [false, false],
    [false, true],
    [true, false],
    [true, true],
  ])(
    'replacement releases input (different input: %s, sampling started: %s)',
    async (differentInput, samplingStarted) => {
      const { ctx, recorder, input } = await setup({ level: 0.01 });
      const stop = vi.spyOn(MediaStreamTrack.prototype, 'stop');
      const other = new ConstantSourceNode(ctx, { offset: 0.02 });
      other.start();
      const replacement = differentInput ? ({ type: 'audio-node', node: other } as const) : input;
      const first = recorder.measureNoiseFloor({ input, durationMs: 5000 });
      if (samplingStarted) await wait(80);
      const second = recorder.measureNoiseFloor({ input: replacement, durationMs: 100 });
      expect(await first).toBeNull();
      expect((await second)!.noiseFloorDb).toBeCloseTo(differentInput ? -33.98 : -40, 1);
      expect(recorder.state).toBe('IDLE');
      expect(stop).toHaveBeenCalledTimes(differentInput ? 2 : 1);
      await ctx.close();
    },
  );

  it('does not let completed calibration cancel a replacement from a level handler', async () => {
    const { ctx, recorder, input } = await setup();
    let time = 0;
    let readings = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time);
    vi.spyOn(AnalyserNode.prototype, 'getFloatTimeDomainData').mockImplementation((data) => {
      data.fill(0.01);
      time += 20;
    });
    let replacement: ReturnType<Recorder['measureNoiseFloor']> | undefined;
    recorder.onMessage('record:level', () => {
      if (++readings === 5) replacement = recorder.measureNoiseFloor({ durationMs: 100 });
    });

    expect(await recorder.measureNoiseFloor({ input, durationMs: 100 })).not.toBeNull();
    expect(replacement).toBeDefined();
    expect(await replacement).not.toBeNull();
    expect(readings).toBe(10);
    expect(recorder.state).toBe('IDLE');
    await ctx.close();
  });

  it('keeps monitoring explicitly requested while calibration is starting', async () => {
    const { ctx, recorder, input } = await setup({ level: 0.01 });
    const measurement = recorder.measureNoiseFloor({ input, durationMs: 100 });
    await recorder.monitor();
    expect(await measurement).not.toBeNull();
    expect(recorder.isMonitoring).toBe(true);
    recorder.cancel();
    await ctx.close();
  });

  it('does not attach a cancelled measurement to new monitoring', async () => {
    const { ctx, recorder, input } = await setup();
    await recorder.monitor({ input });
    const measurement = recorder.measureNoiseFloor({ durationMs: 40 });
    recorder.cancel();
    await recorder.monitor({ input });
    expect(await measurement).toBeNull();
    await wait(80);
    expect(recorder.isMonitoring).toBe(true);
    recorder.cancel();
    await ctx.close();
  });

  it('suggests the most sensitive threshold for digital silence', async () => {
    const { ctx, recorder, input } = await setup({ level: 0 });
    const measured = await recorder.measureNoiseFloor({ input, durationMs: 100 });
    expect(measured).toEqual({
      noiseFloorDb: -Infinity,
      startThresholdDb: -60,
      stopThresholdDb: -66,
    });
    await ctx.close();
  });

  it('stopOnSilence: true waits for 600 ms of continuous silence', async () => {
    const { ctx, source, recorder, input } = await setup();
    const levels: RecorderEvents['record:level'][] = [];
    const stops = vi.fn();
    recorder.onMessage('record:level', (level) => levels.push(level));
    recorder.onMessage('record:stop', stops);
    await recorder.start({ input, stopOnSilence: true, metering: true });
    await until(() => levels.some((l) => l.peakDb > -1));
    expect(levels.at(-1)!.stopThresholdDb).toBe(-36);

    source.offset.value = 0;
    await until(() => levels.at(-1)!.peakDb === -Infinity);
    await wait(300);
    expect(recorder.isRecording).toBe(true);
    // Sound returning resets the continuous-silence wait.
    source.offset.value = 1;
    await until(() => levels.at(-1)!.peakDb > -1);
    source.offset.value = 0;
    await until(() => levels.at(-1)!.peakDb === -Infinity);
    const silentAt = performance.now();
    await wait(400);
    expect(recorder.isRecording).toBe(true);
    await until(() => recorder.state === 'IDLE');
    expect(performance.now() - silentAt).toBeGreaterThanOrEqual(570);
    expect(stops).toHaveBeenCalledOnce();
    await ctx.close();
  });

  it('meters known levels and adjusts both derived thresholds without reacquiring input', async () => {
    const { ctx, recorder, input } = await setup({ level: 0.01 });
    const analyser = vi.spyOn(ctx, 'createAnalyser');
    const connect = vi.spyOn(input.node, 'connect');
    const levels: RecorderEvents['record:level'][] = [];
    recorder.onMessage('record:level', (level) => levels.push(level));
    await recorder.arm({
      input,
      startThresholdDb: -20,
      stopOnSilence: { durationMs: 100 },
      metering: true,
    });
    await until(() => Math.abs((levels.at(-1)?.rmsDb ?? 0) + 40) < 0.1);
    expect(levels.at(-1)!.peakDb).toBeCloseTo(-40, 1);
    expect(levels.at(-1)!.stopThresholdDb).toBe(-26);

    recorder.setStartThresholdDb(-30);
    await until(() => levels.at(-1)!.startThresholdDb === -30);
    expect(levels.at(-1)!.stopThresholdDb).toBe(-36);
    expect(recorder.isArmed).toBe(true);
    expect(() => recorder.setStartThresholdDb(NaN)).toThrow(RangeError);
    recorder.setStartThresholdDb(-45);
    await until(() => recorder.isRecording);
    expect(analyser).toHaveBeenCalledOnce();
    expect(connect).toHaveBeenCalledOnce();
    recorder.cancel();
    const count = levels.length;
    await wait(80);
    expect(levels).toHaveLength(count);
    await ctx.close();
  });

  it('keeps an explicit stop threshold fixed when sensitivity changes', async () => {
    const { ctx, recorder, input } = await setup({ level: 0 });
    const levels: RecorderEvents['record:level'][] = [];
    recorder.onMessage('record:level', (level) => levels.push(level));
    await recorder.arm({ input, stopOnSilence: { thresholdDb: -50 }, metering: true });
    recorder.setStartThresholdDb(-40);
    expect(() => recorder.setStartThresholdDb(-55)).toThrow(RangeError);
    await until(() => levels.length > 0);
    expect(levels.at(-1)!.startThresholdDb).toBe(-40);
    expect(levels.at(-1)!.stopThresholdDb).toBe(-50);
    recorder.dispose();
    const count = levels.length;
    await wait(80);
    expect(levels).toHaveLength(count);
    expect(() => recorder.setStartThresholdDb(-30)).toThrow('waiting for sound');
    await ctx.close();
  });

  it('adjusts sensitivity while input is pending', async () => {
    const { ctx, source, recorder } = await setup({ level: 0.01 });
    const destination = ctx.createMediaStreamDestination();
    source.connect(destination);
    const gum = deferred<MediaStream>();
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockReturnValue(gum.promise);
    const pending = recorder.arm({ startThresholdDb: -20 });
    recorder.setStartThresholdDb(-45);
    gum.resolve(destination.stream);
    await pending;
    await until(() => recorder.isRecording);
    recorder.cancel();
    await ctx.close();
  });

  it('metering is opt-in and works without silence stopping', async () => {
    const { ctx, recorder, input } = await setup({ level: 0.25 });
    const analyser = vi.spyOn(ctx, 'createAnalyser');
    const levels: RecorderEvents['record:level'][] = [];
    recorder.onMessage('record:level', (level) => levels.push(level));
    await recorder.start({ input, stopOnSilence: false });
    await wait(80);
    expect(levels).toHaveLength(0);
    expect(analyser).not.toHaveBeenCalled();
    recorder.cancel();

    await recorder.start({ input, metering: true });
    await until(() => Math.abs((levels.at(-1)?.rmsDb ?? 0) + 12.0412) < 0.1);
    expect(levels.at(-1)!.peakDb).toBeCloseTo(-12.0412, 1);
    expect(levels.at(-1)!.stopThresholdDb).toBeNull();
    await recorder.stop();
    const count = levels.length;
    await wait(80);
    expect(levels).toHaveLength(count);
    await ctx.close();
  });

  it('a meter handler can cancel before sound triggers recording', async () => {
    const { ctx, recorder, input } = await setup();
    const starts = vi.fn();
    recorder.onMessage('record:start', starts);
    recorder.onMessage('record:level', () => recorder.cancel());
    await recorder.arm({ input, metering: true });
    await until(() => recorder.state === 'IDLE');
    expect(starts).not.toHaveBeenCalled();
    await ctx.close();
  });

  it('cleans up and reports a decode failure', async () => {
    const stop = vi.spyOn(MediaStreamTrack.prototype, 'stop');
    const { ctx, recorder, input } = await setup();
    vi.spyOn(ctx, 'decodeAudioData').mockRejectedValue(new Error('bad data'));
    const errors = vi.fn();
    recorder.onMessage('record:error', errors);

    await recorder.start({ input });
    await wait(50);
    await expect(recorder.stop()).rejects.toThrow('bad data');

    expect(recorder.state).toBe('IDLE');
    expect(stop).toHaveBeenCalled();
    expect(errors).toHaveBeenCalledOnce();
    await ctx.close();
  });

  it('rejects and returns to idle when input acquisition fails', async () => {
    vi.spyOn(navigator.mediaDevices, 'getUserMedia').mockRejectedValue(
      new DOMException('denied', 'NotAllowedError'),
    );
    const ctx = new AudioContext();
    const recorder = new Recorder(ctx);
    const errors = vi.fn();
    recorder.onMessage('record:error', errors);

    await expect(recorder.start()).rejects.toThrow('denied');
    expect(recorder.state).toBe('IDLE');
    expect(errors).toHaveBeenCalledOnce();
    await ctx.close();
  });

  it('finalizes when the input track ends mid-take', async () => {
    const ctx = await runningContext();
    const source = new ConstantSourceNode(ctx);
    source.start();
    const destination = ctx.createMediaStreamDestination();
    source.connect(destination);
    const [track] = destination.stream.getAudioTracks();
    const recorder = new Recorder(ctx);
    const stops = vi.fn();
    recorder.onMessage('record:stop', stops);

    await recorder.start({ input: { type: 'stream', stream: destination.stream } });
    await wait(100);
    // stop() ends the track without firing 'ended' (that only happens when the source ends it).
    track.stop();
    track.dispatchEvent(new Event('ended'));
    await until(() => recorder.state === 'IDLE');
    expect(stops).toHaveBeenCalledOnce();
    await ctx.close();
  });

  it('leaves the tracks of a supplied stream running', async () => {
    const { ctx, source } = await setup();
    const destination = ctx.createMediaStreamDestination();
    source.connect(destination);
    const [track] = destination.stream.getAudioTracks();
    const recorder = new Recorder(ctx);

    await recorder.start({ input: { type: 'stream', stream: destination.stream } });
    await wait(100);
    expect(await recorder.stop()).not.toBeNull();
    await recorder.arm({ input: { type: 'stream', stream: destination.stream } });
    recorder.cancel();

    expect(track.readyState).toBe('live');
    await ctx.close();
  });

  it.each([
    {
      options: undefined,
      expected: {
        audio: true,
        video: true,
        audioSelection: 'preferred',
        systemAudio: 'include',
        windowAudio: 'window',
      },
    },
    {
      options: {
        preferCurrentTab: true,
        video: { displaySurface: 'browser' },
        audio: { suppressLocalAudioPlayback: false },
        systemAudio: 'exclude',
        windowAudio: 'exclude',
      } as const,
      expected: {
        preferCurrentTab: true,
        video: { displaySurface: 'browser' },
        audio: { suppressLocalAudioPlayback: false },
        audioSelection: 'preferred',
        systemAudio: 'exclude',
        windowAudio: 'exclude',
      },
    },
  ])('requests display audio with native options: $options', async ({ options, expected }) => {
    const { ctx, source, recorder } = await setup();
    const destination = ctx.createMediaStreamDestination();
    source.connect(destination);
    const [audioTrack] = destination.stream.getAudioTracks();
    const [videoTrack] = document.createElement('canvas').captureStream().getVideoTracks();
    const display = new MediaStream([audioTrack, videoTrack]);
    const capture = vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(display);

    await recorder.monitor({ input: { type: 'display', options } });
    expect(capture).toHaveBeenCalledExactlyOnceWith(expected);
    expect(videoTrack.readyState).toBe('ended');
    expect(audioTrack.readyState).toBe('live');
    recorder.cancel();
    expect(audioTrack.readyState).toBe('ended');
    await ctx.close();
  });

  it('rejects display capture without audio and stops its tracks', async () => {
    const video = document.createElement('canvas').captureStream();
    const [videoTrack] = video.getVideoTracks();
    vi.spyOn(navigator.mediaDevices, 'getDisplayMedia').mockResolvedValue(video);
    const ctx = new AudioContext();
    const recorder = new Recorder(ctx);

    await expect(recorder.start({ input: { type: 'display' } })).rejects.toThrow('no audio track');
    expect(videoTrack.readyState).toBe('ended');
    expect(recorder.state).toBe('IDLE');
    await ctx.close();
  });

  it('rejects invalid options before acquiring input', async () => {
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const { ctx, recorder, input } = await setup();
    const other = new AudioContext();

    await expect(recorder.arm({ startThresholdDb: NaN })).rejects.toThrow(RangeError);
    await expect(recorder.arm({ startThresholdDb: 6 })).rejects.toThrow(RangeError);
    await expect(
      recorder.start({ stopOnSilence: { thresholdDb: -40, durationMs: Infinity } }),
    ).rejects.toThrow(RangeError);
    await expect(
      recorder.arm({ startThresholdDb: -40, stopOnSilence: { thresholdDb: -30, durationMs: 500 } }),
    ).rejects.toThrow('must be below startThresholdDb');
    await expect(
      recorder.start({ mediaRecorderOptions: { mimeType: 'audio/not-a-format' } }),
    ).rejects.toThrow('does not support');
    await expect(
      recorder.start({ input: { type: 'audio-node', node: other.createGain() } }),
    ).rejects.toThrow('different AudioContext');
    await expect(
      recorder.start({ input: { type: 'stream', stream: new MediaStream() } }),
    ).rejects.toThrow('no live audio track');

    expect(getUserMedia).not.toHaveBeenCalled();
    expect(recorder.state).toBe('IDLE');

    await recorder.start({ input }); // still usable after rejected options
    expect(recorder.state).toBe('RECORDING');
    recorder.cancel();
    await other.close();
    await ctx.close();
  });

  it('does not request the microphone when disposed while resuming', async () => {
    const getUserMedia = vi.spyOn(navigator.mediaDevices, 'getUserMedia');
    const ctx = new AudioContext();
    await ctx.suspend();
    const recorder = new Recorder(ctx);

    const pending = recorder.start();
    recorder.dispose();
    await pending;

    expect(getUserMedia).not.toHaveBeenCalled();
    await ctx.close();
  });
});
