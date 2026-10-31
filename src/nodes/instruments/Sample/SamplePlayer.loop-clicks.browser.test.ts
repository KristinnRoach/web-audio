import { expect, test, vi } from 'vite-plus/test';
import { SamplePlayer } from './SamplePlayer';
import { Envelope } from '../../modulators/envelope/Envelope';

const SR = 48_000;
const SAMPLE_SECONDS = 0.2;
const HOLD_SECONDS = 3;

// Capture rendered PCM on the audio thread, transferring once at the end so the
// measurement itself does not add per-quantum main-thread message traffic.
const recorderCode = `
registerProcessor('loop-click-recorder', class extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.data = new Float32Array(options.processorOptions.frames);
    this.used = 0;
    this.start = null;
  }
  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input || this.used >= this.data.length) return true;
    this.start ??= currentFrame / sampleRate;
    const count = Math.min(input.length, this.data.length - this.used);
    this.data.set(input.subarray(0, count), this.used);
    this.used += count;
    if (this.used === this.data.length) {
      this.port.postMessage({ samples: this.data, start: this.start }, [this.data.buffer]);
      return false;
    }
    return true;
  }
});`;

function wav(samples: Float32Array) {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, SR, true);
  view.setUint32(28, SR * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((value, i) => {
    view.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, value)) * 32767), true);
  });
  return bytes;
}

// A smooth 220 Hz sine has normalized second difference below 0.001. A 0.1
// threshold leaves room for envelope curvature but detects abrupt slope/value changes.
function detectClicks(samples: Float32Array) {
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  const clicks: { seconds: number; strength: number }[] = [];
  let maximum = 0;
  // Exclude initial note attack and the recording's end, not loop boundaries.
  for (let i = Math.round(0.4 * SR); i < samples.length - 2; i++) {
    const strength = Math.abs(samples[i + 1] - 2 * samples[i] + samples[i - 1]) / peak;
    maximum = Math.max(maximum, strength);
    if (strength > 0.1) {
      const previous = clicks.at(-1);
      if (!previous || i / SR - previous.seconds > 0.005) {
        clicks.push({ seconds: i / SR, strength });
      } else if (strength > previous.strength) {
        previous.seconds = i / SR;
        previous.strength = strength;
      }
    }
  }
  return { peak, maximum, clicks };
}

test('detects discontinuities in a held full-buffer loop with real loop-synced audio', async ({
  annotate,
}) => {
  const results = [];
  for (const mode of [
    'flat-sync',
    'envelope-free',
    'envelope-sync',
    'envelope-sync-delayed',
  ] as const) {
    const context = new AudioContext({ sampleRate: SR });
    let player: SamplePlayer | undefined;
    let observer: ReturnType<typeof vi.spyOn> | undefined;
    let recorder: AudioWorkletNode | undefined;
    const pending: ReturnType<typeof setTimeout>[] = [];
    try {
      await context.resume();
      await context.audioWorklet.addModule('/dist/processors/processors.js');
      const moduleUrl = URL.createObjectURL(new Blob([recorderCode], { type: 'text/javascript' }));
      try {
        await context.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
      player = new SamplePlayer({ context, polyphony: 1, voiceSignalChain: [] });
      await player.init();
      const buffer = context.createBuffer(1, SR * SAMPLE_SECONDS, SR);
      const pcm = buffer.getChannelData(0);
      // Exactly 44 periods: no discontinuity in the source at the full-buffer wrap.
      for (let i = 0; i < pcm.length; i++) pcm[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / SR);
      await player.loadAudio(buffer, { skipPreProcessing: true, getZeroCrossings: false });
      expect(player.loopStart).toBe(0);
      expect(player.loopEnd).toBe(SAMPLE_SECONDS);
      player.setLoopEnabled(true);
      player.setLoopDurationDriftAmount(0);
      player.updateEnvelope('pitch', { enabled: false });
      player.updateEnvelope('filter', { enabled: false });
      const amp = player.getEnvelope('amp');
      player.updateEnvelope('amp', {
        enabled: true,
        loopSync: mode !== 'envelope-free',
        shape: {
          ...amp.shape,
          mode: { type: 'loop' },
          ...(mode === 'flat-sync'
            ? {
                points: [
                  { time: 0, value: 1 },
                  { time: SAMPLE_SECONDS, value: 1 },
                ],
                sustainPoint: 0,
                releasePoint: 0,
              }
            : {}),
        },
      });
      // Let idle range reports arrive before the first note.
      await new Promise((resolve) => setTimeout(resolve, 100));
      const starts: { requested: number; received: number }[] = [];
      const original = Envelope.prototype.trigger;
      observer = vi
        .spyOn(Envelope.prototype, 'trigger')
        .mockImplementation(function (time, options) {
          const apply = () => {
            starts.push({ requested: time ?? context.currentTime, received: context.currentTime });
            original.call(this, time, options);
          };
          if (mode === 'envelope-sync-delayed' && options?.catchUp) {
            pending.push(setTimeout(apply, 30));
          } else apply();
        });
      recorder = new AudioWorkletNode(context, 'loop-click-recorder', {
        processorOptions: { frames: SR * (HOLD_SECONDS + 0.2) },
      });
      const recorded = new Promise<{ samples: Float32Array; start: number }>((resolve) => {
        recorder!.port.onmessage = ({ data }) => resolve(data);
      });
      // Tap raw voice audio to exclude instrument-bus effects from the detector.
      const taps = player.getGainStages()['voice.worklet'] as AudioNode[];
      taps[0].connect(recorder);
      player.disconnect();
      recorder.connect(context.destination); // Recorder outputs silence, keeping the graph live.
      expect(player.play(60, 127, 0, 0.05)).toBe(60);
      const { samples, start } = await recorded;
      const detection = detectClicks(samples);
      const late = starts.slice(1).map(({ requested, received }) => (received - requested) * 1000);
      const result = {
        mode,
        ...detection,
        starts: starts.length,
        lateRetriggers: late.filter((ms) => ms > 0).length,
        maximumLatenessMs: Math.max(0, ...late),
        clickBoundaryOffsetsMs: detection.clicks.map(({ seconds }) => {
          const absolute = start + seconds;
          return (
            Math.min(...starts.slice(1).map(({ requested }) => Math.abs(absolute - requested))) *
            1000
          );
        }),
      };
      results.push(result);
      console.info('LOOP_CLICK_RESULT', JSON.stringify(result));
      await annotate(mode, { body: wav(samples), contentType: 'audio/wav' });
      await annotate(`${mode} measurements`, {
        body: JSON.stringify({ ...result, recordingStart: start, starts }, null, 2),
        encoding: 'utf-8',
        contentType: 'application/json',
      });
    } finally {
      pending.forEach(clearTimeout);
      observer?.mockRestore();
      player?.dispose();
      recorder?.disconnect();
      recorder?.port.close();
      await context.close();
    }
  }
  for (const result of results) {
    expect(result.peak).toBeGreaterThan(0.1);
    expect(result.clicks, JSON.stringify(result)).toHaveLength(0);
  }
  expect(results[3].maximumLatenessMs).toBeGreaterThan(20);
}, 25_000);
