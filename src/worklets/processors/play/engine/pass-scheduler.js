// Plays a note as a sequence of passes. The first runs from the note start toward the
// trim end. Once the playhead reaches the loop, each pass plays the latched loop window.
// A pass ends at its edge in the direction of travel. There the playhead lands on the
// next pass (wrap or turn), plays on to the trim end (loop turned off), or stops (the
// note's last edge). The voice hands the playhead off to a fading grain at every edge
// that moves or stops it; see GrainPool.
//
// Pass ends are shrink only: an edit can pull the current pass's end in, never push it
// out. Edits that would push it out, and loop moves, are heard from the next pass. The
// approach is the exception: the loop latches when the playhead reaches it, so loop
// edits before then apply live.

import { reflectLoopPosition, wrapLoopPosition } from './loop-edges.js';
import { LoopWindow } from './loop-window.js';

/** No edge this sample. */
export const EDGE_NONE = 0;
/** A loop pass starts; the playhead lands at `landing`. */
export const EDGE_LOOP = 1;
/** Loop turned off while travelling against the approach: turn back toward the trim end. */
export const EDGE_TURN_BACK = 2;
/** The note's last edge: the playhead stops. */
export const EDGE_END = 3;

export function isApproaching(position, approachDirection, window) {
  return approachDirection > 0 ? position < window.start : position >= window.end;
}

export class PassScheduler {
  /** The current pass in source samples. While `isLoopPass`, the latched loop window. */
  pass = new LoopWindow();
  isLoopPass = false;
  /**
   * True while travelling against the approach direction (reverse loops, or the
   * return half of a ping-pong). Direction = approach, negated when turned.
   */
  turned = false;
  /** After EDGE_LOOP or EDGE_TURN_BACK: where the playhead lands. */
  landing = 0;
  /** After an edge: whether the playhead turned there. */
  turnedAtEdge = false;
  /** After EDGE_LOOP: whether the new pass starts somewhere else (a loop move). */
  moved = false;
  /** After an edge: the ended pass's length when it started, before any shrink. Sizes the fade. */
  endedLength = 0;
  #startedAt = 0;
  #startLength = 0;

  /** The note's first pass: the trim range, played from the note start. */
  startNote(trimStart, trimEnd) {
    this.isLoopPass = false;
    this.turned = false;
    this.#setPass(trimStart, trimEnd - trimStart);
  }

  direction(approachDirection) {
    return this.turned ? -approachDirection : approachDirection;
  }

  /**
   * Pulls the current pass's end in, never out. A first pass ends at the trim edge.
   * A loop pass keeps where it started and takes on a shorter resolved length, so a
   * shorter loop is heard now while a move waits for the next pass.
   */
  pullEndIn(direction, trimRange, resolved) {
    const pass = this.pass;
    const end = pass.end;
    if (this.isLoopPass) {
      if (resolved.length >= pass.length) return;
      if (direction < 0) pass.start = end - resolved.length;
      pass.length = resolved.length;
    } else if (direction > 0) {
      if (trimRange.endSamples < end) pass.length = Math.max(0, trimRange.endSamples - pass.start);
    } else if (trimRange.startSamples > pass.start) {
      pass.start = Math.min(trimRange.startSamples, end);
      pass.length = end - pass.start;
    }
  }

  /** Latches the loop once the playhead is no longer approaching the resolved window. */
  enterLoop(position, approachDirection, resolved) {
    if (this.isLoopPass || isApproaching(position, approachDirection, resolved)) return false;
    this.#latch(resolved);
    return true;
  }

  /**
   * Checks the current pass's edge once per sample. `position` is the transport
   * position (the original-speed position while stretching), `step` its speed.
   * @returns {number} One of the EDGE_* values.
   */
  passEdge(position, approachDirection, step, loopEnabled, loopPingPong, resolved, trimRange) {
    const pass = this.pass;
    const direction = this.direction(approachDirection);
    const overshoot = direction > 0 ? position - pass.end : pass.start - position;
    const reached = direction > 0 ? overshoot >= 0 : overshoot > 0;
    this.turnedAtEdge = false;
    this.moved = false;
    if (!reached) return EDGE_NONE;
    this.endedLength = this.#startLength;
    // More than a step past the edge means an edit pulled it in behind the playhead:
    // carry no more than a step, so the playhead leaves from the edge.
    const carried = Math.min(overshoot, step);

    if (!this.isLoopPass) return EDGE_END;

    if (loopEnabled) {
      const turns = loopPingPong || this.turned !== resolved.direction < 0;
      // The same overshoot past the same edge of the resolved window.
      const shifted = direction > 0 ? resolved.end + carried : resolved.start - carried;
      const landing = turns
        ? reflectLoopPosition(shifted, direction, resolved.start, resolved.end)
        : wrapLoopPosition(shifted, direction, resolved.start, resolved.end);
      if (landing === null) return EDGE_NONE;
      this.landing = landing;
      this.turnedAtEdge = turns;
      this.moved = resolved.start !== this.#startedAt;
      if (turns) this.turned = !this.turned;
      this.#latch(resolved);
      return EDGE_LOOP;
    }

    // Loop turned off: the next pass plays on to the trim end.
    const turnsBack = this.turned;
    if (turnsBack) {
      const shifted = direction > 0 ? pass.end + carried : pass.start - carried;
      this.landing = reflectLoopPosition(shifted, direction, pass.start, pass.end) ?? shifted;
      this.turnedAtEdge = true;
    }
    this.startNote(trimRange.startSamples, trimRange.endSamples);
    return turnsBack ? EDGE_TURN_BACK : EDGE_NONE;
  }

  reset() {
    this.isLoopPass = false;
    this.turned = false;
    this.turnedAtEdge = false;
    this.moved = false;
  }

  #latch(window) {
    this.isLoopPass = true;
    this.pass.direction = window.direction;
    this.pass.isPitchLoop = window.isPitchLoop;
    this.#setPass(window.start, window.length);
  }

  #setPass(start, length) {
    this.pass.start = start;
    this.pass.length = length;
    this.#startedAt = start;
    this.#startLength = length;
  }
}
