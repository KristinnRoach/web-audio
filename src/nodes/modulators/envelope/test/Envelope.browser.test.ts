import { expect, test } from 'vite-plus/test';
import { Envelope } from '../Envelope';
import type { EnvelopeShape } from '../envelope-shape';

const SAMPLE_RATE = 48000;

/** Attack 0 -> 1 exponential over 20 ms, sustain at 1, linear release over 50 ms. */
const exponentialAttack: EnvelopeShape = {
  points: [
    { time: 0, value: 0, curve: 'exponential' },
    { time: 0.02, value: 1 },
    { time: 0.07, value: 0 },
  ],
  mode: { type: 'sustain' },
  sustainPoint: 1,
  releasePoint: 1,
};

/** Renders a param driven by `play` as a DC signal, so each sample is the param's value. */
async function render(play: (envelope: Envelope) => void, durationSeconds = 0.1) {
  const ctx = new OfflineAudioContext(1, SAMPLE_RATE * durationSeconds, SAMPLE_RATE);
  const source = new ConstantSourceNode(ctx, { offset: 0 });
  source.connect(ctx.destination);
  source.start();

  const envelope = new Envelope(ctx, source.offset, exponentialAttack);
  play(envelope);
  return { envelope, data: (await ctx.startRendering()).getChannelData(0) };
}

const sampleAt = (time: number) => Math.round(time * SAMPLE_RATE);

test('the tracked timeline matches what a real AudioParam renders', async () => {
  const times = [0.002, 0.005, 0.01, 0.015, 0.019];
  let expected: number[] = [];
  const { data } = await render((envelope) => {
    envelope.trigger(0);
    expected = times.map((time) => envelope.param.valueAt(time));
  });

  times.forEach((time, i) => expect(data[sampleAt(time)]).toBeCloseTo(expected[i], 3));
});

test('a release mid exponential attack hands off without a step', async () => {
  const releaseTime = 0.01;
  const { data } = await render((envelope) => {
    envelope.trigger(0);
    envelope.release(releaseTime);
  });

  // Halfway up an exponential ramp from the 1e-4 floor to 1 is 0.01, not the shape's 0.5.
  const at = sampleAt(releaseTime);
  expect(data[at]).toBeCloseTo(0.01, 3);
  const largestStep = Math.max(
    ...Array.from({ length: 20 }, (_, i) => Math.abs(data[at - 10 + i + 1] - data[at - 10 + i])),
  );
  expect(largestStep).toBeLessThan(0.001);
});

test('stop preserves a release ramp until the stop time, then holds its value', async () => {
  const { data } = await render((envelope) => {
    envelope.trigger(0);
    envelope.release(0.03);
    envelope.stop(0.055);
  });

  for (const [time, value] of [
    [0.025, 1],
    [0.04, 0.8],
    [0.055, 0.5],
    [0.09, 0.5],
  ]) {
    expect(data[sampleAt(time)]).toBeCloseTo(value, 3);
  }
});

test('a sustain edit with a past timestamp starts its glide now', async () => {
  const ctx = new OfflineAudioContext(1, SAMPLE_RATE * 0.5, SAMPLE_RATE);
  const source = new ConstantSourceNode(ctx, { offset: 0 });
  source.connect(ctx.destination);
  source.start();
  const envelope = new Envelope(ctx, source.offset, exponentialAttack);
  envelope.trigger(0);

  const suspended = ctx.suspend(0.2);
  const rendering = ctx.startRendering();
  await suspended;
  const now = ctx.currentTime;
  envelope.setSustainValue(0, 0.15, 0.2);
  const times = [now, now + 0.1, now + 0.2];
  const expected = [1, 0.5, 0];
  const tracked = times.map((time) => envelope.param.valueAt(time));

  await ctx.resume();
  const data = (await rendering).getChannelData(0);
  times.forEach((time, i) => {
    expect(tracked[i]).toBeCloseTo(expected[i], 3);
    expect(data[sampleAt(time)]).toBeCloseTo(expected[i], 3);
  });
});

const loopShape: EnvelopeShape = {
  points: [
    { time: 0, value: 0, curve: 'exponential' },
    { time: 0.005, value: 1, curve: 'exponential' },
    { time: 0.05, value: 0.75, curve: 'exponential' },
    { time: 0.18, value: 0.5, curve: 'exponential' },
    { time: 0.2, value: 0, curve: 'exponential' },
  ],
  mode: { type: 'loop' },
  sustainPoint: 3,
  releasePoint: 3,
};

async function renderLoop(
  retrigger: 'none' | 'future' | 'late',
  shape = loopShape,
  lateTime = 0.203,
  timeScale = 1,
) {
  const context = new OfflineAudioContext(
    1,
    Math.ceil(SAMPLE_RATE * Math.max(0.25, lateTime + 0.25)),
    SAMPLE_RATE,
  );
  const source = new ConstantSourceNode(context, { offset: 0 });
  source.connect(context.destination);
  source.start();
  const envelope = new Envelope(context, source.offset, shape);
  envelope.trigger(0, { timeScale });
  if (retrigger === 'future') envelope.trigger(0.2, { timeScale });
  if (retrigger !== 'late') {
    const samples = (await context.startRendering()).getChannelData(0);
    envelope.stop();
    return { samples, at: 0.2 };
  }
  // Suspend a few ms into the next attack, then deliver its already-past wrap.
  const paused = context.suspend(lateTime);
  const rendering = context.startRendering();
  await paused;
  const at = context.currentTime;
  envelope.trigger(0.2, { catchUp: true, timeScale });
  await context.resume();
  const samples = (await rendering).getChannelData(0);
  envelope.stop();
  return { samples, at };
}

test('a future boundary retrigger preserves the closing ramp already in flight', async () => {
  const reference = await renderLoop('none');
  const retriggered = await renderLoop('future');
  for (const time of [0.185, 0.19, 0.195, 0.199]) {
    expect(retriggered.samples[sampleAt(time)], `closing ramp at ${time}`).toBeCloseTo(
      reference.samples[sampleAt(time)],
      5,
    );
  }
});

test('a late cycle report resumes the rendered loop phase without resetting the attack', async () => {
  const { samples, at } = await renderLoop('late');
  const index = sampleAt(at);
  const reference = await renderLoop('none');
  for (const time of [at, at + 0.001, 0.22, 0.24]) {
    expect(samples[sampleAt(time)]).toBeCloseTo(reference.samples[sampleAt(time)], 5);
  }
  expect(Math.abs(samples[index] - samples[index - 1])).toBeLessThan(0.001);
});

// Compare native rendered automation, including floored exponential endpoints,
// signed linear fallbacks, exact step points and multiple missed cycles.
for (const [name, shape, timeScale, lateTime] of [
  ['missed cycles', loopShape, 1, 0.603],
  [
    'scaled nonzero origin',
    { ...loopShape, points: loopShape.points.map((p) => ({ ...p, time: p.time + 7 })) },
    2,
    0.213,
  ],
  [
    'signed exponential',
    {
      ...loopShape,
      points: [
        { time: 0, value: -1, curve: 'exponential' },
        { time: 0.1, value: 1, curve: 'exponential' },
        { time: 0.2, value: -1, curve: 'exponential' },
      ],
      sustainPoint: 1,
      releasePoint: 1,
    },
    1,
    0.243,
  ],
  [
    'step segment',
    {
      ...loopShape,
      points: [
        { time: 0, value: 0.25, curve: 'step' },
        { time: 0.1, value: 0.75, curve: 'step' },
        { time: 0.2, value: 0.25, curve: 'step' },
      ],
      sustainPoint: 1,
      releasePoint: 1,
    },
    1,
    0.243,
  ],
] as const) {
  test(`delayed loop catch-up matches uninterrupted audio: ${name}`, async () => {
    const reference = await renderLoop('none', shape, lateTime, timeScale);
    const resumed = await renderLoop('late', shape, lateTime, timeScale);
    for (let index = sampleAt(resumed.at); index < resumed.samples.length; index++) {
      expect(resumed.samples[index]).toBeCloseTo(reference.samples[index], 4);
    }
  });
}

for (const command of ['release', 'stop'] as const) {
  test(`${command} before a catch-up handover cancels it without reopening`, async () => {
    const render = async (catchUp: boolean) => {
      const context = new OfflineAudioContext(1, SAMPLE_RATE * 0.3, SAMPLE_RATE);
      const source = new ConstantSourceNode(context, { offset: 0 });
      source.connect(context.destination);
      source.start();
      const envelope = new Envelope(context, source.offset, loopShape);
      envelope.trigger(0);
      const paused = context.suspend(0.203);
      const rendering = context.startRendering();
      await paused;
      if (catchUp) envelope.trigger(0.2, { catchUp: true });
      envelope[command](context.currentTime + 0.005);
      await context.resume();
      const samples = (await rendering).getChannelData(0);
      envelope.stop();
      return samples;
    };
    const reference = await render(false);
    const caughtUp = await render(true);
    for (let index = sampleAt(0.203); index < reference.length; index++) {
      expect(caughtUp[index]).toBeCloseTo(reference[index], 4);
    }
  });
}

// A translated loop range can change phase without changing duration. A linear
// triangle gives an independent expected value for the bridge and its release.
const triangleLoop: EnvelopeShape = {
  points: [
    { time: 0, value: 0 },
    { time: 0.1, value: 1 },
    { time: 0.2, value: 0 },
  ],
  mode: { type: 'loop' },
  sustainPoint: 1,
  releasePoint: 1,
};
const triangleAt = (time: number) => {
  const phase = time % 0.2;
  return phase < 0.1 ? phase * 10 : (0.2 - phase) * 10;
};

async function renderReanchoredLoop(command?: 'release' | 'stop') {
  const context = new OfflineAudioContext(1, SAMPLE_RATE * 0.45, SAMPLE_RATE);
  const source = new ConstantSourceNode(context, { offset: 0 });
  source.connect(context.destination);
  source.start();
  const envelope = new Envelope(context, source.offset, triangleLoop);
  envelope.trigger(0);
  const paused = context.suspend(0.152);
  const rendering = context.startRendering();
  await paused;
  const start = context.currentTime + 0.01;
  const end = start + 0.005;
  const cut = start + 0.0025;
  envelope.trigger(0.15, { catchUp: true });
  if (command) envelope[command](cut);
  await context.resume();
  const samples = (await rendering).getChannelData(0);
  envelope.stop();
  return { samples, start, end, cut };
}

test('same-duration reanchoring bridges continuously to the new phase and retains its grid', async () => {
  const { samples, start, end } = await renderReanchoredLoop();
  const held = triangleAt(start);
  const target = triangleAt(end - 0.15);
  expect(Math.abs(held - triangleAt(start - 0.15))).toBeGreaterThan(0.1);
  for (const time of [start - 0.001, start, start + 0.0025, end, end + 0.02, 0.35, 0.4]) {
    const expected =
      time < start
        ? triangleAt(time)
        : time < end
          ? held + ((target - held) * (time - start)) / (end - start)
          : triangleAt(time - 0.15);
    expect(samples[sampleAt(time)], `value at ${time}`).toBeCloseTo(expected, 4);
  }
  for (const time of [start, end]) {
    const index = sampleAt(time);
    expect(Math.abs(samples[index] - samples[index - 1])).toBeLessThan(0.001);
  }
});

for (const command of ['release', 'stop'] as const) {
  test(`${command} during a value-changing bridge preserves its ramp and cancels later cycles`, async () => {
    const { samples, start, end, cut } = await renderReanchoredLoop(command);
    const held = triangleAt(start);
    const target = triangleAt(end - 0.15);
    const cutValue = held + ((target - held) * (cut - start)) / (end - start);
    expect(Math.abs(held - target)).toBeGreaterThan(0.1);
    for (let index = sampleAt(start); index < samples.length; index++) {
      const time = index / SAMPLE_RATE;
      const expected =
        time < cut
          ? held + ((target - held) * (time - start)) / (end - start)
          : command === 'stop'
            ? cutValue
            : cutValue * Math.max(0, 1 - (time - cut) / 0.1);
      expect(samples[index], `value at ${time}`).toBeCloseTo(expected, 4);
    }
  });
}
