import { LibNode } from '@/nodes/LibNode';
import { NodeID, registerNode, unregisterNode } from '@/nodes/node-store';

import { Message, MessageBus, MessageHandler, createMessageBus } from '@/events';

import { MUSIC_MIC_CONSTRAINTS, getMicrophone } from '@/io/devices/devices';

export const AudioRecorderState = {
  IDLE: 'IDLE',
  REQUESTING_INPUT: 'REQUESTING_INPUT',
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
  /** Stop once the input's peak stays below `thresholdDb` for `durationMs`. */
  stopOnSilence?: { thresholdDb: number; durationMs: number };
  /** Passed to `MediaRecorder`. Without a `mimeType` the browser picks the format. */
  mediaRecorderOptions?: MediaRecorderOptions;
};

export type RecorderArmOptions = RecorderStartOptions & {
  /** Peak level that starts the take. Defaults to -30 dB, or -60 dB for display input. */
  startThresholdDb?: number;
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
};

type TakeOptions = RecorderStartOptions & { input: RecorderInput; startThresholdDb: number };

// Everything one take owns, so async work from an old take can't touch a newer one.
type Take = {
  options: TakeOptions;
  armed: boolean;
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

const { IDLE, REQUESTING_INPUT, ARMED, RECORDING, FINALIZING } = AudioRecorderState;

function assertDb(name: string, value: number): void {
  if (!Number.isFinite(value) || value > 0) {
    throw new RangeError(`${name} must be a finite dB value <= 0, got ${value}`);
  }
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
   * starting or recording, shares it and ignores `options`.
   */
  start(options: RecorderStartOptions = {}): Promise<this> {
    return this.#begin(options, false);
  }

  /** Acquires input and waits for its peak to reach `startThresholdDb` before recording. */
  arm(options: RecorderArmOptions = {}): Promise<this> {
    return this.#begin(options, true);
  }

  async #begin(options: RecorderArmOptions, armed: boolean): Promise<this> {
    if (this.#disposed) throw new Error('Recorder is disposed');
    const current = this.#take;
    if (current) {
      if (this.#state === FINALIZING) {
        await current.result!.catch(() => {});
        return this.#begin(options, armed);
      }
      if (!armed) {
        current.armed = false;
        if (this.#state === ARMED) this.#recordOrFail(current);
      }
      await current.ready;
      return this;
    }

    const resolved = this.#resolveOptions(options, armed);
    let cancel!: () => void;
    const cancelled = new Promise<void>((resolve) => (cancel = resolve));
    const take: Take = {
      options: resolved,
      armed,
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
    const { input = { type: 'microphone' }, stopOnSilence, mediaRecorderOptions } = options;
    const startThresholdDb = options.startThresholdDb ?? (input.type === 'display' ? -60 : -30);

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

    return { ...options, input, startThresholdDb };
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

      const recorder = new MediaRecorder(stream, take.options.mediaRecorderOptions);
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
    } catch (error) {
      if (take !== this.#take) return this.#release(take);
      this.#fail(take, error);
      throw error;
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
    if (take.options.stopOnSilence) this.#monitor(take);
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

  // One loop per take: handles the arm trigger, then silence, without restarting.
  #monitor(take: Take): void {
    if (take.monitoring) return;
    take.monitoring = true;

    const source = this.#context.createMediaStreamSource(take.stream!);
    const analyser = this.#context.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);
    const data = new Float32Array(analyser.fftSize);
    let silentSince: number | null = null;

    // shortcut: background tabs throttle this timer; audio-timeline detection is tracked in #166.
    const interval = setInterval(() => {
      if (take !== this.#take) return;
      analyser.getFloatTimeDomainData(data);
      let peak = 0;
      for (const sample of data) peak = Math.max(peak, Math.abs(sample));
      const peakDb = peak > 0 ? 20 * Math.log10(peak) : -Infinity;

      if (this.#state === ARMED) {
        if (peakDb >= take.options.startThresholdDb) {
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
      if (peakDb >= silence.thresholdDb) {
        silentSince = null;
      } else if (silentSince === null) {
        silentSince = performance.now();
      } else if (performance.now() - silentSince >= silence.durationMs) {
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
    else if (this.#state === ARMED) this.#fail(take, new Error('Recorder input ended'));
  }

  /**
   * Finishes the take and resolves with its audio. Resolves `null` when idle, or
   * when armed or still requesting input, which cancels the take. Calls while
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

  /**
   * Discards the current take, whether it is requesting input, armed, recording
   * or finalizing. A pending `stop()` resolves `null`.
   *
   * @returns true if a take was cancelled, false if there was nothing to cancel.
   */
  cancel(): boolean {
    const take = this.#take;
    if (!take) return false;
    take.cancel();
    this.#end(take);
    if (!this.#disposed) this.sendMessage('record:cancelled', {});
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
