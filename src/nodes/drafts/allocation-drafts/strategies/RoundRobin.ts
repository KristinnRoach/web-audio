/**
 * A simple round-robin allocator that cycles through available items
 */
export class RoundRobin {
  #lastIndex = -1;

  // todo: fix types in allocate, once LRU and interface decided

  /**
   * Allocates the next item from the available collection using round-robin strategy
   * Does NOT implement voice stealing, use LRU if voice stealing is needed.
   * @param available Collection of available items
   * @returns The next item in the rotation or null if none available
   */
  allocate(available: Set<any> | any[]): TODO | undefined {
    if (
      (Array.isArray(available) && available.length === 0) ||
      (!Array.isArray(available) && available.size === 0)
    ) {
      return;
    }

    const items = Array.isArray(available) ? available : Array.from(available);
    this.#lastIndex = (this.#lastIndex + 1) % items.length;
    return items[this.#lastIndex];
  }

  /**
   * Resets the allocation index
   */
  reset(): void {
    this.#lastIndex = -1;
  }
}
