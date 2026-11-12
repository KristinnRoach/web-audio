import { DeviceInfo, AudioInputDevice, AudioOutputDevice, VideoInputDevice } from './types';

// Lists devices without requesting capture access. Labels may be empty before permission.
export async function getDevices(): Promise<DeviceInfo[]> {
  try {
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

type MicrophoneConstraints = MediaTrackConstraints & { voiceIsolation?: ConstrainBoolean };

// Voice processing off, so instruments are captured as played.
export const MUSIC_MIC_CONSTRAINTS: MicrophoneConstraints = {
  echoCancellation: false,
  autoGainControl: false,
  noiseSuppression: false,
  voiceIsolation: false,
};

// Opens the requested microphone; explicit device failures are left to the caller.
export async function getMicrophone(
  constraints: MicrophoneConstraints = MUSIC_MIC_CONSTRAINTS,
  deviceId = '',
): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: deviceId
      ? {
          ...constraints,
          deviceId: { exact: deviceId },
        }
      : constraints,
  });
}

// Video Input (Camera)
export async function getCamera(
  constraints: MediaTrackConstraints = {
    width: 1280,
    height: 720,
    facingMode: 'user',
  },
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
  return () => navigator.mediaDevices.removeEventListener('devicechange', callback);
}
