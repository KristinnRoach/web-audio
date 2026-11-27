import { midiToPlaybackRate } from '@/utils/music-theory/utils/core-utils.ts';
import { VoiceAllocator } from './voice-allocator.js';

/**
 * One voice slot as the allocator sees it. Every lifecycle command goes
 * through here, from the pool or straight from the voice's node, so `state`
 * is true on the audio thread at the moment a note event is decided.
 */
class VoiceSlot {
  state = 'AVAILABLE';
  midiNote = null;
  triggerTimestamp = -1;

  /** `postMessage` reaches this voice's node. */
  constructor(voice, postMessage) {
    this.voice = voice;
    this.postMessage = postMessage;
  }

  get isInPitchLoop() {
    return this.state === 'PLAYING' && this.voice.loopEnabled && this.voice.isInPitchLoop;
  }

  start(triggerId, timestamp, note = {}) {
    this.state = 'PLAYING';
    this.midiNote = note.midiNote ?? null;
    this.triggerTimestamp = timestamp ?? 0;
    this.voice.start(triggerId, timestamp, note);
  }

  release(timestamp) {
    if (this.state === 'PLAYING') this.state = 'RELEASING';
    this.voice.release(timestamp);
  }

  stop(timestamp) {
    this.markAvailable();
    this.voice.stop(timestamp);
  }

  markAvailable() {
    this.state = 'AVAILABLE';
    this.midiNote = null;
  }
}

/**
 * A player's voice slots on the audio thread. Note events wait in a queue until
 * they are due, so the allocator decides from the slots as they are when the
 * note sounds, not when it was scheduled. Each slot reports what happened to
 * its node (`voice:started`, `voice:retuned`, `voice:releasing`).
 *
 * It also holds the pitch settings and works out every note's playback rate.
 */
export class VoicePool {
  allocator = new VoiceAllocator();
  /** Semitones added to every played note. */
  #pitchOffset = 0;
  /** Off plays every note at rate 1. */
  #pitchEnabled = true;
  #queue = [];
  // The played note a new note glides from, updated as events are applied.
  #glideOrigin = 60;

  addVoice(voice, { postMessage }) {
    const slot = new VoiceSlot(voice, postMessage);
    this.allocator.voiceSlots.push(slot);
    return slot;
  }

  /** `pool:noteOn`, `pool:noteOff` or `pool:allNotesOff`, each with a `timestamp` in seconds. */
  schedule(event) {
    if (event.type === 'pool:allNotesOff') {
      // Takes notes that have not sounded yet with it.
      this.#queue.length = 0;
      for (const slot of this.allocator.voiceSlots) {
        if (slot.state === 'PLAYING') this.#release(slot, event.timestamp);
      }
      return;
    }
    // Insert after equal timestamps, preserving post order without re-sorting the
    // entire queue for every message in a scheduled burst on the audio thread.
    let low = 0;
    let high = this.#queue.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (this.#queue[middle].timestamp <= event.timestamp) low = middle + 1;
      else high = middle;
    }
    this.#queue.push(event);
    for (let index = this.#queue.length - 1; index > low; index--) {
      this.#queue[index] = this.#queue[index - 1];
    }
    this.#queue[low] = event;
  }

  /** A played note's rate under the current pitch settings. */
  rate(midiNote) {
    return this.#pitchEnabled ? midiToPlaybackRate(midiNote + this.#pitchOffset) : 1;
  }

  /** What a voice starts a note with. `glideFromNote` is a played note, or null. */
  note({ midiNote, velocity, glideTime, glideFromNote }) {
    const glides = this.#pitchEnabled && glideTime > 0 && glideFromNote != null;
    return {
      midiNote,
      velocity,
      // A start without a note (voice tests) plays the sample at its own pitch.
      noteRate: this.rate(midiNote ?? 60),
      ...(glides && { glideFrom: this.rate(glideFromNote), glideSeconds: glideTime }),
    };
  }

  /** Retunes every slot that has a note, at `time`. */
  setPitchOffset(semitones, time) {
    if (this.#pitchOffset === semitones) return;
    this.#pitchOffset = semitones;
    this.#retuneAll(time, this.#pitchEnabled ? 0.01 : 0);
  }

  setPitchEnabled(enabled, time) {
    this.#pitchEnabled = enabled;
    // Time constants: about 95% there after 0.1 s (off) or 0.01 s (on).
    if (enabled) this.#retuneAll(time, 0.01 / 3);
    else for (const slot of this.allocator.voiceSlots) slot.voice.setNoteRate(time, 1, 0.1 / 3);
  }

  #retuneAll(time, glideSeconds) {
    for (const slot of this.allocator.voiceSlots) {
      if (slot.midiNote !== null) {
        slot.voice.setNoteRate(time, this.rate(slot.midiNote), glideSeconds);
      }
    }
  }

  /** Applies every event due before `time`. Call at the top of each render block. */
  advance(time) {
    while (this.#queue.length && this.#queue[0].timestamp < time) this.#apply(this.#queue.shift());
  }

  #apply(event) {
    const { timestamp, midiNote } = event;

    if (event.type === 'pool:noteOff') {
      for (const action of this.allocator.noteOff(midiNote)) {
        if (action.type === 'release') this.#release(action.voice, timestamp);
        else
          this.#retune(
            action.voice,
            { midiNote: action.midiNote, timestamp },
            action.glideTime,
            true,
          );
      }
      return;
    }

    const glideFromNote = this.#glideOrigin;
    this.#glideOrigin = midiNote;
    const decision = this.allocator.noteOn(midiNote, event.glideTime);
    if (!decision) return;
    const { glideTime } = decision;

    for (const { type, voice: slot } of decision.actions) {
      // ponytail: the start that follows replaces the stolen note from the top of this
      // block, up to one block (~3 ms) before `timestamp`. Exact once the voice can
      // hold a pending note while the old one plays out.
      if (type === 'steal') slot.stop(timestamp);
      else if (type === 'release') this.#release(slot, timestamp);
      else {
        if (type === 'retune') this.#retune(slot, event, glideTime, false);
        else this.#start(slot, event, glideTime, glideFromNote);
        decision.commit();
      }
    }
  }

  #start(slot, event, glideTime, glideFromNote) {
    const { triggerId, timestamp, midiNote, velocity } = event;
    if (glideTime <= 0) glideFromNote = null;
    // Posted before the voice starts, so the node knows the note before its first report.
    slot.postMessage({
      type: 'voice:started',
      triggerId,
      midiNote,
      velocity,
      timestamp,
      glideTime,
      glideFromNote,
    });
    slot.start(triggerId, timestamp, this.note({ midiNote, velocity, glideTime, glideFromNote }));
  }

  /** `fallback`: a note-off returned the slot to an earlier held note. */
  #retune(slot, { midiNote, timestamp }, glideTime, fallback) {
    slot.midiNote = midiNote;
    if (fallback) this.#glideOrigin = midiNote;
    // With pitch off a legato note keeps its glide, so it does not cut the ramp to rate 1 short.
    const glides = this.#pitchEnabled || !fallback;
    slot.voice.setNoteRate(timestamp, this.rate(midiNote), glides ? glideTime : 0);
    slot.postMessage({
      type: 'voice:retuned',
      midiNote,
      timestamp,
      glideTime,
    });
  }

  #release(slot, timestamp) {
    slot.postMessage({ type: 'voice:releasing' });
    slot.release(timestamp);
  }
}
