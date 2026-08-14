// Debouncer.ts
export class Debouncer {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();

  /**
   * Debounce a function by key, or auto-key using function name if no key is provided.
   * @param fn - The function to debounce
   * @param delay - Debounce delay in milliseconds
   * @param key - Optional unique identifier for this debounced function
   */
  debounce<T extends (...args: any[]) => void>(
    fn: T,
    delay: number,
    key?: string
  ): (...args: Parameters<T>) => void {
    const actualKey = key ?? fn.name ?? 'default';
    return (...args: Parameters<T>) => {
      if (this.timers.has(actualKey)) {
        clearTimeout(this.timers.get(actualKey));
      }
      this.timers.set(
        actualKey,
        setTimeout(() => {
          fn(...args);
          this.timers.delete(actualKey);
        }, delay)
      );
    };
  }

  /**
   * Cancel a pending debounced call for a given key, if needed.
   */
  cancel(key: string) {
    if (this.timers.has(key)) {
      clearTimeout(this.timers.get(key));
      this.timers.delete(key);
    }
  }
}
// ...existing code...
