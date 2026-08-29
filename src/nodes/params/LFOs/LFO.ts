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

  // Mirrors what was last applied to the oscillator, so a replacement
  // oscillator can be built with the same settings.
  #waveform: OscillatorType | PeriodicWave = "sine";
  #frequency = 1;

  constructor(context: AudioContext) {
    this.#context = context;
    this.#gain = context.createGain();
    this.#gain.gain.value = 0; // No mod

    this.#oscillator = this.#createOscillator();
  }

  #createOscillator(startTime = this.now) {
    const osc = this.#context.createOscillator();

    if (this.#waveform instanceof PeriodicWave) {
      osc.setPeriodicWave(this.#waveform);
    } else {
      osc.type = this.#waveform;
    }

    osc.frequency.value = this.#frequency;
    osc.connect(this.#gain);
    osc.start(startTime);

    return osc;
  }

  /**
   * Key sync: replace the oscillator so its phase is 0 at `timestamp`.
   * The old one stops at the same time, so there is no gap or overlap.
   *
   * Call this from a note-on to make the modulation land identically on
   * every note. Costs one OscillatorNode allocation per call.
   *
   * The replacement starts at the frequency last requested via
   * setFrequency/setMusicalNote. Pending frequency automation on the old
   * oscillator is dropped, whether a ramp or an event scheduled for a
   * future timestamp, so skip the retrigger while gliding and set the
   * frequency after retriggering rather than before.
   */
  retrigger(timestamp = this.now) {
    const at = Math.max(timestamp, this.now);
    const previous = this.#oscillator;

    this.#oscillator = this.#createOscillator(at);

    previous.stop(at);
    previous.onended = () => previous.disconnect();

    return this;
  }

  setFrequency(hz: number, timestamp = this.now) {
    this.#frequency = hz;
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
      this.#waveform = waveform;
      this.#oscillator.setPeriodicWave(waveform);
    } else if (typeof waveform === "string" && isCustomLibWaveform(waveform)) {
      // It's a custom library waveform string
      const periodicWave = createWave(this.#context, waveform, customWaveOptions);
      this.#waveform = periodicWave;
      this.#oscillator.setPeriodicWave(periodicWave);
    } else {
      // It's a built-in OscillatorType
      this.#waveform = waveform as OscillatorType;
      this.#oscillator.type = waveform as OscillatorType;
    }
  }

  setPeriodicWave(wave: PeriodicWave) {
    this.#waveform = wave;
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
    this.#frequency = scaledHz;
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
