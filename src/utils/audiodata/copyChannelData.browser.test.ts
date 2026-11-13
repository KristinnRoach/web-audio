import { afterEach, expect, it, vi } from 'vite-plus/test';
import { copyChannelData } from './copyChannelData';
import { isValidAudioBuffer } from './validate/audiobuffer';
import { normalizeAudioBuffer } from './process/normalizeAudioBuffer';
import { compressAudioBuffer, compressAudioBufferRMS } from './process/compressAudioBuffer';
import { detectThresholdCrossing } from './process/detectSilence';
import { shouldCompress, needsCompression } from './process/shouldCompress';
import { trimAudioBuffer } from './process/trimBuffer';
import { createPitchDivideEffect } from './process/createPitchDivideEffect';
import { detectSinglePitchAC } from './pitchDetection/autocorrelateSingle';
import { detectPitchWindowed } from './pitchDetection/windowed';
import { findWaveCycles, duplicateWaveCycles } from './wavecycles/findWaveCycles';
import { preProcessAudioBuffer, resampleForPitch } from '@/nodes/preprocessor/Preprocessor';

const context = new OfflineAudioContext(2, 4800, 48000) as unknown as AudioContext;
const scale = 0.999;

afterEach(() => vi.restoreAllMocks());

// Exercise native copyFromChannel while emulating Brave's changes at each read API.
function braveBuffer() {
  const buffer = new AudioBuffer({ length: 4800, numberOfChannels: 2, sampleRate: 48000 });
  const channels = [buffer.getChannelData(0), buffer.getChannelData(1)];
  channels.forEach((data, channel) => {
    for (let i = 0; i < data.length; i++) {
      data[i] = (channel === 0 ? 0.5 : -0.25) * Math.cos((2 * Math.PI * 440 * i) / 48000);
    }
  });
  const originals = channels.map((data) => data.slice());
  const nativeCopy = buffer.copyFromChannel.bind(buffer);
  const get = vi.spyOn(buffer, 'getChannelData').mockImplementation((channel) => {
    const data = channels[channel];
    for (let i = 0; i < data.length; i++) data[i] *= scale;
    return data;
  });
  const copy = vi
    .spyOn(buffer, 'copyFromChannel')
    .mockImplementation((destination, channel, start) => {
      nativeCopy(destination, channel, start);
      for (let i = 0; i < destination.length; i++) destination[i] *= scale;
    });
  return { buffer, channels, originals, get, copy };
}

const operations: [string, (buffer: AudioBuffer) => unknown][] = [
  ['validation', isValidAudioBuffer],
  ['silence detection', (buffer) => detectThresholdCrossing(buffer, 0.005)],
  ['normalization', (buffer) => normalizeAudioBuffer(context, buffer)],
  ['compression', (buffer) => compressAudioBuffer(context, buffer)],
  ['RMS compression', (buffer) => compressAudioBufferRMS(context, buffer)],
  ['compression analysis', shouldCompress],
  ['quick compression analysis', needsCompression],
  ['trimming', (buffer) => trimAudioBuffer(context, buffer, 0, buffer.length, { in: 0, out: 0 })],
  ['pitch division', createPitchDivideEffect],
  ['pitch detection', detectSinglePitchAC],
  ['windowed pitch detection', detectPitchWindowed],
  ['cycle detection', findWaveCycles],
  ['cycle duplication', (buffer) => duplicateWaveCycles(buffer, 2)],
  ['pitch resampling', (buffer) => resampleForPitch(context, buffer, 1)],
  ['preprocessing', (buffer) => preProcessAudioBuffer(context, buffer, { hpf: { auto: false } })],
  [
    'skipped preprocessing',
    (buffer) => preProcessAudioBuffer(context, buffer, { skipPreProcessing: true }),
  ],
];

it.each(operations)(
  '%s preserves source audio through repeated Brave-style reads',
  async (_name, operation) => {
    const { buffer, channels, originals, get, copy } = braveBuffer();
    await operation(buffer);
    await operation(buffer);
    expect(channels).toEqual(originals);
    expect(get).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalled();
  },
);

it('copies both channels into independent arrays using the native API', () => {
  const { buffer, channels, originals, get } = braveBuffer();
  for (let channel = 0; channel < 2; channel++) {
    const first = copyChannelData(buffer, channel);
    // Native Brave also scales the copied destination; compare successive reads.
    expect(first.length).toBe(buffer.length);
    expect(first[0]).toBeCloseTo(originals[channel][0] * scale, 2);
    const expected = first.slice();
    first.fill(0);
    expect(copyChannelData(buffer, channel)).toEqual(expected);
  }
  expect(channels).toEqual(originals);
  expect(get).not.toHaveBeenCalled();
});

it('copies only the requested frames, clamped to the buffer', () => {
  const { buffer } = braveBuffer();
  const copy = copyChannelData(buffer, 0, 100, 200);
  expect(copy.length).toBe(100);
  expect(copy[0]).toBeCloseTo(copyChannelData(buffer, 0)[100], 6);
  expect(copyChannelData(buffer, 0, 4790, 5000).length).toBe(10);
  expect(copyChannelData(buffer, 0, 5000).length).toBe(0);
});

it.each([
  ['normalization', (buffer: AudioBuffer) => normalizeAudioBuffer(context, buffer)],
  ['compression', (buffer: AudioBuffer) => compressAudioBuffer(context, buffer)],
] as const)('%s reuses one channel snapshot for analysis and processing', (_name, operation) => {
  const { buffer, copy } = braveBuffer();
  const output = operation(buffer);
  expect(copy).toHaveBeenCalledTimes(2);
  if (_name === 'normalization') {
    expect(Math.max(...output.getChannelData(0).map(Math.abs))).toBeCloseTo(0.9, 2);
  }
});

it('keeps native source reads stable through repeated validation and normalization', () => {
  const buffer = new AudioBuffer({ length: 4800, numberOfChannels: 2, sampleRate: 48000 });
  buffer.copyToChannel(new Float32Array(buffer.length).fill(0.5), 0);
  buffer.copyToChannel(new Float32Array(buffer.length).fill(-0.25), 1);
  const before = [copyChannelData(buffer, 0), copyChannelData(buffer, 1)];
  for (let i = 0; i < 16; i++) {
    expect(isValidAudioBuffer(buffer)).toBe(true);
    normalizeAudioBuffer(context, buffer);
  }
  expect([copyChannelData(buffer, 0), copyChannelData(buffer, 1)]).toEqual(before);
});
