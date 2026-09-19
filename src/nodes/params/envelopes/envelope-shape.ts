import type { Envelope, EnvelopePoint, EnvelopeSettings } from './Envelope';

const clonePoints = (points: readonly EnvelopePoint[]) => points.map((point) => ({ ...point }));
const lastIndex = (envelope: Envelope) => envelope.points.length - 1;

export function baseDuration(envelope: Envelope): number {
  const { points } = envelope;
  return points.length ? points[lastIndex(envelope)].time - points[0].time : 0;
}

export function scaledDuration(
  settings: EnvelopeSettings,
  fromIndex: number,
  toIndex: number,
  timeScaleMultiplier = 1,
): number {
  const { points } = settings.envelope;
  if (fromIndex < 0 || toIndex > lastIndex(settings.envelope) || fromIndex >= toIndex) return 0;

  const scale = settings.timeScale * timeScaleMultiplier;
  const duration = points[toIndex].time - points[fromIndex].time;
  return Number.isFinite(scale) && scale > 0 ? duration / scale : duration;
}

export function releaseStartTime(settings: EnvelopeSettings, timeScaleMultiplier = 1): number {
  return scaledDuration(settings, 0, settings.envelope.release, timeScaleMultiplier);
}

export function releaseDuration(settings: EnvelopeSettings, timeScaleMultiplier = 1): number {
  return scaledDuration(
    settings,
    settings.envelope.release,
    lastIndex(settings.envelope),
    timeScaleMultiplier,
  );
}

export function hasVariation(envelope: Envelope): boolean {
  const first = envelope.points[0]?.value ?? 0;
  return envelope.points.some((point) => Math.abs(point.value - first) > 0.001);
}

export function addPoint(
  envelope: Envelope,
  time: number,
  value: number,
  curve: EnvelopePoint['curve'] = 'exponential',
): Envelope {
  const { points } = envelope;
  if (!Number.isFinite(time)) return envelope;
  if (points.some((point) => point.time === time)) return envelope;
  if (points.length >= 2 && (time < points[0].time || time > points[lastIndex(envelope)].time)) {
    return envelope;
  }

  const at = points.findIndex((point) => point.time > time);
  const insertAt = at === -1 ? points.length : at;
  const next = clonePoints(points);
  next.splice(insertAt, 0, { time, value, curve });

  return {
    ...envelope,
    points: next,
    mode:
      envelope.mode.type === 'sustain' && insertAt <= envelope.mode.at
        ? { ...envelope.mode, at: envelope.mode.at + 1 }
        : envelope.mode,
    release: insertAt <= envelope.release ? envelope.release + 1 : envelope.release,
  };
}

export function updatePoint(
  envelope: Envelope,
  index: number,
  time?: number,
  value?: number,
): Envelope {
  const { points } = envelope;
  if (index < 0 || index >= points.length) return envelope;

  const current = points[index];
  const nextTime = time ?? current.time;
  if (!Number.isFinite(nextTime)) return envelope;
  const before = points[index - 1];
  const after = points[index + 1];
  if ((before && nextTime <= before.time) || (after && nextTime >= after.time)) return envelope;

  const next = clonePoints(points);
  next[index] = { ...current, time: nextTime, value: value ?? current.value };
  return { ...envelope, points: next };
}

export function deletePoint(envelope: Envelope, index: number): Envelope {
  const { points } = envelope;
  if (points.length <= 2 || index <= 0 || index >= lastIndex(envelope)) return envelope;

  const next = clonePoints(points);
  next.splice(index, 1);
  const end = next.length - 1;
  const release = envelope.release > index ? envelope.release - 1 : envelope.release;
  const mode =
    envelope.mode.type !== 'sustain'
      ? envelope.mode
      : envelope.mode.at === index
        ? { type: 'once' as const }
        : {
            ...envelope.mode,
            at: envelope.mode.at > index ? envelope.mode.at - 1 : envelope.mode.at,
          };

  return {
    ...envelope,
    points: next,
    mode,
    release: envelope.release === index ? Math.min(index, Math.max(0, end - 1)) : release,
  };
}

export function setDuration(envelope: Envelope, seconds: number): Envelope {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new RangeError('Envelope duration must be greater than zero');
  }

  const { points } = envelope;
  if (points.length < 2) return envelope;

  const start = points[0].time;
  const current = baseDuration(envelope);
  const next = points.map((point, index) => ({
    ...point,
    time:
      current > 0
        ? start + (point.time - start) * (seconds / current)
        : index === points.length - 1
          ? start + seconds
          : point.time,
  }));

  return { ...envelope, points: next };
}

export function setSustainPoint(envelope: Envelope, index?: number): Envelope {
  if (index !== undefined && (index < 0 || index >= envelope.points.length)) return envelope;
  return {
    ...envelope,
    mode: index === undefined ? { type: 'once' } : { type: 'sustain', at: index },
  };
}

export function setReleasePoint(envelope: Envelope, index: number): Envelope {
  if (index < 0 || index >= envelope.points.length) return envelope;
  return { ...envelope, release: index };
}
