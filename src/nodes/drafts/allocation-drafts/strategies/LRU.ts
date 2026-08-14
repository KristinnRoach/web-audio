const voicePool = {
  available: new Set(),
  playing: new Set(),
  releasing: new Set(),
};

const pop = (set: Set<any>) => {
  const v = set.values().next().value;
  set.delete(v);
  return v;
};

export function allocate({
  available,
  releasing,
  playing,
}: {
  available: Set<any>;
  releasing: Set<any>;
  playing: Set<any>;
}) {
  let voice;
  if (available.size) voice = pop(available);
  else if (releasing.size) voice = pop(releasing);
  else if (playing.size) voice = pop(playing); // (pop uneccessary but maybe better for constistant behavior..)

  // ? decide and clearly define the system for adding to the sets:
  // a) messages from processor handle populating the sets exclusively,
  // OR sets populated explicitly in:
  // b) Sampler class
  // c) Pool class

  return voice;
}
