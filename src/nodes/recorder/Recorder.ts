import { LibNode, SampleLoader } from '@/nodes/LibNode';
import { NodeID, registerNode, unregisterNode } from '@/nodes/node-store';
import { tryCatch, assert } from '@/utils';

import {
  Message,
  MessageBus,
  MessageHandler,
  createMessageBus,
} from '@/events';

import { getMicrophone } from '@/io/devices/devices';

// Get browser tab audio
async function getBrowserAudio(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    audio: true,
    video: true, // video seems to be required for getDisplayMedia to work
  });

  const audioOnly = new MediaStream(stream.getAudioTracks());
  stream.getVideoTracks().forEach((t) => t.stop()); // Stop video tracks

  return audioOnly;
}

import {
  preProcessAudioBuffer,
  PreProcessOptions,
  PreProcessResults,
} from '@/nodes/preprocessor/Preprocessor';

export const AudioRecorderState = {
  IDLE: 'IDLE',
  ARMED: 'ARMED',
  RECORDING: 'RECORDING',
  STOPPED: 'STOPPED',
} as const;

export type AudioRecorderState =
  (typeof AudioRecorderState)[keyof typeof AudioRecorderState];

export const DEFAULT_MEDIA_REC_OPTIONS: MediaRecorderOptions = {
  mimeType: 'audio/webm',
};

export type RecorderOptions = {
  mediaRecorderOptions: MediaRecorderOptions;
  useThreshold: boolean;
  startThreshold: number;
  autoStop: boolean;
  stopThreshold: number;
  silenceTimeoutMs: number;
  preprocess: boolean;
  preprocessOptions: object;
};

export type RecorderInput =
  | { type: 'microphone'; deviceId?: string }
  | { type: 'display' }
  | { type: 'audio-node'; node: AudioNode };

export type RecorderStartOptions = Partial<RecorderOptions> & {
  input?: RecorderInput;
};

export const DEFAULT_RECORDER_OPTIONS: RecorderOptions = {
  mediaRecorderOptions: DEFAULT_MEDIA_REC_OPTIONS,
  useThreshold: true,
  startThreshold: -30,
  autoStop: false,
  stopThreshold: -40, // todo: guard ensuring stopTreshold < startTreshold
  silenceTimeoutMs: 1000,
  preprocess: false, // SamplePlayer handles preprocessing
  preprocessOptions: {}, // use default options
};

export class Recorder implements LibNode {
  readonly nodeId: NodeID;
  readonly nodeType = 'recorder';

  #context: AudioContext;
  #stream: MediaStream | null = null;
  #recorder: MediaRecorder | null = null;
  #messages: MessageBus<Message>;
  #destination: (LibNode & SampleLoader) | null = null;
  #state: AudioRecorderState = AudioRecorderState.IDLE;

  // Single audio monitoring setup
  #mediaSourceNode: MediaStreamAudioSourceNode | null = null;
  #analyser: AnalyserNode | null = null;
  #animationFrame: number | null = null;
  #silenceStartTime: number | null = null;
  #config: RecorderOptions | null = null;

  #audioDestination: MediaStreamAudioDestinationNode | null = null;
  #connectedInputNode: AudioNode | null = null;

  constructor(context: AudioContext) {
    this.nodeId = registerNode(this.nodeType, this);
    this.#context = context;
    this.#messages = createMessageBus<Message>(this.nodeId);
  }

  async init(): Promise<Recorder> {
    console.warn(
      'Recorder: init() method is deprecated and will be removed in a future version.'
    );
    return this;
  }

  async #createAudioNodeStream(node: AudioNode): Promise<MediaStream> {
    this.#audioDestination = this.#context.createMediaStreamDestination();
    this.#connectedInputNode = node;
    node.connect(this.#audioDestination);

    return this.#audioDestination.stream;
  }

  async start(options: RecorderStartOptions = {}): Promise<this> {
    if (this.#context.state === 'suspended') {
      await this.#context.resume();
    }

    // Stop previous stream if exists
    if (this.#stream) {
      this.#stream.getTracks().forEach((track) => track.stop());
      this.#stream = null;
    }
    this.#cleanupAudioNodeConnection();

    const { input = { type: 'microphone' }, ...recorderOptions } = options;

    // ? Use a lower threshold for browser input unless overridden
    const config = { ...DEFAULT_RECORDER_OPTIONS, ...recorderOptions };

    if (input.type === 'display' && options.startThreshold === undefined) {
      config.startThreshold = -60;
    }
    this.#config = config;
    let streamResult;

    if (input.type === 'audio-node') {
      streamResult = await tryCatch(() =>
        this.#createAudioNodeStream(input.node),
      );
      assert(
        !streamResult.error,
        `Failed to create audio-node stream: ${streamResult.error}`,
        streamResult
      );
    } else if (input.type === 'display') {
      streamResult = await tryCatch(async () => {
        if (this.#context.state === 'suspended') {
          await this.#context.resume();
        }

        return getBrowserAudio();
      });
      assert(
        !streamResult.error,
        `Failed to get browser audio: ${streamResult.error}`,
        streamResult
      );
    } else {
      streamResult = await tryCatch(() =>
        getMicrophone(undefined, input.deviceId)
      );
      assert(
        !streamResult.error,
        `Failed to get audio input: ${streamResult.error}`,
        streamResult
      );
    }

    this.#stream = streamResult.data;

    this.#recorder = new MediaRecorder(
      this.#stream,
      this.#config
        ? this.#config.mediaRecorderOptions
        : DEFAULT_MEDIA_REC_OPTIONS
    );

    if (!this.#recorder) throw new Error('Recorder not initialized');
    if (this.#state === AudioRecorderState.RECORDING) return this;

    try {
      if (!this.#config || !this.#config.useThreshold) {
        this.#startRecordingImmediate();
      } else {
        this.#startArmedRecording();
      }
      return this;
    } catch (error) {
      console.error('Error starting recording:', error);
      throw error;
    }
  }

  forceStart(): boolean {
    if (this.#state !== AudioRecorderState.ARMED || !this.initialized) {
      console.warn(
        'Recorder must be initialized and armed before calling forceStart. Current state:',
        this.#state
      );
      return false;
    }

    if (!this.#config) {
      console.error('Recorder config is null, cannot force start');
      return false;
    }

    // Override auto-stop when force starting - user must stop recording manually
    this.#config.autoStop = false;

    this.#startRecordingImmediate();
    return true;
  }

  #startArmedRecording(): void {
    if (!this.#isValidThreshold(this.#config!.startThreshold)) {
      console.warn(
        `Threshold ${this.#config!.startThreshold}dB out of range (-60 to 0)`
      );
      return;
    }

    this.#state = AudioRecorderState.ARMED;
    console.info('Recorder state: ARMED');

    this.sendMessage('record:armed', {
      threshold: this.#config!.startThreshold,
      destination: this.#destination,
    });

    this.#setupAudioMonitoring();
  }

  #startRecordingImmediate(): void {
    this.#recorder!.start();
    this.#state = AudioRecorderState.RECORDING;
    console.info(`Recorder state: ${this.#state}`);

    this.sendMessage('record:start', { destination: this.#destination });

    if (this.#config?.autoStop) {
      this.#setupAudioMonitoring();
    }
  }

  async #setupAudioMonitoring() {
    this.#mediaSourceNode = this.#context.createMediaStreamSource(
      this.#stream!
    );
    this.#analyser = this.#context.createAnalyser();
    this.#analyser.fftSize = 1024;
    this.#mediaSourceNode.connect(this.#analyser);

    const dataArray = new Float32Array(this.#analyser.fftSize);

    if (this.#context.state === 'suspended') {
      await this.#context.resume();
    }

    const monitorAudio = async () => {
      if (!this.#analyser) return; // Cleaned up

      this.#analyser.getFloatTimeDomainData(dataArray);
      const peak = Math.max(...dataArray.map(Math.abs));
      const peakDB = peak > 0.0000001 ? 20 * Math.log10(peak) : -100;

      if (this.#state === AudioRecorderState.ARMED) {
        this.#handleArmedState(peakDB);
      } else if (this.#state === AudioRecorderState.RECORDING) {
        this.#handleRecordingState(peakDB);
      } else {
        this.#cleanupMonitoring();
        return;
      }

      this.#animationFrame = requestAnimationFrame(monitorAudio);
    };

    this.#animationFrame = requestAnimationFrame(monitorAudio);
  }

  #handleArmedState(peakDB: number): void {
    if (peakDB >= this.#config!.startThreshold) {
      // Threshold reached - start recording
      this.#startRecordingImmediate();
    }
  }

  #handleRecordingState(peakDB: number): void {
    if (!this.#config!.autoStop) return;

    const now = performance.now();

    if (peakDB < this.#config!.stopThreshold) {
      // Below threshold - track silence
      if (this.#silenceStartTime === null) {
        this.#silenceStartTime = now;
      } else if (
        now - this.#silenceStartTime >=
        this.#config!.silenceTimeoutMs
      ) {
        // Silence timeout reached
        this.sendMessage('record:stopping', {});
        this.stop().catch((err) => console.error('Error auto-stopping:', err));
      }
    } else {
      // Above threshold - reset silence timer
      this.#silenceStartTime = null;
    }
  }

  #cleanupMonitoring(): void {
    if (this.#animationFrame !== null) {
      cancelAnimationFrame(this.#animationFrame);
      this.#animationFrame = null;
    }

    if (this.#mediaSourceNode) {
      this.#mediaSourceNode.disconnect();
      this.#mediaSourceNode = null;
    }

    if (this.#analyser) {
      this.#analyser.disconnect();
      this.#analyser = null;
    }

    this.#silenceStartTime = null;
  }

  /**
   * Aborts an armed or in-progress recording without producing a buffer.
   * Releases the input stream, so a new `start()` is required to record again.
   *
   * @returns true if a recording was cancelled, false if there was nothing to cancel.
   */
  cancel(): boolean {
    if (
      this.#state !== AudioRecorderState.ARMED &&
      this.#state !== AudioRecorderState.RECORDING
    ) {
      return false;
    }

    this.#cleanupMonitoring();

    if (this.#recorder && this.#recorder.state !== 'inactive') {
      this.#recorder.stop(); // discards data - no 'dataavailable' listener attached
    }

    this.#state = AudioRecorderState.STOPPED;
    console.info(`Recorder state: ${this.#state} (cancelled)`);

    this.sendMessage('record:cancelled', {});
    this.#releaseStream();

    return true;
  }

  #releaseStream(): void {
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
    this.#recorder = null;
    this.#cleanupAudioNodeConnection();
  }

  async stop(): Promise<AudioBuffer> {
    // TODO: return PreProcessResults
    if (!this.#recorder) throw new Error('Recorder not initialized');

    if (this.#state === AudioRecorderState.ARMED) {
      this.cancel();
      throw new Error('Recording was armed but never triggered');
    }

    if (this.#state !== AudioRecorderState.RECORDING) {
      throw new Error('Not recording');
    }

    this.#cleanupMonitoring();

    const blob = await this.#stopRecording();
    let buffer = await this.#blobToAudioBuffer(blob);
    let preprocessResults: PreProcessResults;

    if (this.#config?.preprocess) {
      preprocessResults = await preProcessAudioBuffer(
        this.#context,
        buffer,
        this.#config.preprocessOptions
      );

      buffer = preprocessResults.audiobuffer;
    }

    if (this.#destination) {
      // Auto load sample
      await this.#destination.loadSample(buffer);
    }

    this.#state = AudioRecorderState.STOPPED;
    console.info(`Recorder state: ${this.#state}`);

    this.sendMessage('record:stop', { duration: buffer.duration });

    // Clean up - a new stream and recorder is created for each recording
    this.#releaseStream();

    return buffer;
  }

  #stopRecording(): Promise<Blob> {
    return new Promise((resolve) => {
      if (this.#recorder?.state !== 'inactive') {
        this.#recorder?.addEventListener(
          'dataavailable',
          (e) => resolve(e.data),
          { once: true }
        );
        this.#recorder?.stop();
      }
    });
  }

  async #blobToAudioBuffer(blob: Blob): Promise<AudioBuffer> {
    const arrayBuffer = await blob.arrayBuffer();
    return await this.#context.decodeAudioData(arrayBuffer);
  }

  #isValidThreshold(threshold: number): boolean {
    return threshold > -60 && threshold < 0;
  }

  onMessage(type: string, handler: MessageHandler<Message>): () => void {
    return this.#messages.onMessage(type, handler);
  }

  protected sendMessage(type: string, data: any) {
    this.#messages.sendMessage(type, data);

    // Send unified state-change message for recorder events
    if (type.startsWith('record:')) {
      this.#messages.sendMessage('state-change', {
        state: this.#state,
        event: type,
        ...data,
      });
    }
  }

  connect(destination: LibNode & SampleLoader): this {
    this.#destination = destination;
    return this;
  }

  #cleanupAudioNodeConnection(): void {
    if (this.#audioDestination && this.#connectedInputNode) {
      this.#connectedInputNode.disconnect(this.#audioDestination);
      this.#audioDestination = null;
      this.#connectedInputNode = null;
    }
  }

  disconnect(): void {
    this.#destination = null;
  }

  dispose(): void {
    this.#cleanupMonitoring();
    this.#cleanupAudioNodeConnection();
    this.#stream?.getTracks().forEach((track) => track.stop());
    this.#stream = null;
    this.#recorder = null;
    this.#state = AudioRecorderState.IDLE;
    this.#config = null;
    unregisterNode(this.nodeId);
  }

  // Getters
  get isArmed(): boolean {
    return this.#state === AudioRecorderState.ARMED;
  }

  get isRecording(): boolean {
    return this.#state === AudioRecorderState.RECORDING;
  }

  get state(): AudioRecorderState {
    return this.#state;
  }

  get initialized(): boolean {
    return this.#recorder !== null && this.#stream !== null;
  }

  get now(): number {
    return this.#context.currentTime;
  }

  get destination() {
    return this.#destination;
  }
}
