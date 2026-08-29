import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import { CustomEnvelope } from "../CustomEnvelope";
import type { EnvelopeData } from "../EnvelopeData";

// Mock dependencies
vi.mock("../../../nodes/node-store", () => ({
  createNodeId: vi.fn(() => "test-node-id"),
  deleteNodeId: vi.fn(),
  registerNode: vi.fn(() => "test-node-id"),
}));

vi.mock("@/events", () => ({
  createMessageBus: vi.fn(() => ({
    onMessage: vi.fn(),
    sendMessage: vi.fn(),
  })),
}));

describe("CustomEnvelope - #continueFromPoint", () => {
  let envelope: CustomEnvelope;
  let mockContext: AudioContext;
  let mockAudioParam: AudioParam;
  let mockEnvelopeData: EnvelopeData;

  beforeEach(() => {
    // Mock AudioContext with writable currentTime
    mockContext = {
      get currentTime() {
        return this._currentTime || 1.0;
      },
      set currentTime(value) {
        this._currentTime = value;
      },
      sampleRate: 44100,
      _currentTime: 1.0,
    } as unknown as AudioContext;

    // Mock AudioParam
    mockAudioParam = {
      value: 0.5,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      setValueCurveAtTime: vi.fn(),
    } as unknown as AudioParam;

    // Mock EnvelopeData
    mockEnvelopeData = {
      points: [
        { time: 0, value: 0, curve: "exponential" },
        { time: 0.5, value: 1, curve: "exponential" },
        { time: 1.0, value: 0.5, curve: "exponential" },
        { time: 1.5, value: 0, curve: "exponential" },
      ],
      pointValueRange: [0, 1],
      durationSeconds: 1.5,
      interpolateValueAtTime: vi.fn(),
      hasSharpTransitions: false,
      sustainPointIndex: 1,
      releasePointIndex: 2,
      startPointIndex: 0,
      endPointIndex: 3,
    } as unknown as EnvelopeData;

    envelope = new CustomEnvelope(mockContext, "amp-env", mockEnvelopeData);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("normal operation", () => {
    it("should apply release curve successfully", () => {
      // Setup interpolation values
      vi.mocked(mockEnvelopeData.interpolateValueAtTime)
        .mockReturnValueOnce(0.5) // start value
        .mockReturnValueOnce(0) // end value
        .mockReturnValue(0.25); // curve values

      envelope.releaseEnvelope(mockAudioParam, 1.0, {
        baseValue: 1,
        playbackRate: 1,
        voiceId: "test-voice",
      });

      expect(mockAudioParam.cancelScheduledValues).toHaveBeenCalledWith(1.0);
      expect(mockAudioParam.setValueAtTime).toHaveBeenCalledWith(0.5, 1.0);
      expect(mockAudioParam.setValueCurveAtTime).toHaveBeenCalled();
    });

    it("should send release message with correct data", () => {
      const sendMessageSpy = vi.spyOn(envelope, "sendUpstreamMessage");

      vi.mocked(mockEnvelopeData.interpolateValueAtTime).mockReturnValue(0.5);

      envelope.releaseEnvelope(mockAudioParam, 1.0, {
        baseValue: 1,
        playbackRate: 1,
        voiceId: "test-voice",
        midiNote: 64,
      });

      expect(sendMessageSpy).toHaveBeenCalledWith("amp-env:release", {
        voiceId: "test-voice",
        midiNote: 64,
        releasePoint: {
          time: expect.any(Number),
          value: expect.any(Number),
          curve: expect.any(String),
        },
        remainingDuration: expect.any(Number),
      });
    });
  });

  describe("edge cases with high timeScale", () => {
    it("should return early when scaled remaining duration is zero or negative", () => {
      // Set very high time scale to make duration effectively zero
      envelope.setTimeScale(10000);

      envelope.releaseEnvelope(mockAudioParam, 1.0, {
        baseValue: 1,
        playbackRate: 1,
      });

      // Near-zero releases should pin and ramp safely without scheduling a curve.
      expect(mockAudioParam.cancelScheduledValues).toHaveBeenCalled();
      expect(mockAudioParam.setValueAtTime).toHaveBeenCalled();
      expect(mockAudioParam.linearRampToValueAtTime).toHaveBeenCalled();
      expect(mockAudioParam.setValueCurveAtTime).not.toHaveBeenCalled();
    });
  });

  describe("safe start time calculation", () => {
    it("should use current time when start time is in the past", () => {
      // Now this will work
      (mockContext as any).currentTime = 2.0;

      vi.mocked(mockEnvelopeData.interpolateValueAtTime).mockReturnValue(0.5);

      envelope.releaseEnvelope(mockAudioParam, 1.0, {
        baseValue: 1,
        playbackRate: 1,
      });

      expect(mockAudioParam.cancelScheduledValues).toHaveBeenCalledWith(2.0);
      expect(mockAudioParam.setValueAtTime).toHaveBeenCalledWith(0.5, 2.0);
    });
  });
});

describe("CustomEnvelope - auto-release when loop is turned off mid-note", () => {
  let envelope: CustomEnvelope;
  let mockContext: AudioContext;
  let mockAudioParam: AudioParam;
  let mockEnvelopeData: EnvelopeData;

  beforeEach(() => {
    vi.useFakeTimers();

    mockContext = {
      currentTime: 1.0,
      sampleRate: 44100,
      getOutputTimestamp: () => ({ contextTime: 1.0, performanceTime: 0 }),
    } as unknown as AudioContext;

    mockAudioParam = {
      value: 0.5,
      minValue: 0,
      maxValue: 1,
      cancelScheduledValues: vi.fn(),
      setValueAtTime: vi.fn(),
      linearRampToValueAtTime: vi.fn(),
      setValueCurveAtTime: vi.fn(),
    } as unknown as AudioParam;

    // No sustain point: without a loop this envelope auto-releases.
    mockEnvelopeData = {
      points: [
        { time: 0, value: 0, curve: "exponential" },
        { time: 0.5, value: 1, curve: "exponential" },
        { time: 1.0, value: 0.5, curve: "exponential" },
        { time: 1.5, value: 0, curve: "exponential" },
      ],
      pointValueRange: [0, 1],
      durationSeconds: 1.5,
      interpolateValueAtTime: vi.fn(() => 0.5),
      hasSharpTransitions: false,
      sustainPointIndex: null,
      releasePointIndex: 2,
      startPointIndex: 0,
      endPointIndex: 3,
    } as unknown as EnvelopeData;

    envelope = new CustomEnvelope(mockContext, "amp-env", mockEnvelopeData);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("suppresses auto-release while looping, then releases once the loop is switched off", () => {
    const sendMessageSpy = vi.spyOn(envelope, "sendUpstreamMessage");

    envelope.setLoopEnabled(true);
    envelope.triggerEnvelope(mockAudioParam, 1.0, {
      baseValue: 1,
      playbackRate: 1,
      voiceId: "test-voice",
      midiNote: 64,
    });

    // Past the release deadline - the loop is still holding the note.
    vi.advanceTimersByTime(2000);
    expect(sendMessageSpy).not.toHaveBeenCalledWith("amp-env:release", expect.anything());

    envelope.setLoopEnabled(false);

    expect(sendMessageSpy).toHaveBeenCalledWith(
      "amp-env:release",
      expect.objectContaining({ voiceId: "test-voice", midiNote: 64 }),
    );
  });
});
