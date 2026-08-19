import {
  CustomLibWaveform,
  createWave,
  WaveformOptions,
  isCustomLibWaveform,
} from "@/utils/audiodata/generate/generateWaveform";

export class LFO {
  #context: AudioContext;
  #oscillator: OscillatorNode;
  #gain: GainNode;
  #targets: Set<AudioParam> = new Set();

  #storedValues: { rate: number; depth?: number } | null = null;

  constructor(context: AudioContext) {
    this.#context = context;
    this.#oscillator = context.createOscillator();
    this.#gain = context.createGain();

    this.#oscillator.frequency.value = 1; // 1Hz
    this.#gain.gain.value = 0; // No mod

    this.#oscillator.connect(this.#gain);
    this.#oscillator.start();
  }

  setFrequency(hz: number, timestamp = this.now) {
    this.#oscillator.frequency.setValueAtTime(hz, timestamp);
  }

  setDepth(amount: number, timestamp = this.now) {
    this.#gain.gain.setValueAtTime(amount, timestamp);
  }

  setWaveform(
    waveform: OscillatorType | PeriodicWave | CustomLibWaveform,
    customWaveOptions?: WaveformOptions,
  ) {
    if (waveform instanceof PeriodicWave) {
      this.#oscillator.setPeriodicWave(waveform);
    } else if (typeof waveform === "string" && isCustomLibWaveform(waveform)) {
      // It's a custom library waveform string
      const periodicWave = createWave(this.#context, waveform, customWaveOptions);
      this.#oscillator.setPeriodicWave(periodicWave);
    } else {
      // It's a built-in OscillatorType
      this.#oscillator.type = waveform as OscillatorType;
    }
  }

  setPeriodicWave(wave: PeriodicWave) {
    this.#oscillator.setPeriodicWave(wave);
  }

  // Connect to target AudioParam
  connect(audioParam: AudioParam) {
    this.#gain.connect(audioParam);
    this.#targets.add(audioParam);
  }

  // Disconnect from target
  disconnect(audioParam?: AudioParam) {
    if (audioParam) {
      this.#gain.disconnect(audioParam);
      this.#targets.delete(audioParam);
    } else {
      this.#gain.disconnect();
      this.#targets.clear();
    }
  }

  // Musical pitch helpers
  setMusicalNote(
    midiNote: number,
    options: {
      divisor?: number;
      glideTime?: number;
      timestamp?: number;
      glideFromMidiNote?: number;
    } = {},
  ) {
    const { divisor = 1, glideTime = 0, timestamp = this.now } = options;
    const hz = 440 * Math.pow(2, (midiNote - 69) / 12);
    const scaledHz = hz / divisor;

    if (glideTime <= 0.001) {
      this.setFrequency(scaledHz, timestamp);
      return this;
    }

    if (options.glideFromMidiNote) {
      const fromHz = 440 * Math.pow(2, (options.glideFromMidiNote - 69) / 12);
      const fromScaledHz = fromHz / divisor;
      this.setFrequency(fromScaledHz, timestamp);
    }
    // todo: test diff ramp methods
    this.#oscillator.frequency.setTargetAtTime(scaledHz, timestamp + 0.001, glideTime);
  }

  storeCurrentValues = () => {
    this.#storedValues = {
      rate: this.#oscillator.frequency.value,
      depth: this.#gain.gain.value,
    };
  };

  getStoredValues = () => this.#storedValues;

  getPitchWobbleWaveform() {
    // Number of harmonics for complexity
    const harmonics = 8;
    const real = new Float32Array(harmonics);
    const imag = new Float32Array(harmonics);

    // First value is always 0 (DC offset)
    real[0] = 0;
    imag[0] = 0;

    // Fill harmonics with random values for a unique wobble shape
    for (let i = 1; i < harmonics; i++) {
      real[i] = Math.random() * 0.5; // Random amplitude
      imag[i] = Math.random() * 0.5; // Random phase offset
    }

    const wave = this.#context.createPeriodicWave(real, imag, {
      disableNormalization: true,
    });

    return wave;
  }

  get now() {
    return this.#context.currentTime;
  }

  dispose() {
    this.#oscillator.stop();
    this.#targets.clear();
    this.#storedValues = null;
    this.disconnect();
  }
}
