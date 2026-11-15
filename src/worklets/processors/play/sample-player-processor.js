import { SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS } from './sample-player-paramdescriptors.ts';
import { VoiceEngine } from './engine/voice-engine.js';
import { PoolVoice, VoicePool } from './engine/voice-pool.js';

// Every processor in a context shares this scope, which is how the voices of
// one player meet: each joins the pool named in its options.
const pools = new Map();

export class SamplePlayerProcessor extends AudioWorkletProcessor {
  // ===== PARAMETER DESCRIPTORS =====
  static get parameterDescriptors() {
    return SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS;
  }

  // ===== CONSTRUCTOR =====

  constructor(options) {
    super();

    this.engine = new VoiceEngine({
      sampleRate,
      random: () => Math.random(),
      post: (message) => {
        this.voice.observe(message);
        this.port.postMessage(message);
      },
    });
    this.voice = new PoolVoice(this.engine, (message) => this.port.postMessage(message));

    this.poolId = options?.processorOptions?.poolId;
    if (this.poolId !== undefined) {
      if (!pools.has(this.poolId)) pools.set(this.poolId, new VoicePool());
      this.pool = pools.get(this.poolId);
      this.pool.addVoice(this.voice);
    }

    this.port.onmessage = this.#handleMessage.bind(this);

    // Signal to node that processor is initialized
    this.port.postMessage({ type: 'initialized' });
  }

  // ===== MESSAGE HANDLING =====

  #handleMessage(event) {
    const {
      type,
      value,
      buffer,
      timestamp,
      durationSeconds,
      zeroCrossings,
      periods,
      hopSamples,
      playbackDirection,
      triggerId,
      target,
    } = event.data;
    const engine = this.engine;

    switch (type) {
      case 'setLoopQuantizePeriods':
        engine.setLoopQuantizePeriods(value);
        break;

      case 'voice:setBuffer': {
        // The swap drops a sounding note without a report. The node stops its
        // own first, but a note the pool started meanwhile is news to it.
        // Allocation can already be available while a scheduled stop is still pending.
        if (engine.isPlaying) {
          const ended = { type: 'voice:ended', triggerId: engine.triggerId };
          this.voice.observe(ended);
          this.port.postMessage(ended);
        }
        engine.setBuffer(buffer);
        this.voice.bufferId = event.data.bufferId;

        this.port.postMessage({
          type: 'voice:loaded',
          durationSeconds,
          time: currentTime,
        });
        break;
      }

      case 'voice:setZeroCrossings':
        engine.setZeroCrossings(zeroCrossings);
        break;

      case 'voice:setPitchPeriods':
        engine.setPitchPeriods(periods, hopSamples);
        break;

      case 'voice:start':
        this.voice.start(triggerId, timestamp, event.data);
        break;

      case 'voice:setRate':
        engine.setNoteRate(timestamp, value, event.data.glideSeconds);
        break;

      case 'voice:stop':
        this.voice.stop(timestamp);
        break;

      case 'voice:release':
        this.voice.release(timestamp);
        break;

      case 'pool:noteOn':
      case 'pool:noteOff':
      case 'pool:allNotesOff':
      case 'pool:expectBuffer':
        this.pool?.schedule(event.data);
        break;

      case 'pool:setLegato':
        if (this.pool) this.pool.allocator.legato = value;
        break;

      case 'pool:dispose':
        pools.delete(this.poolId);
        break;

      case 'setEnvelope':
        engine.setEnvelope(target, value);
        break;

      case 'setLoopEnabled':
        engine.loopEnabled = value;

        this.port.postMessage({
          type: 'loop:enabled',
          enabled: value,
        });
        break;

      case 'setLoopPingPong':
        engine.loopPingPong = value;
        break;

      case 'setPanDriftEnabled':
        engine.setPanDriftEnabled(value);
        break;

      case 'voice:setPlaybackDirection': {
        // Global invert; inverted trim points flip it again in the engine
        engine.reversePlayback = playbackDirection === 'reverse';
        break;
      }

      case 'voice:reportPlaybackPosition':
        engine.reportPlaybackPosition = value;
        break;

      case 'setLoopLengthGlide':
        engine.setLoopLengthGlide(value);
        break;

      case 'setLoopPositionGlide':
        engine.setLoopPositionGlide(value);
        break;

      case 'setKeytrackLoopAmount':
        engine.setKeytrackLoopAmount(value);
        break;

      case 'setTimestretchMode':
        engine.setTimestretchMode(value);
        break;

      case 'setInterpolation':
        engine.interpolation = value;
        break;
    }
  }

  // ===== MAIN PROCESS METHOD =====

  process(inputs, outputs, parameters) {
    const output = outputs[0];

    // Whichever voice renders first settles the notes due in this block for all of them.
    this.pool?.advance(currentTime + (output?.[0]?.length ?? 128) / sampleRate);

    if (!output || !this.engine.canRender) {
      if (output) this.engine.reportIdle(parameters, currentTime);
      return true;
    }

    // Handle different output structures
    let outputChannels;
    if (output instanceof Float32Array) {
      // Case 1: output is a single Float32Array (mono output - legacy)
      outputChannels = [output];
    } else if (Array.isArray(output) && output.every((ch) => ch instanceof Float32Array)) {
      // Case 2: output is array of Float32Arrays (stereo/multi-channel output)
      outputChannels = output;
    } else {
      console.error('Unexpected output structure:', {
        outputType: typeof output,
        isArray: Array.isArray(output),
        constructor: output?.constructor?.name,
        length: output?.length,
      });
      return true;
    }

    // Optional second output: the filter envelope in cents, silent (0) when inactive.
    const filterOutput = outputs[1]?.[0];
    this.engine.render(outputChannels, parameters, currentFrame, currentTime, filterOutput);
    return true;
  }
}

registerProcessor('sample-player-processor', SamplePlayerProcessor);
