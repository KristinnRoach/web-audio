import { SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS } from './sample-player-paramdescriptors.ts';
import { VoiceEngine } from './engine/voice-engine.js';
import { PoolVoice, VoicePool } from './engine/voice-pool.js';

/**
 * One processor per player. It owns every voice: `processorOptions.voiceCount`
 * engines sharing one `VoicePool` and one set of AudioParams. Voice `i` renders
 * to output `2i` (stereo) and `2i + 1` (its filter envelope in cents).
 *
 * Voice messages with a `voice` index go to that voice; untagged ones go to all.
 * Pool commands and flush are node-wide. Voice reports carry their index;
 * initialized, flushed and voice:loaded are node-wide.
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
    // One slot per voice: its engine, pool voice and post function.
    this.slots = Array.from({ length: options?.processorOptions?.voiceCount ?? 1 }, (_, index) => {
      const post = (message) => this.port.postMessage({ ...message, voice: index });
      const engine = new VoiceEngine({
        sampleRate,
        random: () => Math.random(),
        post: (message) => {
          if (message.type === 'voice:ended') voice.markAvailable();
          post(message);
        },
      });
      const voice = new PoolVoice(engine, post);
      this.pool.addVoice(voice);
      return { engine, voice, post };
    });
    // The first voice: the engine tests drive a one-voice processor through it.
    ({ engine: this.engine, voice: this.voice } = this.slots[0]);

    this.port.onmessage = this.#handleMessage.bind(this);

    // Signal to node that processor is initialized
    this.port.postMessage({ type: 'initialized' });
  }

  // ===== MESSAGE HANDLING =====

  #handleMessage(event) {
    const { type, value } = event.data;

    switch (type) {
      case 'flush':
        // FIFO: preceding messages have been handled, including queued notes.
        this.port.postMessage({ type: 'flushed', id: event.data.id });
        return;

      case 'pool:noteOn':
      case 'pool:noteOff':
      case 'pool:allNotesOff':
        this.pool.schedule(event.data);
        return;

      case 'pool:setLegato':
        this.pool.allocator.legato = value;
        return;

      case 'pool:setPitchOffset':
        this.pool.setPitchOffset(value, currentTime);
        return;

      case 'pool:setPitchEnabled':
        this.pool.setPitchEnabled(value, currentTime);
        return;
    }

    const index = event.data.voice;
    for (const target of index === undefined ? this.slots : [this.slots[index]]) {
      this.#handleVoiceMessage(target, event.data);
    }
    // Once per buffer, after every voice it addressed has it.
    if (type === 'voice:setBuffer') {
      const { durationSeconds } = event.data;
      this.port.postMessage({ type: 'voice:loaded', durationSeconds, time: currentTime });
    }
  }

  #handleVoiceMessage({ engine, voice, post }, data) {
    const {
      type,
      value,
      buffer,
      timestamp,
      zeroCrossings,
      periods,
      hopSamples,
      playbackDirection,
      triggerId,
      target,
    } = data;

    switch (type) {
      case 'voice:setLoopQuantizePeriods':
        engine.setLoopQuantizePeriods(value);
        break;

      case 'voice:setBuffer': {
        // The swap drops a sounding note without a report. The node stops its
        // own first, but a note the pool started meanwhile is news to it.
        // Allocation can already be available while a scheduled stop is still pending.
        if (engine.isPlaying) {
          voice.markAvailable();
          post({ type: 'voice:ended', triggerId: engine.triggerId });
        }
        engine.setBuffer(buffer);
        break;
      }

      case 'voice:setZeroCrossings':
        engine.setZeroCrossings(zeroCrossings);
        break;

      case 'voice:setPitchPeriods':
        engine.setPitchPeriods(periods, hopSamples);
        break;

      // Engine tests start and stop a voice directly; SamplePlayer goes through the pool.
      case 'voice:start':
        voice.start(triggerId, timestamp, this.pool.note(data));
        break;

      case 'voice:stop':
        voice.stop(timestamp);
        break;

      case 'voice:setEnvelope':
        engine.setEnvelope(target, value);
        break;

      case 'voice:setLoopEnabled':
        engine.loopEnabled = value;
        break;

      case 'voice:setLoopPingPong':
        engine.loopPingPong = value;
        break;

      case 'voice:setPanDriftEnabled':
        engine.setPanDriftEnabled(value);
        break;

      case 'voice:setPlaybackDirection': {
        engine.playbackDirection = playbackDirection;
        break;
      }

      // Starts on the resolved loop.
      case 'voice:setStartFromLoop':
        engine.startFromLoop = value;
        break;

      case 'voice:reportPlayheadPosition':
        engine.reportPlayheadPosition = value;
        break;

      case 'voice:setLoopLengthGlide':
        engine.setLoopLengthGlide(value);
        break;

      case 'voice:setLoopPositionGlide':
        engine.setLoopPositionGlide(value);
        break;

      case 'voice:setKeytrackLoopAmount':
        engine.setKeytrackLoopAmount(value);
        break;

      case 'voice:setTimestretchMode':
        engine.setTimestretchMode(value);
        break;

      case 'voice:setInterpolation':
        engine.interpolation = value;
        break;
    }
  }

  // ===== MAIN PROCESS METHOD =====

  process(inputs, outputs, parameters) {
    this.pool.advance(currentTime + (outputs[0]?.[0]?.length ?? 128) / sampleRate);

    this.slots.forEach(({ engine }, index) => {
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
