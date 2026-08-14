import {
  DeviceInfo,
  AudioInputDevice,
  AudioOutputDevice,
  VideoInputDevice,
} from './types';

// Get list of available devices
export async function getDevices(): Promise<DeviceInfo[]> {
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.map((device) => ({
      deviceId: device.deviceId,
      label: device.label,
      kind: device.kind,
    }));
  } catch (error) {
    console.error('Failed to enumerate devices:', error);
    return [];
  }
}

// MIDI Access
export async function getMIDIAccess(): Promise<MIDIAccess> {
  if (!navigator.requestMIDIAccess) {
    throw new Error('MIDI access not supported in this browser');
  }
  return navigator.requestMIDIAccess();
}

// Audio Input (Microphone)
export async function getMicrophone(
  constraints: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: true, // ?
    autoGainControl: true, // ?
  },
  deviceId = ''
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: deviceId
        ? {
            ...constraints,
            deviceId: { exact: deviceId },
          }
        : constraints,
    });
  } catch (error) {
    // Selected device unplugged/disabled -> fall back to default input
    if (deviceId && (error as DOMException).name === 'OverconstrainedError') {
      console.warn(
        'Requested audio input device unavailable, falling back to default'
      );
      return navigator.mediaDevices.getUserMedia({ audio: constraints });
    }
    throw error;
  }
}

// Video Input (Camera)
export async function getCamera(
  constraints: MediaTrackConstraints = {
    width: 1280,
    height: 720,
    facingMode: 'user',
  }
): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    video: constraints,
  });
}

// Device Selection Helpers
export async function getAudioInputDevices(): Promise<AudioInputDevice[]> {
  const devices = await getDevices();
  return devices.filter((d) => d.kind === 'audioinput') as AudioInputDevice[];
}

export async function getAudioOutputDevices(): Promise<AudioOutputDevice[]> {
  const devices = await getDevices();
  return devices.filter((d) => d.kind === 'audiooutput') as AudioOutputDevice[];
}

export async function getVideoInputDevices(): Promise<VideoInputDevice[]> {
  const devices = await getDevices();
  return devices.filter((d) => d.kind === 'videoinput') as VideoInputDevice[];
}

// Device Change Monitoring
export function onDeviceChange(callback: () => void): () => void {
  navigator.mediaDevices.addEventListener('devicechange', callback);
  return () =>
    navigator.mediaDevices.removeEventListener('devicechange', callback);
}
