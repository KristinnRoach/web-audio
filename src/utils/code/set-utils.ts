export const pop = <T>(set: Set<T>): T | undefined => {
  const iterator = set.values();
  const result = iterator.next();
  if (!result.done) {
    set.delete(result.value);
    return result.value;
  }
  return undefined;
};
