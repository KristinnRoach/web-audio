import { describe, it, expect, vi, beforeEach, afterEach } from "vite-plus/test";
import {
  getDevices,
  getMicrophone,
  getCamera,
  getMIDIAccess,
  getAudioInputDevices,
  getAudioOutputDevices,
  getVideoInputDevices,
  onDeviceChange,
} from "./devices";

describe("Device Access Utils", () => {
  const mockDevices = [
    { deviceId: "1", label: "Mic 1", kind: "audioinput" },
    { deviceId: "2", label: "Speaker 1", kind: "audiooutput" },
    { deviceId: "3", label: "Camera 1", kind: "videoinput" },
  ] as MediaDeviceInfo[];

  const mockStream = { getTracks: () => [] } as unknown as MediaStream;
  const getUserMediaMock = vi.fn();
  const enumerateDevicesMock = vi.fn();
  const addEventListenerMock = vi.fn();
  const removeEventListenerMock = vi.fn();
  const requestMIDIAccessMock = vi.fn();

  beforeEach(() => {
    getUserMediaMock.mockReset().mockResolvedValue(mockStream);
    enumerateDevicesMock.mockReset().mockResolvedValue(mockDevices);
    addEventListenerMock.mockReset();
    removeEventListenerMock.mockReset();
    requestMIDIAccessMock.mockReset();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: getUserMediaMock,
        enumerateDevices: enumerateDevicesMock,
        addEventListener: addEventListenerMock,
        removeEventListener: removeEventListenerMock,
      },
      requestMIDIAccess: requestMIDIAccessMock,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("getDevices", () => {
    it("returns list of available devices", async () => {
      const devices = await getDevices();
      expect(devices).toHaveLength(3);
      expect(devices[0]).toEqual({
        deviceId: "1",
        label: "Mic 1",
        kind: "audioinput",
      });
    });

    it("handles enumeration errors gracefully", async () => {
      const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      enumerateDevicesMock.mockRejectedValue(new Error("Permission denied"));
      const devices = await getDevices();
      expect(devices).toEqual([]);
      consoleSpy.mockRestore();
    });
  });

  describe("Device Access Functions", () => {
    it("gets microphone access", async () => {
      const stream = await getMicrophone();
      expect(stream).toBe(mockStream);
      expect(getUserMediaMock).toHaveBeenCalledWith(
        expect.objectContaining({
          audio: expect.any(Object),
        }),
      );
    });

    it("requests a specific audio input device when provided", async () => {
      const stream = await getMicrophone(undefined, "input-123");

      expect(stream).toBe(mockStream);
      expect(getUserMediaMock).toHaveBeenCalledWith({
        audio: {
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
          deviceId: { exact: "input-123" },
        },
      });
    });

    it("falls back to default input when requested device is unavailable", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const overconstrained = Object.assign(new Error("unavailable"), {
        name: "OverconstrainedError",
      });
      getUserMediaMock.mockRejectedValueOnce(overconstrained).mockResolvedValueOnce(mockStream);

      const stream = await getMicrophone(undefined, "gone-device");

      expect(stream).toBe(mockStream);
      expect(getUserMediaMock).toHaveBeenLastCalledWith({
        audio: {
          echoCancellation: false,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      consoleSpy.mockRestore();
    });

    it("rethrows non-OverconstrainedError failures", async () => {
      const denied = Object.assign(new Error("denied"), {
        name: "NotAllowedError",
      });
      getUserMediaMock.mockRejectedValue(denied);

      await expect(getMicrophone(undefined, "input-123")).rejects.toThrow("denied");
    });

    it("gets camera access", async () => {
      const stream = await getCamera();
      expect(stream).toBe(mockStream);
      expect(getUserMediaMock).toHaveBeenCalledWith({
        video: {
          width: 1280,
          height: 720,
          facingMode: "user",
        },
      });
    });

    it("throws when MIDI is not supported", async () => {
      const mockNavigator = { requestMIDIAccess: undefined };
      vi.stubGlobal("navigator", mockNavigator);

      await expect(getMIDIAccess()).rejects.toThrow("MIDI access not supported");
    });

    it("gets MIDI access when supported", async () => {
      const mockMIDIAccess = {
        inputs: new Map(),
        outputs: new Map(),
      };
      requestMIDIAccessMock.mockResolvedValue(mockMIDIAccess as unknown as MIDIAccess);

      const midiAccess = await getMIDIAccess();
      expect(midiAccess).toBe(mockMIDIAccess);
    });
  });

  describe("Device Filtering Functions", () => {
    it("filters devices by type", async () => {
      const audioInputs = await getAudioInputDevices();
      const audioOutputs = await getAudioOutputDevices();
      const videoInputs = await getVideoInputDevices();

      expect(audioInputs).toHaveLength(1);
      expect(audioOutputs).toHaveLength(1);
      expect(videoInputs).toHaveLength(1);

      expect(audioInputs[0].kind).toBe("audioinput");
      expect(audioOutputs[0].kind).toBe("audiooutput");
      expect(videoInputs[0].kind).toBe("videoinput");
    });
  });

  describe("Device Change Monitoring", () => {
    it("sets up device change listener", () => {
      const callback = vi.fn();
      const cleanup = onDeviceChange(callback);

      expect(addEventListenerMock).toHaveBeenCalledWith("devicechange", callback);

      cleanup();
      expect(removeEventListenerMock).toHaveBeenCalledWith("devicechange", callback);
    });
  });
});
