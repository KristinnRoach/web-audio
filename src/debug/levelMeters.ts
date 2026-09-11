import { GainStages } from "@/nodes/LibNode";
import { initProcessors } from "@/worklets/init-processors";

export interface LevelReading {
  /** Highest absolute sample in the last reported window. */
  peakDB: number;
  /** RMS across the last reported window. */
  rmsDB: number;
  /** Samples exceeding the clip threshold since monitoring started. Monotonic. */
  clipCount: number;
}

export interface LevelMonitors {
  readLevels(): Record<string, LevelReading>;
  stop(): void;
}

export interface MonitorLevelsOptions {
  /** How often each meter reports. Lower values cost more main-thread messages. */
  reportIntervalMs?: number;
  /** Absolute sample value counted as a clip. */
  clipThreshold?: number;
}

const SILENCE_DB = -100;

const toDB = (linear: number) =>
  linear > 0 ? Math.max(SILENCE_DB, 20 * Math.log10(linear)) : SILENCE_DB;

const SILENT: LevelReading = { peakDB: SILENCE_DB, rmsDB: SILENCE_DB, clipCount: 0 };

/**
 * Attaches a metering tap to each named stage and starts measuring. A stage given
 * as a list of nodes is metered as their sum, on one meter.
 *
 * Each meter is a sink: the stage fans out to it and its own output goes nowhere,
 * so the signal path is unchanged and no latency is added. Attaching and detaching
 * while audio is playing is glitch-free for the same reason.
 *
 * Nothing is created until this is awaited, and `stop()` releases everything, so an
 * unmonitored graph carries no cost.
 *
 * `clipCount` is measured at the tap, which is not necessarily what reaches the
 * speakers: stages downstream may attenuate, and the hardware output clamps to +/-1
 * regardless. A stage over 0 dB is the thing to fix, not the clamp.
 */
export async function monitorLevels(
  stages: GainStages,
  options: MonitorLevelsOptions = {},
): Promise<LevelMonitors> {
  const points = Object.entries(stages).map(([label, node]) => ({
    label,
    sources: Array.isArray(node) ? node : [node],
  }));

  const context = points[0]?.sources[0]?.context as AudioContext | undefined;
  if (!context) throw new Error("monitorLevels: no stages to monitor");

  await initProcessors(context);

  const latest = new Map<string, LevelReading>();

  const taps = points.map(({ label, sources }) => {
    const meter = new AudioWorkletNode(context, "level-meter-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      processorOptions: options,
    });
    meter.port.onmessage = ({ data }) => {
      latest.set(label, {
        peakDB: toDB(data.peak),
        rmsDB: toDB(data.rms),
        clipCount: data.clipCount,
      });
    };
    for (const source of sources) source.connect(meter);
    return { label, sources, meter };
  });

  return {
    /** Latest reported window per stage, up to `reportIntervalMs` old. Safe to call from rAF. */
    readLevels: () =>
      Object.fromEntries(taps.map(({ label }) => [label, latest.get(label) ?? SILENT])),

    /** Detaches every tap. Accumulated clip counts are discarded. */
    stop: () => {
      for (const { sources, meter } of taps) {
        for (const source of sources) source.disconnect(meter);
        meter.port.onmessage = null;
      }
      taps.length = 0;
    },
  };
}
