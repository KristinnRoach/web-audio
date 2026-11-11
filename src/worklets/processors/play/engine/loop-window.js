// One resolved window in source samples. Direction is the requested loop order;
// the voice keeps its current travel direction until the next loop edge.
// Two instances per voice let the playhead carry compare against the preceding window.
export class LoopWindow {
  start = 0;
  length = 0;
  direction = 1;
  isPitchLoop = false;
  audioStart = 0;
  audioEnd = 0;

  get end() {
    return this.start + this.length;
  }
}
