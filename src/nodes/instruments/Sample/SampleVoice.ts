import { LibAudioNode, Destination, NodeType } from "@/nodes";
import { getAudioContext } from "@/context";
import { registerNode, NodeID, unregisterNode } from "@/nodes/node-store";
import { VoiceState } from "../VoiceState";

import { Message, MessageHandler, createMessageBus, MessageBus } from "@/events";

import {
  assert,
  cancelAndPinParamValue,
  interpolateLinearToGeometric,
  mapToRange,
  midiToPlaybackRate,
  getKeytrackedFilterHz,
  clampHz,
  maxSafeHz,
} from "@/utils";

import {
  CustomEnvelope,
  type EnvelopeState,
  type EnvelopeType,
  createEnvelope,
} from "@/nodes/params/envelopes";

import { HarmonicFeedback } from "@/nodes/effects/HarmonicFeedback";

import { LFO } from "@/nodes/params/LFOs/LFO";
import { CustomLibWaveform, WaveformOptions } from "@/utils/audiodata/generate/generateWaveform";
import { samplerParams } from "./sampler-params";

export type SampleVoiceChainNode = "feedback" | "am" | "hpf" | "lpf";

const DEFAULT_CHAIN_ORDER: readonly SampleVoiceChainNode[] = ["lpf", "hpf", "am", "feedback"];

export class SampleVoice {
  // TODO: implements ILibAudioNode
  readonly nodeId: NodeID;
  readonly nodeType: NodeType = "sample-voice";
  #messages: MessageBus<Message>;
  #initPromise: Promise<void> | null = null;

  #outputNode: GainNode;
  #playerWorklet: AudioWorkletNode;

  #am_lfo: LFO | null = null;
  #am_gain: GainNode | null = null;
  #feedback: HarmonicFeedback | null = null;

  #envelopes = new Map<EnvelopeType, CustomEnvelope>();

  #state: VoiceState = VoiceState.NOT_READY;
  #isInitialized = false;

  #activeMidiNote: number | null = null;
  #startedTimestamp: number = -1;

  #sampleDurationSeconds = 0;

  #pitchGlideTime = 0; // in seconds

  #internalSignalChain: readonly SampleVoiceChainNode[];
  #pitchDisabled = false;

  #hpf: BiquadFilterNode | null = null;
  #lpf: BiquadFilterNode | null = null;
  #hpfHz: number = samplerParams.highpassFilter.defaultValue;
  #hpfQ: number = 0.5;
  #lpfHz: number = maxSafeHz();
  #lpfQ: number = 0.707;
  // Keytracking defaults roughly tuned by ear for now
  // TODO: Consider adding as params (#31)
  #keytrackLPFAmount: number = 0.25;
  #keytrackHPFAmount: number = 0.75;

  // static getProcessorParamDescriptors() {
  //   return SAMPLE_PLAYER_PARAM_DESCRIPTORS;
  // }

  constructor(
    private context: AudioContext = getAudioContext(),
    options: { processorOptions?: any; internalSignalChain?: readonly SampleVoiceChainNode[] } = {},
  ) {
    const signalChain = options.internalSignalChain ?? DEFAULT_CHAIN_ORDER;
    if (new Set(signalChain).size !== signalChain.length) {
      throw new TypeError("SampleVoice signal chain cannot contain duplicate nodes");
    }

    this.nodeId = registerNode(this.nodeType, this);
    this.#messages = createMessageBus<Message>(this.nodeId);
    this.#internalSignalChain = [...signalChain];

    this.#outputNode = new GainNode(context, { gain: 1 });

    this.#playerWorklet = new AudioWorkletNode(context, "sample-player-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2], // Force stereo output
      processorOptions: options.processorOptions || {},
    });

    // Connections are made in #connectAudioChain() during init()
  }

  async init(): Promise<void> {
    if (this.#initPromise) return this.#initPromise;
    this.#initPromise = (async () => {
      try {
        // ? Need to wait for worklet 'initialized' message ?

        // Create nodes
        this.#initInternalSignalChainNodes();

        // ? Why is this necessary ?
        // Initialize loopEnd to 0 to force the macro parameter to update
        // This ensures the macro's value will be applied when connected
        this.setParam("loopStart", 0, this.now);
        this.setParam("loopEnd", 0, this.now);

        // Connect nodes
        this.#connectAudioChain();

        // Create Envelopes // Todo: follow async pattern to the end
        this.#createEnvelopes();

        // Setup message handling
        this.#setupWorkletMessageHandling();
        this.#playerWorklet.port.start();
      } catch (error) {
        this.dispose();
        this.#initPromise = null;
        throw error;
      }
    })();
    return this.#initPromise;
  }

  #connectAudioChain() {
    const map: Record<SampleVoiceChainNode, AudioNode | HarmonicFeedback | null> = {
      feedback: this.#feedback,
      am: this.#am_gain,
      hpf: this.#hpf,
      lpf: this.#lpf,
    };
    const nodes = [
      this.#playerWorklet,
      ...this.#internalSignalChain.flatMap((key) => {
        const n = map[key];
        assert(n, `SampleVoice: "${key}" not initialized!`);
        return n instanceof HarmonicFeedback ? [n.input, n.output] : [n];
      }),
    ];
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    nodes[nodes.length - 1].connect(this.#outputNode);
  }

  #chainIncludes(node: SampleVoiceChainNode) {
    return this.#internalSignalChain.includes(node);
  }

  #initInternalSignalChainNodes() {
    if (this.#chainIncludes("feedback") && !this.#feedback) {
      this.#feedback = new HarmonicFeedback(this.context);
    }

    if (this.#chainIncludes("am") && !this.#am_gain) {
      this.#am_gain = new GainNode(this.context, { gain: 1 });
      this.#am_lfo = new LFO(this.context);
      this.#am_lfo.setWaveform("square");
      this.#am_lfo.setDepth(0);
      this.#am_lfo.setMusicalNote(this.#activeMidiNote ?? 60);
      this.#am_lfo.connect(this.#am_gain.gain);
    }

    if (this.#chainIncludes("hpf") && !this.#hpf) {
      this.#hpf = new BiquadFilterNode(this.context, {
        type: "highpass",
        frequency: this.#hpfHz,
        Q: this.#hpfQ,
      });
    }

    if (this.#chainIncludes("lpf") && !this.#lpf) {
      this.#lpfHz = maxSafeHz(this.context.sampleRate);
      this.#lpf = new BiquadFilterNode(this.context, {
        type: "lowpass",
        frequency: this.#lpfHz,
        Q: this.#lpfQ,
      });
    }
  }

  #createEnvelopes() {
    this.#envelopes.forEach((env) => env.dispose());
    this.#envelopes.clear();

    const durationSeconds = this.#sampleDurationSeconds || undefined;
    const ampEnv = createEnvelope(this.context, "amp-env", { durationSeconds });
    this.#envelopes.set("amp-env", ampEnv);

    const pitchEnv = createEnvelope(this.context, "pitch-env", {
      durationSeconds,
    });

    this.#envelopes.set("pitch-env", pitchEnv);

    if (this.#chainIncludes("lpf")) {
      const filterEnv = createEnvelope(this.context, "filter-env", {
        durationSeconds,
        envPointValueRange: [0, 1],
        initEnable: false,
      });

      this.#envelopes.set("filter-env", filterEnv);
    }

    this.#setupEnvelopeMessageHandling();
  }

  async loadBuffer(buffer: AudioBuffer, zeroCrossings?: number[]): Promise<boolean> {
    return this.loadLayers([buffer], zeroCrossings);
  }

  /**
   * Replace the whole layer set. Layers are summed at one shared playhead, so
   * layer 0 is the authority for duration and all range math; the rest only
   * add samples. A layer at the wrong sample rate is dropped on its own,
   * leaving the others playable, except layer 0: losing it fails the load.
   */
  async loadLayers(buffers: AudioBuffer[], zeroCrossings?: number[]): Promise<boolean> {
    this.#state = VoiceState.NOT_READY;

    const usable = buffers.filter((buffer) => {
      if (buffer.sampleRate !== this.context.sampleRate) {
        console.warn(
          `Sample rate mismatch - buffer: ${buffer.sampleRate}, context: ${this.context.sampleRate}`,
        );
        return false;
      }
      return true;
    });

    // Layer 0 is the authority for duration and loop range, so if it was
    // dropped the remaining layers would silently play to the wrong ranges.
    if (!usable.length || usable[0] !== buffers[0]) {
      console.error(
        "SampleVoice.loadLayers: layer 0 is unusable, nothing loaded. Layer 0 sets duration and loop range for all layers.",
      );
      return false;
    }

    // postMessage structured-clones each channel, so no local copy needed
    const layers = usable.map((buffer) =>
      Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i)),
    );

    this.sendToProcessor({
      type: "voice:setLayers",
      layers,
      durationSeconds: usable[0].duration,
    });

    if (zeroCrossings?.length) {
      this.sendToProcessor({
        type: "voice:setZeroCrossings",
        zeroCrossings,
      });
    }

    return true;
  }

  freeze(freeze: boolean): this {
    console.info(
      `SampleVoice: freeze(${freeze}) called. 
      Spectral freeze not implemented yet`,
    );
    // if (this.#isFrozen === freeze) return this; // idempotent
    // this.#isFrozen = freeze;
    // this.#spectralFreezeWorklet.port.postMessage(
    //   freeze ? 'freeze' : 'unfreeze'
    // );
    return this;
  }

  setGlideTime(seconds: number) {
    this.#pitchGlideTime = seconds;
  }

  trigger(options: {
    midiNote: MidiValue;
    velocity: MidiValue;
    secondsFromNow?: number;
    glide?: { prevMidiNote: number; glideTime?: number };
  }): MidiValue | null {
    const { midiNote, velocity, secondsFromNow = 0 } = options;

    const timestamp = this.now + secondsFromNow;

    if (this.#state === VoiceState.PLAYING || this.#state === VoiceState.RELEASING) {
      console.log(`had to stop a playing voice, midinote: ${midiNote}`);
      this.stop(timestamp);
      return null;
    }

    this.#state = VoiceState.PLAYING;
    this.#startedTimestamp = timestamp;
    this.#activeMidiNote = midiNote;

    const GLIDE_TEMP_SCALAR = 8; // for easy fine-tuning while prototyping the glide feature
    const glideTime = options.glide?.glideTime ?? this.#pitchGlideTime;
    const scaledGlideTime = glideTime / GLIDE_TEMP_SCALAR;

    let playbackRate = 1;
    let prevRate = 1;

    if (!this.#pitchDisabled) {
      playbackRate = midiToPlaybackRate(midiNote);
      if (options.glide) {
        prevRate = midiToPlaybackRate(options.glide.prevMidiNote);
      }
      this.#updateHPFCutoffForPlaybackRate(playbackRate, timestamp, {
        glideTime: scaledGlideTime,
        // cancelPrevious: !!options.glide, // ? cancel previous only if glide is requested ?
      });
      this.#updateLPFCutoffForPlaybackRate(playbackRate, timestamp, {
        glideTime: scaledGlideTime,
        // cancelPrevious: !!options.glide,
      });
    }

    // Only apply glide if pitch is enabled and glide is requested
    if (!this.#pitchDisabled && options.glide && scaledGlideTime > 0) {
      const rateParam = this.getParam("playbackRate")!;
      if (prevRate > 0) rateParam.setValueAtTime(prevRate, timestamp);

      this.getParam("playbackRate")!.setTargetAtTime(playbackRate, timestamp, scaledGlideTime);
    } else {
      this.setParam("playbackRate", playbackRate, timestamp);
    }

    this.setParam("velocity", velocity, timestamp);

    // Start playback
    this.sendToProcessor({
      type: "voice:start",
      timestamp,
    });

    // Apply amp, filter and pitch envelopes if enabled
    this.applyEnvelopes(timestamp, playbackRate, velocity, midiNote);

    // Trigger effects
    this.#feedback?.trigger(midiNote, {
      velocity,
      secondsFromNow,
      glideTime: scaledGlideTime,
      triggerDecay: true,
    });

    this.#am_lfo?.setMusicalNote(midiNote, {
      divisor: 1,
      glideTime: scaledGlideTime,
      glideFromMidiNote: options?.glide?.prevMidiNote,
      timestamp,
    });

    return this.#activeMidiNote;
  }

  applyEnvelopes(timestamp: number, playbackRate: number, velocity?: number, midiNote?: number) {
    this.#envelopes.forEach((env, envType) => {
      if (!env.isEnabled) return;
      const param = this.getParam(env.param);
      if (!param) return;
      if (envType === "pitch-env" && !env.hasVariation()) return;

      const baseValue = (() => {
        switch (envType) {
          case "amp-env":
            return velocity ? velocity / 127 : 1;
          case "pitch-env":
            return playbackRate;
          case "filter-env":
            return this.#keytrackedLpfHz(playbackRate); // current cutoff, keytracking included
          default:
            return 1;
        }
      })();

      env.triggerEnvelope(param, timestamp, {
        baseValue,
        playbackRate,
        voiceId: this.nodeId,
        midiNote: midiNote ?? 60,
      });
    });

    const envDurations = Object.fromEntries(
      Array.from(this.#envelopes, ([envType, env]) => [
        envType,
        env.syncedToPlaybackRate
          ? env.baseDuration / playbackRate / env.timeScale
          : env.baseDuration / env.timeScale,
      ]),
    );
    const loopEnabled = Object.fromEntries(
      Array.from(this.#envelopes, ([envType, env]) => [envType, env.loopEnabled]),
    );

    this.sendUpstreamMessage("sample-envelopes:trigger", {
      voiceId: this.nodeId,
      midiNote: this.#activeMidiNote,
      envDurations,
      loopEnabled,
    });
  }

  #releaseTimeout: number | null = null;
  #stopTimeout: number | null = null;

  #stopEnvelopes() {
    this.#envelopes.forEach((env) => env.stopCurrentRun());
  }

  release({ releaseTime = this.releaseTime, secondsFromNow = 0 }): this {
    if (this.#state === VoiceState.RELEASING) return this;

    const envGain = this.getParam("envGain");
    if (!envGain) throw new Error("Cannot release - envGain parameter is null");

    this.#state = VoiceState.RELEASING;
    const timestamp = this.now + secondsFromNow;
    const playbackRate = this.getParam("playbackRate")?.value ?? 1;

    // Release all enabled envelopes
    this.#envelopes.forEach((env) => {
      if (!env.isEnabled) return;
      const param = this.getParam(env.param);
      if (!param) return;

      env.releaseEnvelope(param, timestamp, {
        playbackRate,
        voiceId: this.nodeId,
        midiNote: this.#activeMidiNote ?? 60, // not used
      });
    });

    // Immediate stop for zero release time
    if (releaseTime <= 0) return this.stop(timestamp);

    this.sendToProcessor({ type: "voice:release", timestamp });

    // Get longest release time of enabled envelopes
    const enabledEnvelopes = Array.from(this.#envelopes.values()).filter((env) => env.isEnabled);

    const effectiveReleaseTime =
      enabledEnvelopes.length > 0
        ? Math.max(...enabledEnvelopes.map((env) => env.effectiveReleaseDuration))
        : releaseTime; // Fallback passed in release time

    // Stop after release duration // todo: check for redundancy
    if (this.#releaseTimeout) clearTimeout(this.#releaseTimeout);
    this.#releaseTimeout = setTimeout(
      () => {
        try {
          if (this.#state === VoiceState.RELEASING || this.#state === VoiceState.PLAYING) {
            this.stop();
          }
        } finally {
          this.#releaseTimeout = null;
        }
      },
      effectiveReleaseTime * 1000 + 50,
    ); // 50ms buffer

    return this;
  }

  stop(timestamp = this.now): this {
    if (this.#state === VoiceState.STOPPED || this.#state === VoiceState.STOPPING) {
      return this;
    }
    this.#state = VoiceState.STOPPING;

    const deClickSeconds = 0.005;
    const stopAt = Math.max(timestamp, this.now);
    const envGain = this.getParam("envGain");
    if (envGain) {
      // param.value is only accurate for now, so pin now and ramp down to
      // stopAt. Pinning at a future stopAt holds a stale value and steps the
      // gain back up mid-release.
      cancelAndPinParamValue(envGain, this.now);
      envGain.linearRampToValueAtTime(0, stopAt + deClickSeconds);
    }

    if (this.#stopTimeout) clearTimeout(this.#stopTimeout);
    this.#stopTimeout = setTimeout(
      () => {
        this.sendToProcessor({ type: "voice:stop", timestamp: stopAt });
        this.#stopTimeout = null;
      },
      Math.max(0, (stopAt + deClickSeconds - this.now) * 1000),
    );
    return this;
  }

  /**  Set HPF cutoff relative to playback rate */
  #updateHPFCutoffForPlaybackRate(
    playbackRate: number,
    atTime: number = this.now,
    options: {
      glideTime?: number;
      cancelPrevious?: boolean;
    } = {},
  ) {
    if (this.#activeMidiNote === null || !this.#hpf || this.#keytrackHPFAmount <= 0) {
      return;
    }

    const freq = this.#hpf.frequency;
    const { glideTime = 0, cancelPrevious = true } = options || {};
    if (cancelPrevious) {
      freq.cancelScheduledValues(atTime);
    }

    const keytrackedHz = getKeytrackedFilterHz(this.#hpfHz, playbackRate, this.#keytrackHPFAmount);
    const safeHz = clampHz(keytrackedHz, this.context.sampleRate);

    if (glideTime > 0) {
      freq.setTargetAtTime(safeHz, atTime, glideTime);
    } else {
      // immediate set, slightly offset to avoid scheduling conflicts
      freq.setValueAtTime(safeHz, Math.max(atTime, this.now + 0.001));
    }
  }

  /**
   * The LPF cutoff with keytracking applied. This is the cutoff the filter
   * envelope sweeps from, so keytracking and the envelope compose instead of
   * the envelope resetting the cutoff back to the untracked base.
   */
  #keytrackedLpfHz(playbackRate: number = this.getParam("playbackRate")?.value ?? 1): number {
    const keytrackedHz = getKeytrackedFilterHz(this.#lpfHz, playbackRate, this.#keytrackLPFAmount);
    return clampHz(keytrackedHz, this.context.sampleRate);
  }

  /**  Set LPF cutoff relative to playback rate */
  #updateLPFCutoffForPlaybackRate(
    playbackRate: number,
    atTime: number = this.now,
    options: {
      glideTime?: number;
      cancelPrevious?: boolean;
    } = {},
  ) {
    if (this.#activeMidiNote === null || !this.#lpf || this.#keytrackLPFAmount <= 0) {
      return;
    }

    const freq = this.#lpf.frequency;
    const { glideTime = 0, cancelPrevious = true } = options || {};
    if (cancelPrevious) {
      freq.cancelScheduledValues(atTime);
    }

    const safeHz = this.#keytrackedLpfHz(playbackRate);

    if (glideTime > 0) {
      freq.setTargetAtTime(safeHz, atTime, glideTime);
    } else {
      // immediate set, slightly offset to avoid scheduling conflicts
      freq.setValueAtTime(safeHz, Math.max(atTime, this.now + 0.001));
    }
  }

  // === LFOs ===

  /** Cleanup amplitude modulation LFO */
  #cleanupAmpModLFO() {
    if (!this.#am_lfo) return;
    this.#am_lfo.dispose();
    this.#am_lfo = null;
    return this;
  }

  setModulationAmount(modType: "AM" | "FM", amount: number) {
    if (modType === "AM" && !this.#chainIncludes("am")) return this;

    const safeAmount = mapToRange(amount, 0, 1, 0, 0.95, {
      warn: true,
      name: "sampleVoice.setModulationAmount",
    });

    if (modType === "AM") {
      this.#am_lfo?.setDepth(safeAmount);
    } else if (modType === "FM") {
      console.warn("SampleVoice: FM modulation not implemented yet");
    }
    return this;
  }

  setModulationWaveform(
    modType: "AM" | "FM" = "AM",
    waveform: CustomLibWaveform | OscillatorType | PeriodicWave = "triangle",
    customWaveOptions: WaveformOptions = {},
  ) {
    if (modType === "AM" && !this.#chainIncludes("am")) return this;

    if (modType === "AM") {
      this.#am_lfo?.setWaveform(waveform, customWaveOptions);
    } else if (modType === "FM") {
      console.info("SampleVoice: FM modulation not implemented yet");
    }
    return this;
  }

  // === ENVELOPES ===

  enableEnvelope = (envType: EnvelopeType) => {
    this.#envelopes.get(envType)?.enable();
  };

  disableEnvelope = (envType: EnvelopeType) => {
    this.#envelopes.get(envType)?.disable();

    if (envType === "filter-env" && this.#chainIncludes("lpf")) {
      const lpf = this.getParam("lpf");
      lpf?.cancelScheduledValues(this.now);
      // Reset to the keytracked cutoff after the envelope is disabled
      lpf?.setValueAtTime(this.#keytrackedLpfHz(), this.now + 0.01);
    }
  };

  setEnvelopeTimeScale = (envType: EnvelopeType, timeScale: number) => {
    this.#envelopes.get(envType)?.setTimeScale(timeScale);
  };

  setEnvelopeSustainPoint = (envType: EnvelopeType, index: number | null) => {
    const env = this.#envelopes.get(envType);
    if (env?.isEnabled) env.setSustainPoint(index);
  };

  setEnvelopeReleasePoint = (envType: EnvelopeType, index: number) => {
    const env = this.#envelopes.get(envType);
    if (env?.isEnabled) env.setReleasePoint(index);
  };

  addEnvelopePoint(envType: EnvelopeType, time: number, value: number) {
    const env = this.#envelopes.get(envType);
    if (env?.isEnabled) env.addPoint(time, value);
  }

  updateEnvelopePoint(envType: EnvelopeType, index: number, time?: number, value?: number) {
    const env = this.#envelopes.get(envType);
    if (env?.isEnabled) env.updatePoint(index, time, value);
  }

  deleteEnvelopePoint(envType: EnvelopeType, index: number) {
    const env = this.#envelopes.get(envType);
    if (env?.isEnabled) env.deletePoint(index);
  }

  getEnvelope = (envType: EnvelopeType): CustomEnvelope | undefined => {
    return this.#envelopes.get(envType);
  };

  /** @internal */
  applyEnvelopeState = (envType: EnvelopeType, state: EnvelopeState) => {
    const envelope = this.#envelopes.get(envType);
    envelope?.applyState(state);
    if (envelope && !state.enabled) this.disableEnvelope(envType);
  };

  get envelopes() {
    return this.#envelopes;
  }

  setStartPoint = (time: number, timestamp = this.now) => {
    this.setParam("startPoint", time, timestamp);
  };

  setEndPoint = (time: number, timestamp = this.now) => {
    this.setParam("endPoint", time, timestamp);
  };

  setParam(
    name: string,
    targetValue: number,
    timestamp: number = this.now,
    options: {
      glideTime?: number;
      cancelPrevious?: boolean;
    } = {},
  ): this {
    const param = this.getParam(name);
    if (!param || param.value === targetValue) return this;

    const { glideTime = 0, cancelPrevious = true } = options;

    if (cancelPrevious) param.cancelScheduledValues(timestamp);

    if (glideTime <= 0) param.setValueAtTime(targetValue, Math.max(timestamp, this.now + 0.001));
    else param.linearRampToValueAtTime(targetValue, timestamp + Math.max(glideTime, 0.001));

    return this;
  }

  protected setParams(
    paramsAndValues: Array<{ name: string; value: number }>,
    atTime: number,
    options: {
      glideTime?: number;
      cancelPrevious?: boolean;
    } = {},
  ): this {
    const validParams = paramsAndValues.filter((pv) => this.getParam(pv.name) !== null);
    if (validParams.length === 0) return this;

    validParams.forEach(({ name, value }) => {
      // Pass the absolute timestamp to ensure all parameters use the same timestamp
      this.setParam(name, value, atTime, { ...options });
    });
    return this;
  }

  setLoopPoints(start: number, end: number, timestamp = this.now, rampTime = 0): this {
    if (start >= end) return this;

    if (start !== undefined) {
      this.setParam("loopStart", start, timestamp, {
        glideTime: rampTime,
        cancelPrevious: true,
      });
    }
    if (end !== undefined) {
      this.setParam("loopEnd", end, timestamp, {
        glideTime: rampTime,
        cancelPrevious: true,
      });
    }

    return this;
  }

  syncLoopToTempo(enabled: boolean) {
    this.sendToProcessor({
      type: "syncLoopToTempo",
      value: enabled,
    });
    return this;
  }

  setKeytrackLoopAmount(amount: number) {
    this.sendToProcessor({
      type: "setKeytrackLoopAmount",
      value: amount,
    });
    return this;
  }

  setTempo(bpm: number) {
    this.setParam("tempo", bpm, this.now);
    return this;
  }

  setAllowedPeriods(periods: number[]): this {
    this.sendToProcessor({
      type: "setAllowedPeriods",
      allowedPeriods: periods,
    });

    return this;
  }

  disablePitch = () => {
    this.#pitchDisabled = true;
    const timestamp = this.now;
    const glideTime = 0.1;

    this.getParam("playbackRate")?.linearRampToValueAtTime(1, timestamp + glideTime);

    this.#updateHPFCutoffForPlaybackRate(1, timestamp, { glideTime });
    this.#updateLPFCutoffForPlaybackRate(1, timestamp, { glideTime });
  };

  enablePitch = () => {
    this.#pitchDisabled = false;
    const timestamp = this.now;
    const glideTime = 0.1;

    if (this.#activeMidiNote !== null) {
      const rate = midiToPlaybackRate(this.#activeMidiNote);
      this.getParam("playbackRate")?.linearRampToValueAtTime(rate, this.context.currentTime + 0.01);
      this.#updateHPFCutoffForPlaybackRate(rate, timestamp, {
        glideTime,
      });
      this.#updateLPFCutoffForPlaybackRate(rate, timestamp, {
        glideTime,
      });
    }
  };

  /** CONNECTIONS */

  connect(destination: Destination, output?: number, input?: number): Destination {
    if (destination instanceof LibAudioNode) {
      this.out.connect(destination.input, output);
    } else if (destination instanceof AudioParam) {
      this.out.connect(destination, output);
    } else if (destination instanceof AudioNode) {
      this.out.connect(destination, output, input);
    } else {
      console.warn("SampleVoice: Unsupported destination", destination);
    }
    return destination;
  }

  disconnect(output = "main", destination?: Destination): this {
    if (output === "alt") {
      console.warn(`SampleVoice has no "alt" output to disconnect`);
      return this;
    }
    if (!destination) {
      this.out.disconnect();
    } else if (destination instanceof AudioNode) {
      this.out.disconnect(destination);
    } else if (destination instanceof AudioParam) {
      this.out.disconnect(destination);
    }
    return this;
  }

  /** MESSAGES */

  onMessage(type: string, handler: MessageHandler<Message>): () => void {
    return this.#messages.onMessage(type, handler);
  }

  sendToProcessor(data: any): this {
    this.#playerWorklet.port.postMessage(data);
    return this;
  }

  sendUpstreamMessage(type: string, data: any) {
    this.#messages.sendMessage(type, data);
    return this;
  }

  #setupEnvelopeMessageHandling() {
    this.#envelopes.forEach((env, envType) => {
      this.#messages.forwardFrom(
        env,
        [
          `${envType}:trigger`,
          `${envType}:release`,
          `${envType}:trigger:loop`,
          `${envType}:created`,
        ],
        (msg) => ({
          ...msg,
          voiceId: this.nodeId,
          midiNote: this.#activeMidiNote,
        }),
      );
    });
  }

  #setupWorkletMessageHandling() {
    this.#playerWorklet.port.onmessage = (event: MessageEvent) => {
      let { type, ...data } = event.data;

      switch (type) {
        case "initialized":
          this.#isInitialized = true;
          this.#state = VoiceState.NOT_READY; // not loaded

          this.sendUpstreamMessage("voice:initialized", {
            voice: this,
            voiceId: this.nodeId,
          });
          break;

        case "voice:loaded":
          this.#activeMidiNote = null;

          if (data.durationSeconds) {
            this.#sampleDurationSeconds = data.durationSeconds;

            this.#createEnvelopes();

            this.setStartPoint(0);
            this.setEndPoint(data.durationSeconds);
          }
          this.#state = VoiceState.LOADED;
          break;

        case "voice:started":
          this.#state = VoiceState.PLAYING;
          data = {
            voice: this,
            midiNote: this.#activeMidiNote,
          };
          break;

        case "voice:stopped":
          this.#stopEnvelopes();
          if (this.#releaseTimeout) {
            clearTimeout(this.#releaseTimeout);
            this.#releaseTimeout = null;
          }
          this.#state = VoiceState.STOPPED;
          data = {
            voiceId: this.nodeId,
            voice: this,
            midiNote: this.#activeMidiNote,
          };
          this.#activeMidiNote = null;
          break;

        case "voice:releasing":
          this.#state = VoiceState.RELEASING;
          data = {
            voiceId: this.nodeId,
            voice: this,
            midiNote: this.#activeMidiNote,
          };
          break;

        case "loop:enabled":
          break;

        case "voice:looped":
          break;

        case "voice:playbackDirectionChange":
          break;

        case "voice:position":
          this.getParam("playbackPosition")?.setValueAtTime(
            data.position,
            this.context.currentTime,
          );
          break;

        case "debug:params":
          console.debug(
            "Debug params: ",
            { loopStart: data.loopStart },
            { loopStartSamples: data.loopStartSamples },
            { loopEnd: data.loopEnd },
            { loopEndSamples: data.loopEndSamples },
          );
          break;

        case "debug:release":
          console.debug("SampleVoice release debug:", data);
          break;

        case "debug:loop":
          console.log("Loop debug:", data);
          break;

        default:
          console.warn(`Unhandled message type: ${type}`);
          break;
      }

      this.sendUpstreamMessage(type, data);
    };
  }

  // Getters

  getPlaybackDuration() {
    const startPoint = this.getParam("startPoint")!.value;
    const endPoint = this.getParam("endPoint")!.value;
    return endPoint - startPoint;
  }

  get isActive() {
    return this.#activeMidiNote !== null;
  }

  get feedback() {
    return this.#feedback;
  }

  get currMidiNote(): number | null {
    return this.#activeMidiNote;
  }

  get hpf() {
    return this.#hpf;
  }

  get lpf() {
    return this.#lpf;
  }

  get in() {
    return null;
  }

  get out() {
    return this.#outputNode;
  }

  get state(): VoiceState {
    return this.#state;
  }

  get initialized() {
    return this.#isInitialized;
  }

  get now(): number {
    return this.context.currentTime;
  }

  get activeNoteId(): number | string | null {
    return this.#activeMidiNote;
  }

  get triggerTimestamp(): number {
    return this.#startedTimestamp;
  }

  get sampleDurationSeconds() {
    return this.#sampleDurationSeconds;
  }

  get startPoint() {
    return this.getParam("startPoint")!.value;
  }

  get endPoint() {
    return this.getParam("endPoint")!.value;
  }

  get releaseTime() {
    return this.#envelopes.get("amp-env")!.effectiveReleaseDuration;
  }

  // Setters

  setMasterGain(gain: number) {
    const param = this.#playerWorklet.parameters.get("masterGain")!;
    param.cancelScheduledValues(this.context.currentTime);
    param.setTargetAtTime(gain, this.context.currentTime, 0.006);
  }

  enablePositionTracking(enabled: boolean) {
    this.sendToProcessor({
      type: "voice:usePlaybackPosition",
      value: enabled,
    });

    return this;
  }

  setLoopEnabled(enabled: boolean): this {
    this.sendToProcessor({
      type: "setLoopEnabled",
      value: enabled,
    });

    if (!enabled && this.#activeMidiNote !== null) this.release({});
    return this;
  }

  setEnvelopeLoop = (
    envType: EnvelopeType,
    loop: boolean,
    mode: "normal" | "ping-pong" | "reverse" = "normal",
  ) => {
    const env = this.#envelopes.get(envType);
    env?.setLoopEnabled(loop, mode);
    return this;
  };

  syncEnvelopeToPlaybackRate = (envType: EnvelopeType, sync: boolean) => {
    const env = this.#envelopes.get(envType);
    env?.syncToPlaybackRate(sync);
    return this;
  };

  setPlaybackRate(
    rate: number,
    atTime = this.now,
    options?: {
      glideTime?: number;
      cancelPrevious?: boolean;
    },
  ): this {
    this.setParam("playbackRate", rate, atTime, options);
    this.#updateHPFCutoffForPlaybackRate(rate, atTime, options);
    this.#updateLPFCutoffForPlaybackRate(rate, atTime, options);
    return this;
  }

  setHpfCutoff(
    hz: number,
    atTime: number = this.now,
    options: { glideTime?: number; cancelPrevious?: boolean } = {},
  ) {
    if (!this.#chainIncludes("hpf")) return this;

    const safeHz = clampHz(hz, this.context.sampleRate);
    this.#hpfHz = safeHz;
    if (this.#hpf) {
      this.setParam("hpf", safeHz, atTime, { glideTime: 0 });
      // this.#hpf.frequency.setValueAtTime(safeHz, this.now);
      const currentRate = this.getParam("playbackRate")?.value ?? 1;
      this.#updateHPFCutoffForPlaybackRate(currentRate, atTime, options);
    }
    return this;
  }

  setLpfCutoff(
    hz: number,
    atTime: number = this.now,
    options: { glideTime?: number; cancelPrevious?: boolean } = {},
  ) {
    if (!this.#chainIncludes("lpf")) return this;

    const safeHz = clampHz(hz, this.context.sampleRate);
    this.#lpfHz = safeHz;
    if (this.#lpf) {
      this.setParam("lpf", safeHz, atTime, {
        glideTime: 0,
        cancelPrevious: true,
      });
      const currentRate = this.getParam("playbackRate")?.value ?? 1;
      this.#updateLPFCutoffForPlaybackRate(currentRate, atTime, options);
    }
    return this;
  }

  setPlaybackDirection(direction: "forward" | "reverse"): this {
    this.sendToProcessor({
      type: "voice:setPlaybackDirection",
      playbackDirection: direction,
    });

    return this;
  }

  setLoopDurationDriftAmount(amount: number): this {
    if (amount === 0) {
      this.setParam("loopDurationDriftAmount", 0, this.now);
      return this;
    }

    const NEAR_ZERO_FOR_GEOMETRIC = 0.0001; // outputRange.min must be > 0
    const MAX_LOOP_DRIFT = 1; // todo: use audio param's maxValue

    const interpolated = interpolateLinearToGeometric(amount, {
      inputRange: { min: 0, max: 1 },
      outputRange: {
        min: NEAR_ZERO_FOR_GEOMETRIC,
        max: MAX_LOOP_DRIFT,
      },
      blend: 1, // blend: 0.5 = 50% geometric, 50% linear
      curve: "linear",
    });
    this.setParam("loopDurationDriftAmount", interpolated, this.now);
    return this;
  }

  setPanDriftEnabled = (enabled: boolean) =>
    this.sendToProcessor({ type: "setPanDriftEnabled", value: enabled });

  setTimestretchEnabled = (enabled: boolean) =>
    this.sendToProcessor({ type: "setPreserveDuration", value: enabled });

  debugDuration() {
    console.info(`
      sample duration: ${this.sampleDurationSeconds}, 
      startPoint: ${this.getParam("startPoint")!.value},
      endPoint: ${this.getParam("endPoint")!.value},
      playback duration: ${this.getPlaybackDuration()}
      `);
  }

  dispose(): void {
    this.stop();
    this.disconnect();
    this.#cleanupAmpModLFO();
    this.#envelopes.forEach((env) => env.dispose());
    this.#playerWorklet.port.close();
    if (this.#releaseTimeout) clearTimeout(this.#releaseTimeout);
    if (this.#stopTimeout) clearTimeout(this.#stopTimeout);
    unregisterNode(this.nodeId);
  }

  getParam(name: string): AudioParam | null {
    if (this.#playerWorklet && this.#playerWorklet.parameters.has(name)) {
      return this.#playerWorklet.parameters.get(name) ?? null;
    }

    switch (name) {
      case "highpass":
      case "hpf":
        return this.#hpf?.frequency ?? null;
      case "lowpass":
      case "lpf":
        return this.#lpf?.frequency ?? null;
      case "hpfQ":
        return this.#hpf?.Q ?? null;
      case "lpfQ":
        return this.#lpf?.Q ?? null;
      default:
        return null;
    }
  }
}
