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
  /** Counts pitch decisions, so a rate the node sends back for an older one can be dropped. */
  pitchId = 0;
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
    this.pitchId++;
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

/**
 * A player's voices on the audio thread. Note events wait in a queue until
 * they are due, so the allocator decides from the voices as they are when the
 * note sounds, not when it was scheduled. Each voice reports what happened to
 * its node (`voice:started`, `voice:retuned`, `voice:releasing`).
 */
export class VoicePool {
  allocator = new VoiceAllocator();
  #queue = [];
  #lastNoteId;

  addVoice(voice) {
    this.allocator.voices.push(voice);
  }

  /** `pool:noteOn`, `pool:noteOff` or `pool:allNotesOff`, each with a `timestamp` in seconds. */
  schedule(event) {
    if (event.type === 'pool:allNotesOff') {
      // Takes notes that have not sounded yet with it.
      this.#queue.length = 0;
      for (const voice of this.allocator.voices) {
        if (voice.state === 'PLAYING') this.#release(voice, event.timestamp);
      }
      return;
    }
    this.#queue.push(event);
    // Stable, so events at one timestamp keep the order they were posted in.
    this.#queue.sort((a, b) => a.timestamp - b.timestamp);
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
        // No rate here: the node works it out from its current pitch settings.
        else this.#retune(action.voice, { midiNote: action.midiNote, timestamp }, action.glideTime);
      }
      return;
    }

    this.#lastNoteId = event.triggerId;
    const decision = this.allocator.noteOn(midiNote, event.glideTime);
    if (!decision) return;
    const { glideTime } = decision;

    for (const { type, voice } of decision.actions) {
      // ponytail: the start that follows replaces the stolen note from the top of this
      // block, up to one block (~3 ms) before `timestamp`. Exact once the engine can
      // hold a pending note while the old one plays out.
      if (type === 'steal') voice.stop(timestamp);
      else if (type === 'release') this.#release(voice, timestamp);
      else {
        if (type === 'retune') this.#retune(voice, event, glideTime);
        else this.#start(voice, event, glideTime);
        decision.commit();
      }
    }
  }

  #start(voice, event, glideTime) {
    const { triggerId, timestamp, midiNote, velocity, playbackRate } = event;
    const glides = glideTime > 0 && event.glideFrom !== undefined;
    // Posted before the engine starts, so the node knows the note before its first report.
    voice.post({
      type: 'voice:started',
      triggerId,
      midiNote,
      velocity,
      timestamp,
      glideTime,
      glideFromNote: glideTime > 0 ? event.glideFromNote : null,
    });
    voice.start(triggerId, timestamp, {
      midiNote,
      playbackRate,
      velocity,
      ...(glides && { glideFrom: event.glideFrom, glideSeconds: glideTime }),
    });
  }

  #retune(voice, { midiNote, timestamp, velocity, playbackRate }, glideTime) {
    voice.midiNote = midiNote;
    voice.pitchId++;
    const fallback = playbackRate === undefined;
    if (!fallback) voice.engine.setNoteRate(timestamp, playbackRate, glideTime);
    voice.post({
      type: 'voice:retuned',
      midiNote,
      velocity,
      timestamp,
      glideTime,
      fallback,
      // Let the node tell whether its answer, or the glide origin, is already out of date.
      pitchId: voice.pitchId,
      noteId: this.#lastNoteId,
    });
  }

  #release(voice, timestamp) {
    voice.post({ type: 'voice:releasing' });
    voice.release(timestamp);
  }
}
