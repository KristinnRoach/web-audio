export type DeviceInfo = {
  deviceId: string;
  label: string;
  kind: MediaDeviceKind;
};

// Device-specific type aliases for better type safety
export type AudioInputDevice = DeviceInfo & { kind: 'audioinput' };
export type AudioOutputDevice = DeviceInfo & { kind: 'audiooutput' };
export type VideoInputDevice = DeviceInfo & { kind: 'videoinput' };
