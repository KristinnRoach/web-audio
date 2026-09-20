import type { Envelope, EnvelopeClock, EnvelopePlayer, EnvelopeTriggerOptions } from './Envelope';

export type EnvelopePointDetails = {
  index: number;
  point: Envelope['points'][number];
  time: number;
};

export type EnvelopePlayerObserverCallbacks = {
  onPoint?: (details: EnvelopePointDetails) => void;
  onComplete?: () => void;
};

/** Adds optional wall-clock notifications without adding them to the envelope player. */
export function observeEnvelopePlayer(
  envPlayer: EnvelopePlayer,
  clock: EnvelopeClock,
  callbacks: EnvelopePlayerObserverCallbacks,
): EnvelopePlayer {
  let envelope: Envelope | undefined;
  const pointTimers = new Set<ReturnType<typeof setTimeout>>();
  let completionTimer: ReturnType<typeof setTimeout> | undefined;
  let loopTimer: ReturnType<typeof setTimeout> | undefined;
  let active = false;
  let timeScale = 1;
  let anchorTime = 0;

  const duration = (from: number, to: number) => {
    if (!envelope) return 0;
    if (from < 0 || to >= envelope.points.length || from >= to) return 0;
    return (envelope.points[to].time - envelope.points[from].time) / timeScale;
  };

  const clearTimers = () => {
    pointTimers.forEach((timer) => clearTimeout(timer));
    pointTimers.clear();
    if (completionTimer !== undefined) clearTimeout(completionTimer);
    if (loopTimer !== undefined) clearTimeout(loopTimer);
    completionTimer = undefined;
    loopTimer = undefined;
  };

  const schedulePoints = (startTime: number, from: number, to: number, fromIndex = from - 1) => {
    if (!envelope) return;
    const runEnvelope = envelope;
    const fromTime =
      fromIndex < 0 ? runEnvelope.points[0].time : runEnvelope.points[fromIndex].time;
    for (let index = from; index <= to; index++) {
      const time = startTime + (runEnvelope.points[index].time - fromTime) / timeScale;
      const timer = setTimeout(
        () => {
          pointTimers.delete(timer);
          callbacks.onPoint?.({ index, point: runEnvelope.points[index], time });
        },
        Math.max(0, (time - clock.currentTime) * 1000),
      );
      pointTimers.add(timer);
    }
  };

  const armCompletion = (time: number) => {
    completionTimer = setTimeout(
      () => {
        completionTimer = undefined;
        callbacks.onComplete?.();
      },
      Math.max(0, (time - clock.currentTime) * 1000),
    );
  };

  const startPointNotifications = (startTime: number, fromPoint: number) => {
    if (!callbacks.onPoint || !envelope) return;
    const runEnvelope = envelope;
    const end =
      runEnvelope.mode.type === 'sustain' ? runEnvelope.mode.at : runEnvelope.points.length - 1;
    const cycleDuration = duration(0, end);
    if (cycleDuration <= 0) return;

    schedulePoints(startTime, fromPoint, end, fromPoint);

    let cycle = 1;
    const tick = () => {
      if (!active || runEnvelope.mode.type !== 'loop') return;
      schedulePoints(anchorTime + cycle * cycleDuration, 0, end);
      cycle++;
      loopTimer = setTimeout(
        tick,
        Math.max(0, (anchorTime + cycle * cycleDuration - clock.currentTime) * 1000),
      );
    };

    loopTimer = setTimeout(
      tick,
      Math.max(0, (anchorTime + cycleDuration - clock.currentTime) * 1000),
    );
  };

  return {
    trigger(sourceEnvelope, time = clock.currentTime, options: EnvelopeTriggerOptions = {}) {
      envPlayer.trigger(sourceEnvelope, time, options);
      envelope = {
        ...sourceEnvelope,
        mode: { ...sourceEnvelope.mode },
        points: sourceEnvelope.points.map((point) => ({ ...point })),
      };
      clearTimers();
      active = true;
      timeScale = options.timeScale ?? 1;
      const requestedPoint = envelope.mode.type === 'loop' ? (options.fromPoint ?? 0) : 0;
      const fromPoint = Math.min(Math.max(requestedPoint, 0), envelope.points.length - 1);
      anchorTime = time - duration(0, fromPoint);

      startPointNotifications(time, fromPoint);
      if (callbacks.onComplete && envelope.mode.type === 'once') {
        armCompletion(time + envPlayer.duration());
      }
    },
    release(time = clock.currentTime) {
      envPlayer.release(time);
      if (!active || !envelope) return;
      active = false;
      clearTimers();

      if (callbacks.onPoint) {
        schedulePoints(time, envelope.release + 1, envelope.points.length - 1, envelope.release);
      }
      if (callbacks.onComplete) armCompletion(time + envPlayer.releaseDuration());
    },
    duration: () => envPlayer.duration(),
    releaseDuration: () => envPlayer.releaseDuration(),
    position: (time) => envPlayer.position(time),
    currentPoint: (time) => envPlayer.currentPoint(time),
    nextCycleTime: (time) => envPlayer.nextCycleTime(time),
    setSustainValue: (value, time, glide) => envPlayer.setSustainValue(value, time, glide),
    stop(time = clock.currentTime) {
      envPlayer.stop(time);
      active = false;
      clearTimers();
    },
    dispose() {
      envPlayer.dispose();
      active = false;
      clearTimers();
    },
  };
}
