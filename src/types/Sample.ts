export type SampleMetadata = {
  duration: number; // in seconds
  sampleRate: number;
  channels: number;
  // mimeType ?? encoding format ??
};

// Todo: revisit
export type AppSample = {
  id: string;
  isLoaded?: boolean; // todo: follow up

  name?: string;
  type?: 'tonal' | 'percussive' | 'texture'; // revisit later

  mimeType?: unknown; // encoding format ??

  audioBuffer?: AudioBuffer; // todo: clarify requirements and simplify
  // float32arr?: Float32Array;
  // arrayBuffer?: ArrayBuffer;
  // audioData: ArrayBuffer; // Serializable audio data

  url?: string;

  metadata?: SampleMetadata; // could cram more things in metadata if standards allow
  dateAdded?: Date;
  extraInfo: unknown;
};

// type LoadedSample = AppSample & Required<Pick<AppSample, 'audioBuffer'>>;
