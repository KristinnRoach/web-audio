// One resolved window in source samples. Direction is the requested loop order;
// the voice keeps its current travel direction until the next loop edge.
// Two instances per voice: the window the params resolve to now, and the latched
// window the current pass plays.
export class LoopWindow {
  start = 0;
  length = 0;
  direction = 1;
  isPitchLoop = false;

  get end() {
    return this.start + this.length;
  }
}
