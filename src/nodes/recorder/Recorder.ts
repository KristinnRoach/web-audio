import { LibNode } from '@/nodes/LibNode';
import { NodeID, registerNode, unregisterNode } from '@/nodes/node-store';

import { Message, MessageBus, MessageHandler, createMessageBus } from '@/events';

import { MUSIC_MIC_CONSTRAINTS, getMicrophone } from '@/io/devices/devices';

export const AudioRecorderState = {
  IDLE: 'IDLE',
  REQUESTING_INPUT: 'REQUESTING_INPUT',
  MONITORING: 'MONITORING',
  ARMED: 'ARMED',
  RECORDING: 'RECORDING',
  FINALIZING: 'FINALIZING',
} as const;

export type AudioRecorderState = (typeof AudioRecorderState)[keyof typeof AudioRecorderState];

export type RecorderInput =
  | { type: 'microphone'; deviceId?: string; constraints?: MediaTrackConstraints }
  | { type: 'display' }
  | { type: 'audio-node'; node: AudioNode }
  /** The caller owns the stream: the recorder never stops its tracks. */
  | { type: 'stream'; stream: MediaStream };

export type RecorderStartOptions = {
  /** Defaults to the microphone. */
  input?: RecorderInput;
  /**
   * Stop after continuous silence, including that wait in the buffer. `true` or
   * `{}` defaults to 6 dB below the start threshold and a 600 ms wait. Silence
   * only counts once the take has had sound. `trim` cuts the wait off the end of
   * a take that stopped on silence.
   */
  stopOnSilence?: boolean | { thresholdDb?: number; durationMs?: number; trim?: boolean };
  /** Emit record:level readings while armed or recording, using the detection analyser. */
  metering?: boolean;
  /** Passed to `MediaRecorder`. Without a `mimeType` the browser picks the format. */
  mediaRecorderOptions?: MediaRecorderOptions;
};

export type RecorderArmOptions = RecorderStartOptions & {
  /** Peak level that starts the take. Defaults to -30 dB, or -60 dB for display input. */
  startThresholdDb?: number;
};

export type RecorderMonitorOptions = {
  /** Defaults to the microphone. */
  input?: RecorderInput;
};

export type RecorderNoiseOptions = RecorderMonitorOptions & {
  /** How long to listen. Defaults to 800 ms. */
  durationMs?: number;
  /** How far above the noise floor to suggest the start threshold. Defaults to 12 dB. */
  marginDb?: number;
};

export type RecorderNoiseMeasurement = {
  /** 95th percentile of the sampled peaks in dBFS; -Infinity for digital silence. */
  noiseFloorDb: number;
  /** `noiseFloorDb + marginDb`, kept within -60..0 dB. */
  startThresholdDb: number;
  /** 6 dB below `startThresholdDb`, matching the `stopOnSilence` default. */
  stopThresholdDb: number;
};

type RecordEvents = {
  'record:armed': { thresholdDb: number };
  'record:start': {};
  'record:stop': { duration: number; buffer: AudioBuffer };
  'record:cancelled': {};
  'record:error': { error: unknown };
};

export type RecorderEvents = RecordEvents & {
  'state-change': { state: AudioRecorderState; previousState: AudioRecorderState };
  /** Sampled input levels in dBFS; digital silence is -Infinity. Timers may be throttled. */
  'record:level': {
    peakDb: number;
    rmsDb: number;
    /** `null` while monitoring, which has no thresholds. */
    startThresholdDb: number | null;
    stopThresholdDb: number | null;
  };
};

type TakeOptions = Omit<RecorderStartOptions, 'input' | 'stopOnSilence'> & {
  input: RecorderInput;
  startThresholdDb: number;
  stopOnSilence?: { thresholdDb: number; durationMs: number; trim: boolean };
  stopThresholdDerived: boolean;
};

type Measure = {
  peaks: number[];
  endsAt: number;
  marginDb: number;
  keepMonitoring: boolean;
  resolve: (measurement: RecorderNoiseMeasurement | null) => void;
};

// Everything one take owns, so async work from an old take can't touch a newer one.
type Take = {
  options: TakeOptions;
  armed: boolean;
  /** Holds input for metering only, until start() or arm() turns it into a real take. */
  monitorOnly: boolean;
  measure?: Measure;
  /** Set when the take stops on silence with `trim`. */
  trimSeconds?: number;
  ready: Promise<void>;
  cancelled: Promise<void>;
  cancel: () => void;
  stream?: MediaStream;
  recorder?: MediaRecorder;
  chunks: Blob[];
  stopped?: Promise<void>;
  result?: Promise<AudioBuffer | null>;
  error?: unknown;
  monitoring: boolean;
  cleanup: (() => void)[];
};

const { IDLE, REQUESTING_INPUT, MONITORING, ARMED, RECORDING, FINALIZING } = AudioRecorderState;

// Audio kept after the last sound when trimming, so the cut doesn't land on the tail.
const TRIM_KEEP_SECONDS = 0.05;

function assertDb(name: string, value: number): void {
  if (!Number.isFinite(value) || value > 0) {
    throw new RangeError(`${name} must be a finite dB value <= 0, got ${value}`);
  }
}

function suggestThresholds(peaksDb: number[], marginDb: number): RecorderNoiseMeasurement {
  const sorted = peaksDb.filter((db) => db < Infinity).sort((a, b) => a - b);
  // 95th percentile: a single click doesn't set the floor, steady hum does.
  const noiseFloorDb = sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1] : -Infinity;
  const startThresholdDb = Math.min(0, Math.max(-60, noiseFloorDb + marginDb));
  return { noiseFloorDb, startThresholdDb, stopThresholdDb: startThresholdDb - 6 };
}

export class Recorder implements LibNode {
  readonly nodeId: NodeID;
  readonly nodeType = 'recorder';

  #context: AudioContext;
  #messages: MessageBus<Message>;
  #state: AudioRecorderState = IDLE;
  #take: Take | null = null;
  #disposed = false;

  constructor(context: AudioContext) {
    this.nodeId = registerNode(this.nodeType, this);
    this.#context = context;
    this.#messages = createMessageBus<Message>(this.nodeId);
  }

  /**
   * Records right away. While armed, starts the armed take now. While a take is
   * starting or recording, shares it and ignores `options`. While monitoring,
   * records the monitored input unless `options.input` names another.
   */
  start(options: RecorderStartOptions = {}): Promise<this> {
    return this.#begin(options, 'start');
  }

  /**
   * Acquires input and waits for its peak to reach `startThresholdDb` before
   * recording. While monitoring, arms the monitored input unless `options.input`
   * names another.
   */
  arm(options: RecorderArmOptions = {}): Promise<this> {
    return this.#begin(options, 'arm');
  }

  /**
   * Opens input and emits record:level without arming, so a threshold can be set
   * against a live meter with no risk of starting a take. Ends with `cancel()`,
   * or when a take that started from it finishes.
   */
  monitor(options: RecorderMonitorOptions = {}): Promise<this> {
    return this.#begin(options, 'monitor');
  }

  /**
   * Listens to the input and suggests thresholds above its noise floor. Nothing is
   * applied: pass the result to `arm()`. Opens input for the measurement when idle
   * and keeps monitoring when already monitoring. Resolves `null` if cancelled or
   * if a take starts meanwhile; rejects while a take is active.
   */
  async measureNoiseFloor(
    options: RecorderNoiseOptions = {},
  ): Promise<RecorderNoiseMeasurement | null> {
    const { durationMs = 800, marginDb = 12 } = options;
    if (!Number.isFinite(durationMs) || durationMs <= 0) {
      throw new RangeError(`durationMs must be a finite number > 0, got ${durationMs}`);
    }
    if (!Number.isFinite(marginDb) || marginDb < 0) {
      throw new RangeError(`marginDb must be a finite number >= 0, got ${marginDb}`);
    }
    if (this.#take && !this.#take.monitorOnly) {
      throw new Error('Cannot measure noise while a take is active');
    }
    const wasMonitoring = this.#take?.measure?.keepMonitoring ?? this.#take?.monitorOnly === true;
    const ready = this.#begin({ input: options.input }, 'monitor');
    const take = this.#take;
    await ready;
    if (take !== this.#take || !take?.monitorOnly || this.#state !== MONITORING) return null;

    const keepMonitoring = take.measure?.keepMonitoring ?? wasMonitoring;
    take.measure?.resolve(null);
    const measurement = await new Promise<RecorderNoiseMeasurement | null>((resolve) => {
      take.measure = {
        peaks: [],
        endsAt: performance.now() + durationMs,
        marginDb,
        keepMonitoring,
        resolve,
      };
    });
    if (measurement && !keepMonitoring && take === this.#take && take.monitorOnly) this.cancel();
    return measurement;
  }

  /**
   * Adjusts a pending/armed take without reacquiring input. A derived silence
   * threshold follows 6 dB below; an explicit one stays fixed and must remain lower.
   */
  setStartThresholdDb(thresholdDb: number): this {
    const take = this.#take;
    if (!take || !take.armed || (this.#state !== ARMED && this.#state !== REQUESTING_INPUT)) {
      throw new Error('Start threshold can only be changed while waiting for sound');
    }
    assertDb('startThresholdDb', thresholdDb);
    const silence = take.options.stopOnSilence;
    if (silence && !take.options.stopThresholdDerived && silence.thresholdDb >= thresholdDb) {
      throw new RangeError('stopOnSilence.thresholdDb must be below startThresholdDb');
    }
    take.options.startThresholdDb = thresholdDb;
    if (silence && take.options.stopThresholdDerived) silence.thresholdDb = thresholdDb - 6;
    return this;
  }

  async #begin(options: RecorderArmOptions, mode: 'start' | 'arm' | 'monitor'): Promise<this> {
    if (this.#disposed) throw new Error('Recorder is disposed');
    const armed = mode === 'arm';
    const current = this.#take;
    if (current?.monitorOnly && options.input && options.input !== current.options.input) {
      // A different input was asked for: drop the monitored one and start over.
      current.cancel();
      this.#end(current);
    } else if (current?.monitorOnly && mode !== 'monitor') {
      // Keep the monitored input, so the take starts without reacquiring it.
      current.options = this.#resolveOptions({ ...options, input: current.options.input }, armed);
      current.armed = armed;
      current.monitorOnly = false;
      current.measure?.resolve(null);
      current.measure = undefined;
      if (this.#state === MONITORING) {
        try {
          this.#prepare(current);
        } catch (error) {
          this.#fail(current, error);
          throw error;
        }
      }
      await current.ready;
      return this;
    } else if (current) {
      if (this.#state === FINALIZING) {
        await current.result!.catch(() => {});
        return this.#begin(options, mode);
      }
      if (mode === 'monitor') {
        if (!current.monitorOnly) throw new Error('Cannot monitor while a take is active');
      } else if (!armed) {
        current.armed = false;
        if (this.#state === ARMED) this.#recordOrFail(current);
      }
      await current.ready;
      return this;
    }

    const resolved =
      mode === 'monitor'
        ? this.#resolveOptions({ input: options.input, metering: true }, false)
        : this.#resolveOptions(options, armed);
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => (cancel = resolve));
    const take: Take = {
      options: resolved,
      armed,
      monitorOnly: mode === 'monitor',
      ready: Promise.resolve(),
      cancelled,
      cancel,
      chunks: [],
      monitoring: false,
      cleanup: [],
    };
    this.#take = take;
    // Assign ready before announcing, so a handler's start() shares the real startup.
    // #open can't change state synchronously; it awaits input first.
    take.ready = Promise.race([this.#open(take), cancelled]);
    this.#setState(REQUESTING_INPUT);
    await take.ready;
    return this;
  }

  #resolveOptions(options: RecorderArmOptions, armed: boolean): TakeOptions {
    const { input = { type: 'microphone' }, mediaRecorderOptions } = options;
    const startThresholdDb = options.startThresholdDb ?? (input.type === 'display' ? -60 : -30);
    const silence = options.stopOnSilence;
    const stopOnSilence = silence
      ? {
          thresholdDb:
            (typeof silence === 'object' ? silence.thresholdDb : undefined) ?? startThresholdDb - 6,
          durationMs: (typeof silence === 'object' ? silence.durationMs : undefined) ?? 600,
          trim: typeof silence === 'object' && !!silence.trim,
        }
      : undefined;

    if (armed) assertDb('startThresholdDb', startThresholdDb);
    if (stopOnSilence) {
      assertDb('stopOnSilence.thresholdDb', stopOnSilence.thresholdDb);
      const { durationMs } = stopOnSilence;
      if (!Number.isFinite(durationMs) || durationMs <= 0) {
        throw new RangeError(
          `stopOnSilence.durationMs must be a finite number > 0, got ${durationMs}`,
        );
      }
      if (armed && stopOnSilence.thresholdDb >= startThresholdDb) {
        throw new RangeError(
          `stopOnSilence.thresholdDb (${stopOnSilence.thresholdDb}) must be below startThresholdDb (${startThresholdDb})`,
        );
      }
    }

    const mimeType = mediaRecorderOptions?.mimeType;
    if (mimeType && !MediaRecorder.isTypeSupported(mimeType)) {
      throw new DOMException(`MediaRecorder does not support ${mimeType}`, 'NotSupportedError');
    }

    if (input.type === 'audio-node' && input.node.context !== this.#context) {
      throw new Error("audio-node input belongs to a different AudioContext than the recorder's");
    }
    if (
      input.type === 'stream' &&
      !input.stream.getAudioTracks().some((t) => t.readyState === 'live')
    ) {
      throw new Error('stream input has no live audio track');
    }

    return {
      ...options,
      input,
      startThresholdDb,
      stopOnSilence,
      stopThresholdDerived: !!silence && (silence === true || silence.thresholdDb === undefined),
    };
  }

  async #open(take: Take): Promise<void> {
    try {
      if (this.#context.state === 'suspended') await this.#context.resume();
      if (take !== this.#take) return; // cancelled or disposed: don't prompt for input

      const stream = await this.#acquire(take);
      // Cancelled or disposed while acquiring: release the late input instead of arming.
      if (take !== this.#take) return this.#release(take);

      take.stream = stream;
      const ended = new AbortController();
      take.cleanup.push(() => ended.abort());
      stream
        .getTracks()
        .forEach((track) =>
          track.addEventListener('ended', () => this.#onInputEnded(take), { signal: ended.signal }),
        );

      if (take.monitorOnly) {
        this.#monitor(take);
        this.#setState(MONITORING);
        return;
      }
      this.#prepare(take);
    } catch (error) {
      if (take !== this.#take) return this.#release(take);
      this.#fail(take, error);
      throw error;
    }
  }

  // Input is open: create the take's MediaRecorder, then record or wait for sound.
  #prepare(take: Take): void {
    const recorder = new MediaRecorder(take.stream!, take.options.mediaRecorderOptions);
    take.recorder = recorder;
    recorder.addEventListener('dataavailable', (e) => take.chunks.push(e.data));
    recorder.addEventListener('error', (e) => {
      take.error = (e as ErrorEvent).error ?? new Error('MediaRecorder error');
      if (take === this.#take && !take.result) this.#fail(take, take.error);
    });

    if (!take.armed) return this.#record(take);

    this.#monitor(take);
    this.#setState(ARMED);
    if (take === this.#take && this.#state === ARMED) {
      this.sendMessage('record:armed', { thresholdDb: take.options.startThresholdDb });
    }
  }

  // Registers cleanup as soon as each resource exists, so a failure or cancel mid-way releases it.
  async #acquire(take: Take): Promise<MediaStream> {
    const { input } = take.options;
    switch (input.type) {
      case 'audio-node': {
        const destination = this.#context.createMediaStreamDestination();
        input.node.connect(destination);
        take.cleanup.push(() => {
          destination.stream.getTracks().forEach((t) => t.stop());
          try {
            input.node.disconnect(destination);
          } catch {
            // Already disconnected by the caller.
          }
        });
        return destination.stream;
      }
      case 'stream':
        // Same track objects, minus any video; the caller keeps ownership.
        return new MediaStream(input.stream.getAudioTracks());
      case 'display': {
        // Browsers require video to be requested along with display audio.
        const display = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true });
        display.getVideoTracks().forEach((t) => t.stop());
        const tracks = display.getAudioTracks();
        take.cleanup.push(() => tracks.forEach((t) => t.stop()));
        if (!tracks.length) {
          throw new Error('Display capture has no audio track. Share a tab or screen with audio.');
        }
        return new MediaStream(tracks);
      }
      default: {
        const stream = await getMicrophone(
          { ...MUSIC_MIC_CONSTRAINTS, ...input.constraints },
          input.deviceId,
        );
        take.cleanup.push(() => stream.getTracks().forEach((t) => t.stop()));
        return stream;
      }
    }
  }

  #record(take: Take): void {
    const recorder = take.recorder!;
    take.stopped = new Promise((resolve) =>
      recorder.addEventListener(
        'stop',
        () => {
          resolve();
          // Stopped without stop(), e.g. every input track ended: finalize what was captured.
          if (take === this.#take && !take.result) this.stop().catch(() => {});
        },
        { once: true },
      ),
    );
    recorder.start();
    if (take.options.stopOnSilence || take.options.metering) this.#monitor(take);
    this.#setState(RECORDING);
    if (take === this.#take && this.#state === RECORDING) this.sendMessage('record:start', {});
  }

  #recordOrFail(take: Take): void {
    try {
      this.#record(take);
    } catch (error) {
      this.#fail(take, error);
      throw error;
    }
  }

  // One loop per take: handles metering, the arm trigger, then silence, without restarting.
  #monitor(take: Take): void {
    if (take.monitoring) return;
    take.monitoring = true;

    const source = this.#context.createMediaStreamSource(take.stream!);
    const analyser = this.#context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let silentSince: number | null = null;
    let heardSound = false;

    // shortcut: background tabs throttle this timer; audio-timeline detection is tracked in #166.
    const interval = setInterval(() => {
      const state = this.#state;
      if (take !== this.#take) return;
      if (state !== MONITORING && state !== ARMED && state !== RECORDING) return;
      analyser.getFloatTimeDomainData(data);
      let peak = 0;
      let sumSquares = 0;
      for (const sample of data) {
        peak = Math.max(peak, Math.abs(sample));
        sumSquares += sample * sample;
      }
      const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;
      const measure = take.measure;
      if (measure) {
        measure.peaks.push(peakDb);
        if (performance.now() >= measure.endsAt) {
          take.measure = undefined;
          measure.resolve(suggestThresholds(measure.peaks, measure.marginDb));
        }
      }
      if (take.options.metering) {
        this.#messages.sendMessage('record:level', {
          peakDb,
          rmsDb: sumSquares > 0 ? 10 * Math.log10(sumSquares / data.length) : -Infinity,
          startThresholdDb: take.monitorOnly ? null : take.options.startThresholdDb,
          stopThresholdDb: take.options.stopOnSilence?.thresholdDb ?? null,
        });
        // A UI handler may cancel, dispose, or start a new take.
        if (take !== this.#take) return;
      }

      if (this.#state === ARMED) {
        if (peakDb >= take.options.startThresholdDb) {
          heardSound = true;
          try {
            this.#recordOrFail(take);
          } catch {
            // Reported through record:error.
          }
        }
        return;
      }

      const silence = take.options.stopOnSilence;
      if (this.#state !== RECORDING || !silence) return;
      const now = performance.now();
      if (peakDb >= silence.thresholdDb) {
        silentSince = null;
        heardSound = true;
      } else if (!heardSound) {
        // Silence before the first sound doesn't end a take that has nothing in it yet.
      } else if (silentSince === null) {
        silentSince = now;
      } else if (now - silentSince >= silence.durationMs) {
        if (silence.trim) take.trimSeconds = (now - silentSince) / 1000 - TRIM_KEEP_SECONDS;
        this.stop().catch(() => {}); // failures are reported through record:error
      }
    }, 20);

    take.cleanup.push(() => {
      clearInterval(interval);
      source.disconnect();
      analyser.disconnect();
    });
  }

  #onInputEnded(take: Take): void {
    if (take !== this.#take) return;
    if (!take.stream!.getTracks().every((t) => t.readyState === 'ended')) return;
    if (this.#state === RECORDING) this.stop().catch(() => {});
    else if (this.#state === ARMED || this.#state === MONITORING) {
      this.#fail(take, new Error('Recorder input ended'));
    }
  }

  /**
   * Finishes the take and resolves with its audio. Resolves `null` when idle, or
   * when monitoring, armed or still requesting input, which cancels. Calls while
   * finalizing share the same result.
   */
  stop(): Promise<AudioBuffer | null> {
    const take = this.#take;
    if (!take) return Promise.resolve(null);
    if (take.result) return take.result;
    if (this.#state !== RECORDING) {
      this.cancel();
      return Promise.resolve(null);
    }
    // Publish the result before state handlers can re-enter stop() or cancel().
    take.result = Promise.race([
      Promise.resolve().then(() => this.#finalize(take)),
      take.cancelled.then(() => null),
    ]);
    this.#setState(FINALIZING);
    return take.result;
  }

  async #finalize(take: Take): Promise<AudioBuffer | null> {
    if (take !== this.#take) return null;
    let buffer: AudioBuffer;
    try {
      if (take.recorder!.state !== 'inactive') take.recorder!.stop();
      await take.stopped;
      if (take.error) throw take.error;

      const blob = new Blob(take.chunks, { type: take.recorder!.mimeType });
      this.#release(take); // input isn't needed for decoding
      if (take !== this.#take) return null;

      buffer = await this.#context.decodeAudioData(await blob.arrayBuffer());
      if (take !== this.#take) return null; // cancelled or disposed while decoding
      if (take.trimSeconds) buffer = this.#trimEnd(buffer, take.trimSeconds);
    } catch (error) {
      if (take !== this.#take) {
        this.#release(take);
        return null;
      }
      this.#fail(take, error);
      throw error;
    }

    // Resources are released and the recorder is idle, so a handler can start the next take.
    this.#take = null;
    this.#setState(IDLE);
    if (!this.#disposed) this.sendMessage('record:stop', { duration: buffer.duration, buffer });
    return buffer;
  }

  #trimEnd(buffer: AudioBuffer, seconds: number): AudioBuffer {
    const length = buffer.length - Math.floor(seconds * buffer.sampleRate);
    if (length <= 0 || length >= buffer.length) return buffer;
    const trimmed = this.#context.createBuffer(buffer.numberOfChannels, length, buffer.sampleRate);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      trimmed.copyToChannel(buffer.getChannelData(channel).subarray(0, length), channel);
    }
    return trimmed;
  }

  /**
   * Discards the current take, whether it is requesting input, armed, recording
   * or finalizing. A pending `stop()` resolves `null`. Also ends monitoring, which
   * emits no record:cancelled since no take was discarded.
   *
   * @returns true if a take or monitoring was cancelled, false if there was nothing to cancel.
   */
  cancel(): boolean {
    const take = this.#take;
    if (!take) return false;
    const { monitorOnly } = take;
    take.cancel();
    this.#end(take);
    if (!this.#disposed && !monitorOnly) this.sendMessage('record:cancelled', {});
    return true;
  }

  #fail(take: Take, error: unknown): void {
    this.#end(take);
    if (!this.#disposed) this.sendMessage('record:error', { error });
  }

  #end(take: Take): void {
    this.#release(take);
    this.#take = null;
    this.#setState(IDLE);
  }

  // Safe to call repeatedly: runs cleanup registered since the last call.
  #release(take: Take): void {
    if (take.recorder && take.recorder.state !== 'inactive') take.recorder.stop();
    take.measure?.resolve(null);
    take.measure = undefined;
    for (const cleanup of take.cleanup.splice(0)) cleanup();
  }

  #setState(state: AudioRecorderState): void {
    const previousState = this.#state;
    if (state === previousState) return;
    this.#state = state;
    this.#messages.sendMessage('state-change', { state, previousState });
  }

  onMessage<K extends keyof RecorderEvents>(
    type: K,
    handler: MessageHandler<Message & RecorderEvents[K]>,
  ): () => void {
    return this.#messages.onMessage(type, handler as MessageHandler<Message>);
  }

  protected sendMessage<K extends keyof RecordEvents>(type: K, data: RecordEvents[K]) {
    this.#messages.sendMessage(type, data);
  }

  /** Releases input without emitting events. Pending `start()` and `stop()` calls settle. */
  dispose(): void {
    this.#disposed = true;
    if (this.#take) {
      this.#take.cancel();
      this.#release(this.#take);
    }
    this.#take = null;
    this.#state = IDLE;
    unregisterNode(this.nodeId);
  }

  // Getters
  get isArmed(): boolean {
    return this.#state === ARMED;
  }

  get isMonitoring(): boolean {
    return this.#state === MONITORING;
  }

  get isRecording(): boolean {
    return this.#state === RECORDING;
  }

  get state(): AudioRecorderState {
    return this.#state;
  }

  /** True while a take holds input (armed, recording or finalizing). */
  get initialized(): boolean {
    return this.#take?.recorder !== undefined;
  }

  get now(): number {
    return this.#context.currentTime;
  }
}
