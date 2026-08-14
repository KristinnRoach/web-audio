// processor-registry.ts

const registeredProcessors: string[] = [];

// Note: currently just using the processors path as identifier
function add(processor: string) {
  registeredProcessors.push(processor);
}
function has(processor: string): boolean {
  return registeredProcessors.includes(processor);
}

function getAll() {
  return [...registeredProcessors];
}

function clear(): boolean {
  registeredProcessors.length = 0;

  return registeredProcessors.length === 0;
}

export const processorFileRegistry = {
  has,
  add,
  getAll,
  clear,
};
