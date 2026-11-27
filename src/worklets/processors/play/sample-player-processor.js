import { SAMPLE_PLAYER_WORKLET_AUDIOPARAM_DESCRIPTORS } from './sample-player-paramdescriptors.ts';
import { SamplePlayerVoice } from './engine/sample-player-voice.js';
import { VoicePool } from './engine/voice-pool.js';

/**
 * One processor per player. It owns every voice: `processorOptions.voiceCount`
 * `VoiceSlot`s (each wrapping a `SamplePlayerVoice`) sharing one `VoicePool`
 * and one set of AudioParams. Voice `i` renders to output `2i` (stereo) and
 * `2i + 1` (its filter envelope in cents).
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
    // One voice slot per voice: tracks allocator state and owns its SamplePlayerVoice and postMessage.
    this.voiceSlots = Array.from(
      { length: options?.processorOptions?.voiceCount ?? 1 },
      (_, index) => {
        const postMessage = (message) => this.port.postMessage({ ...message, voice: index });
        const voice = new SamplePlayerVoice({
          sampleRate,
          random: () => Math.random(),
          postMessage: (message) => {
            if (message.type === 'voice:ended') voiceSlot.markAvailable();
            postMessage(message);
          },
        });
        const voiceSlot = this.pool.addVoice(voice, { postMessage });
        return voiceSlot;
      },
    );
    // The first voice: the voice tests drive a one-voice processor through it.
    this.voiceSlot = this.voiceSlots[0];
    this.voice = this.voiceSlot.voice;

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
    for (const target of index === undefined ? this.voiceSlots : [this.voiceSlots[index]]) {
      this.#handleVoiceMessage(target, event.data);
    }
    // Once per buffer, after every voice it addressed has it.
    if (type === 'voice:setBuffer') {
      const { durationSeconds } = event.data;
      this.port.postMessage({ type: 'voice:loaded', durationSeconds, time: currentTime });
    }
  }

  #handleVoiceMessage(voiceSlot, data) {
    const { voice, postMessage } = voiceSlot;
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
        voice.setLoopQuantizePeriods(value);
        break;

      case 'voice:setBuffer': {
        // The swap drops a sounding note without a report. The node stops its
        // own first, but a note the pool started meanwhile is news to it.
        // Allocation can already be available while a scheduled stop is still pending.
        if (voice.isPlaying) {
          voiceSlot.markAvailable();
          postMessage({ type: 'voice:ended', triggerId: voice.triggerId });
        }
        voice.setBuffer(buffer);
        break;
      }

      case 'voice:setZeroCrossings':
        voice.setZeroCrossings(zeroCrossings);
        break;

      case 'voice:setPitchPeriods':
        voice.setPitchPeriods(periods, hopSamples);
        break;

      // Voice tests start and stop a voice directly; SamplePlayer goes through the pool.
      case 'voice:start':
        voiceSlot.start(triggerId, timestamp, this.pool.note(data));
        break;

      case 'voice:stop':
        voiceSlot.stop(timestamp);
        break;

      case 'voice:setEnvelope':
        voice.setEnvelope(target, value);
        break;

      case 'voice:setLoopEnabled':
        voice.loopEnabled = value;
        break;

      case 'voice:setLoopPingPong':
        voice.loopPingPong = value;
        break;

      case 'voice:setPanDriftEnabled':
        voice.setPanDriftEnabled(value);
        break;

      case 'voice:setPlaybackDirection': {
        voice.playbackDirection = playbackDirection;
        break;
      }

      // Starts on the resolved loop.
      case 'voice:setStartFromLoop':
        voice.startFromLoop = value;
        break;

      case 'voice:reportPlayheadPosition':
        voice.reportPlayheadPosition = value;
        break;

      case 'voice:setLoopLengthGlide':
        voice.setLoopLengthGlide(value);
        break;

      case 'voice:setLoopPositionGlide':
        voice.setLoopPositionGlide(value);
        break;

      case 'voice:setKeytrackLoopAmount':
        voice.setKeytrackLoopAmount(value);
        break;

      case 'voice:setTimestretchMode':
        voice.setTimestretchMode(value);
        break;

      case 'voice:setGrainSpeed':
        voice.setGrainSpeed(value);
        break;

      case 'voice:setGrainScatter':
        voice.setGrainScatter(value);
        break;

      case 'voice:setGrainSize':
        voice.setGrainSize(value);
        break;

      case 'voice:setInterpolation':
        voice.interpolation = value;
        break;
    }
  }

  // ===== MAIN PROCESS METHOD =====

  process(inputs, outputs, parameters) {
    this.pool.advance(currentTime + (outputs[0]?.[0]?.length ?? 128) / sampleRate);

    this.voiceSlots.forEach(({ voice }, index) => {
      const output = outputs[index * 2];
      if (!output) return;
      if (!voice.canRender) return voice.reportIdle(parameters, currentTime);
      // Second output: the filter envelope in cents, silent (0) when inactive.
      voice.render(output, parameters, currentFrame, currentTime, outputs[index * 2 + 1]?.[0]);
    });
    return true;
  }
}

registerProcessor('sample-player-processor', SamplePlayerProcessor);
