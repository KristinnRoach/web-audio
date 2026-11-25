import { midiToPlaybackRate } from '@/utils/music-theory/utils/core-utils.ts';
import { VoiceAllocator } from './voice-allocator.js';

/**
 * One rendering voice as the allocator sees it. Every lifecycle command goes
 * through here, from the pool or straight from the voice's node, so `state`
 * is true on the audio thread at the moment a note event is decided.
 */
export class PoolVoice {
  state = 'AVAILABLE';
  midiNote = null;
  triggerTimestamp = -1;
  #inPitchLoop = false;

  /** `post` reaches this voice's node. */
  constructor(engine, post) {
    this.engine = engine;
    this.post = post;
  }

  get isInPitchLoop() {
    return this.state === 'PLAYING' && this.engine.loopEnabled && this.#inPitchLoop;
  }

  start(triggerId, timestamp, note = {}) {
    this.state = 'PLAYING';
    this.midiNote = note.midiNote ?? null;
    this.triggerTimestamp = timestamp ?? 0;
    this.#inPitchLoop = false;
    this.engine.start(triggerId, timestamp, note);
  }

  release(timestamp) {
    if (this.state === 'PLAYING') this.state = 'RELEASING';
    this.engine.release(timestamp);
  }

  stop(timestamp) {
    this.#free();
    this.engine.stop(timestamp);
  }

  /** Engine reports pass through here on their way to the node. */
  observe(message) {
    if (message.type === 'voice:ended') this.#free();
    else if (message.type === 'loop:range' && !message.idle) {
      this.#inPitchLoop = !!message.isInPitchLoop;
    }
  }

  #free() {
    this.state = 'AVAILABLE';
    this.midiNote = null;
  }
}

/** Symmetric spread positions in [-1, 1] across `count` voices (0 for a single voice). */
const spreadOffset = (index, count) => (count <= 1 ? 0 : (2 * index) / (count - 1) - 1);

/**
 * One allocatable unison stack: `voices` start, retune, release and steal
 * together so `VoiceAllocator` treats the stack as one note.
 */
class VoiceGroup {
  constructor(voices) {
    this.voices = voices;
  }

  get state() {
    if (this.voices.some((voice) => voice.state === 'PLAYING')) return 'PLAYING';
    if (this.voices.some((voice) => voice.state === 'RELEASING')) return 'RELEASING';
    return 'AVAILABLE';
  }

  get midiNote() {
    return this.voices.find((voice) => voice.midiNote !== null)?.midiNote ?? null;
  }

  get triggerTimestamp() {
    return this.voices[0].triggerTimestamp;
  }

  get isInPitchLoop() {
    return this.voices.some((voice) => voice.isInPitchLoop);
  }
}

/**
 * A player's voices on the audio thread. Note events wait in a queue until
 * they are due, so the allocator decides from the voices as they are when the
 * note sounds, not when it was scheduled. Each voice reports what happened to
 * its node (`voice:started`, `voice:retuned`, `voice:releasing`).
 *
 * It also holds the pitch settings and works out every note's playback rate.
 */
export class VoicePool {
  allocator = new VoiceAllocator();
  /** Semitones added to every played note. */
  pitchOffset = 0;
  /** Off plays every note at rate 1. */
  pitchEnabled = true;
  #voices = [];
  #unison = { voices: 1, detune: 0, pan: 0 };
  #queue = [];
  // The played note a new note glides from, updated as events are applied.
  #glideOrigin = 60;

  addVoice(voice) {
    this.#voices.push(voice);
    this.#rebuildGroups();
  }

  /**
   * Groups pool voices into unison stacks of `voices` copies with symmetric
   * `detune` (+/- cents) and `pan` (+/- pan) spread. Remainder voices stay idle.
   */
  setUnison({ voices = 1, detune = 0, pan = 0 } = {}) {
    this.#unison = { voices: Math.max(1, Math.floor(voices)), detune, pan };
    this.#rebuildGroups();
  }

  #rebuildGroups() {
    const count = this.#voices.length;
    if (!count) {
      this.allocator.voices = [];
      return;
    }
    const groupSize = Math.min(this.#unison.voices, count);
    const groupCount = Math.floor(count / groupSize);
    const gain = 1 / Math.sqrt(groupSize);
    const groups = [];

    for (let g = 0; g < groupCount; g++) {
      const members = this.#voices.slice(g * groupSize, (g + 1) * groupSize);
      members.forEach((voice, i) => {
        const spread = spreadOffset(i, groupSize);
        voice.engine.detuneOffset = spread * this.#unison.detune;
        voice.engine.panOffset = spread * this.#unison.pan;
        voice.engine.unisonGain = gain;
      });
      groups.push(new VoiceGroup(members));
    }

    for (let i = groupCount * groupSize; i < count; i++) {
      this.#voices[i].engine.detuneOffset = 0;
      this.#voices[i].engine.panOffset = 0;
      this.#voices[i].engine.unisonGain = 1;
    }

    this.allocator.clear();
    this.allocator.voices = groups;
  }

  /** `pool:noteOn`, `pool:noteOff` or `pool:allNotesOff`, each with a `timestamp` in seconds. */
  schedule(event) {
    if (event.type === 'pool:allNotesOff') {
      // Takes notes that have not sounded yet with it.
      this.#queue.length = 0;
      for (const voice of this.#voices) {
        if (voice.state === 'PLAYING') this.#release(voice, event.timestamp);
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
    return this.pitchEnabled ? midiToPlaybackRate(midiNote + this.pitchOffset) : 1;
  }

  /** What an engine starts a note with. `glideFromNote` is a played note, or null. */
  note({ midiNote, velocity, glideTime, glideFromNote }) {
    const glides = this.pitchEnabled && glideTime > 0 && glideFromNote != null;
    return {
      midiNote,
      velocity,
      // A start without a note (engine tests) plays the sample at its own pitch.
      playbackRate: this.rate(midiNote ?? 60),
      ...(glides && { glideFrom: this.rate(glideFromNote), glideSeconds: glideTime }),
    };
  }

  /** Retunes every voice that has a note, at `time`. */
  setPitchOffset(semitones, time) {
    if (this.pitchOffset === semitones) return;
    this.pitchOffset = semitones;
    this.#retuneAll(time, this.pitchEnabled ? 0.01 : 0);
  }

  setPitchEnabled(enabled, time) {
    this.pitchEnabled = enabled;
    // Time constants: about 95% there after 0.1 s (off) or 0.01 s (on).
    if (enabled) this.#retuneAll(time, 0.01 / 3);
    else for (const voice of this.#voices) voice.engine.setNoteRate(time, 1, 0.1 / 3);
  }

  #retuneAll(time, glideSeconds) {
    for (const voice of this.#voices) {
      if (voice.midiNote !== null) {
        voice.engine.setNoteRate(time, this.rate(voice.midiNote), glideSeconds);
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
        for (const voice of action.voice.voices) {
          if (voice.state !== 'PLAYING') continue;
          if (action.type === 'release') this.#release(voice, timestamp);
          else
            this.#retune(voice, { midiNote: action.midiNote, timestamp }, action.glideTime, true);
        }
      }
      return;
    }

    const glideFromNote = this.#glideOrigin;
    this.#glideOrigin = midiNote;
    const decision = this.allocator.noteOn(midiNote, event.glideTime);
    if (!decision) return;
    const { glideTime } = decision;

    for (const { type, voice: group } of decision.actions) {
      // ponytail: the start that follows replaces the stolen note from the top of this
      // block, up to one block (~3 ms) before `timestamp`. Exact once the engine can
      // hold a pending note while the old one plays out.
      if (type === 'steal') {
        for (const voice of group.voices) voice.stop(timestamp);
      } else if (type === 'release') {
        for (const voice of group.voices) {
          if (voice.state === 'PLAYING') this.#release(voice, timestamp);
        }
      } else {
        for (const voice of group.voices) {
          if (type === 'retune') {
            if (voice.state === 'PLAYING') this.#retune(voice, event, glideTime, false);
          } else {
            this.#start(voice, event, glideTime, glideFromNote);
          }
        }
        decision.commit();
      }
    }
  }

  #start(voice, event, glideTime, glideFromNote) {
    const { triggerId, timestamp, midiNote, velocity } = event;
    if (glideTime <= 0) glideFromNote = null;
    // Posted before the engine starts, so the node knows the note before its first report.
    voice.post({
      type: 'voice:started',
      triggerId,
      midiNote,
      velocity,
      timestamp,
      glideTime,
      glideFromNote,
    });
    voice.start(triggerId, timestamp, this.note({ midiNote, velocity, glideTime, glideFromNote }));
  }

  /** `fallback`: a note-off returned the voice to an earlier held note. */
  #retune(voice, { midiNote, timestamp }, glideTime, fallback) {
    voice.midiNote = midiNote;
    if (fallback) this.#glideOrigin = midiNote;
    // With pitch off a legato note keeps its glide, so it does not cut the ramp to rate 1 short.
    const glides = this.pitchEnabled || !fallback;
    voice.engine.setNoteRate(timestamp, this.rate(midiNote), glides ? glideTime : 0);
    voice.post({
      type: 'voice:retuned',
      midiNote,
      timestamp,
      glideTime,
    });
  }

  #release(voice, timestamp) {
    voice.post({ type: 'voice:releasing' });
    voice.release(timestamp);
  }
}
