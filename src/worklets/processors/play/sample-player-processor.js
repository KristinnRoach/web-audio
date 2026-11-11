import { SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS } from './sample-player-paramdescriptors.ts';
import { VoiceEngine } from './engine/voice-engine.js';

export class SamplePlayerProcessor extends AudioWorkletProcessor {
  // ===== PARAMETER DESCRIPTORS =====
  static get parameterDescriptors() {
    return SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS;
  }

  // ===== CONSTRUCTOR =====

  constructor() {
    super();

    this.engine = new VoiceEngine({
      sampleRate,
      random: () => Math.random(),
      post: (message) => this.port.postMessage(message),
    });

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
    } = event.data;
    const engine = this.engine;

    switch (type) {
      case 'setLoopQuantizePeriods':
        engine.setLoopQuantizePeriods(value);
        break;

      case 'voice:reset':
        engine.reset();
        this.port.postMessage({ type: 'voice:reset' });
        break;

      case 'voice:setBuffer': {
        engine.setBuffer(buffer);

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
        engine.start(triggerId, timestamp);
        break;

      case 'voice:stop':
        engine.stop();
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

        this.port.postMessage({
          type: 'voice:playbackDirectionChange',
          playbackDirection,
        });
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

    this.engine.render(outputChannels, parameters, currentFrame, currentTime);
    return true;
  }
}

registerProcessor('sample-player-processor', SamplePlayerProcessor);
