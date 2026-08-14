export type SampleMetadata = {
  duration: number; // in seconds
  sampleRate: number;
  channels: number;
  // mimeType ?? encoding format ??
};

// Todo: compare and make adaptors between IdbSample and AppSample (internal app state)
export type AppSample = {
  id: string;
  isLoaded?: boolean; // todo: follow up

  name?: string;
  type?: 'tonal' | 'percussive' | 'texture'; // revisit later

  mimeType?: unknown; // encoding format ??

  audioBuffer?: AudioBuffer; // todo: clarify requirements and simplify
  // float32arr?: Float32Array;
  // arrayBuffer?: ArrayBuffer;

  url?: string;

  metadata?: SampleMetadata; // could cram more things in metadata if standards allow
  dateAdded?: Date;
  extraInfo: unknown;
};

// type LoadedSample = AppSample & Required<Pick<AppSample, 'audioBuffer'>>;

export type IdbSample = {
  id: string; // Todo
  url: string; // Original URL or file path
  audioData: ArrayBuffer; // Serializable audio data
  dateAdded: Date; // Timestamp for cache management
  metadata: SampleMetadata;
  isDefaultInitSample?: 0 | 1; // 0: false, 1: true. Used if no sample is provided
  isFromDefaultLib?: 0 | 1; // If from default library provided by the app
};
