import { SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS } from './sample-player-paramdescriptors.ts';
import { VoiceEngine } from './engine/voice-engine.js';
import { PoolVoice, VoicePool } from './engine/voice-pool.js';

/**
 * One processor per player. It owns every voice: `processorOptions.voiceCount`
 * engines sharing one `VoicePool` and one set of AudioParams. Voice `i` renders
 * to output `2i` (stereo) and `2i + 1` (its filter envelope in cents).
 *
 * A message with a `voice` index goes to that voice, and one without goes to
 * all of them. Every report carries the index of the voice it came from.
 * Messages and ordering: docs/SAMPLE_PLAYER_PROCESSOR.md.
 */
export class SamplePlayerProcessor extends AudioWorkletProcessor {
  // ===== PARAMETER DESCRIPTORS =====
  static get parameterDescriptors() {
    return SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS;
  }

  // ===== CONSTRUCTOR =====

  constructor(options) {
    super();

    this.pool = new VoicePool();
    this.voices = Array.from({ length: options?.processorOptions?.voiceCount ?? 1 }, (_, index) => {
      const post = (message) => this.port.postMessage({ ...message, voice: index });
      const engine = new VoiceEngine({
        sampleRate,
        random: () => Math.random(),
        post: (message) => {
          voice.observe(message);
          post(message);
        },
      });
      const voice = new PoolVoice(engine, post);
      this.pool.addVoice(voice);
      return { engine, voice, post };
    });
    // The first voice, for a processor that has only one.
    ({ engine: this.engine, voice: this.voice } = this.voices[0]);

    this.port.onmessage = this.#handleMessage.bind(this);

    // Signal to node that processor is initialized
    this.port.postMessage({ type: 'initialized' });
  }

  // ===== MESSAGE HANDLING =====

  #handleMessage(event) {
    const { type, value } = event.data;

    switch (type) {
      case 'pool:noteOn':
      case 'pool:noteOff':
      case 'pool:allNotesOff':
        this.pool.schedule(event.data);
        return;

      case 'pool:setLegato':
        this.pool.allocator.legato = value;
        return;
    }

    const index = event.data.voice;
    for (const target of index === undefined ? this.voices : [this.voices[index]]) {
      this.#handleVoiceMessage(target, event.data);
    }
  }

  #handleVoiceMessage({ engine, voice, post }, data) {
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
    } = data;

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
          voice.observe(ended);
          post(ended);
        }
        engine.setBuffer(buffer);

        post({
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
        voice.start(triggerId, timestamp, data);
        break;

      case 'voice:setRate':
        // An answer to a fallback the pool has since moved on from.
        if (data.pitchId !== undefined && data.pitchId !== voice.pitchId) break;
        engine.setNoteRate(timestamp, value, data.glideSeconds);
        break;

      case 'voice:stop':
        voice.stop(timestamp);
        break;

      case 'voice:release':
        voice.release(timestamp);
        break;

      case 'setEnvelope':
        engine.setEnvelope(target, value);
        break;

      case 'setLoopEnabled':
        engine.loopEnabled = value;

        post({
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
    this.pool.advance(currentTime + (outputs[0]?.[0]?.length ?? 128) / sampleRate);

    this.voices.forEach(({ engine }, index) => {
      const output = outputs[index * 2];
      if (!output) return;
      if (!engine.canRender) return engine.reportIdle(parameters, currentTime);
      // Second output: the filter envelope in cents, silent (0) when inactive.
      engine.render(output, parameters, currentFrame, currentTime, outputs[index * 2 + 1]?.[0]);
    });
    return true;
  }
}

registerProcessor('sample-player-processor', SamplePlayerProcessor);
