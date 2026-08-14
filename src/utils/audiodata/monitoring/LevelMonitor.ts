/**
 * Utility for monitoring audio levels in real-time
 */
export class LevelMonitor {
  #context: AudioContext;
  #inputNode: AudioNode;
  #outputNode: AudioNode;
  #inputAnalyser: AnalyserNode;
  #outputAnalyser: AnalyserNode;
  #inputData: Float32Array;
  #outputData: Float32Array;
  #monitoringInterval: number | null = null;
  #originalConnections = new Map<
    AudioNode,
    { node: AudioNode | AudioParam; output?: number; input?: number }[]
  >();
  #splitterNode: GainNode | null = null;

  /**
   * Create a level monitor for an audio node chain
   * @param context AudioContext to use
   * @param inputNode Node to monitor input from
   * @param outputNode Node to monitor output from
   * @param fftSize Size of FFT for analysis (larger = more precise but more CPU)
   */
  constructor(
    context: AudioContext,
    inputNode: AudioNode,
    outputNode: AudioNode,
    fftSize: number = 1024
  ) {
    this.#context = context;
    this.#inputNode = inputNode;
    this.#outputNode = outputNode;

    // Create analyzers
    this.#inputAnalyser = context.createAnalyser();
    this.#outputAnalyser = context.createAnalyser();

    // Set FFT size
    this.#inputAnalyser.fftSize = fftSize;
    this.#outputAnalyser.fftSize = fftSize;

    // Create data arrays
    this.#inputData = new Float32Array(this.#inputAnalyser.fftSize);
    this.#outputData = new Float32Array(this.#outputAnalyser.fftSize);
  }

  /**
   * Start monitoring levels
   * @param intervalMs How often to log levels (in milliseconds)
   * @param callback Optional callback to receive level data
   * @returns this instance for chaining
   */
  start(
    intervalMs: number = 1000,
    callback?: (levels: LevelData) => void,
    logOutput: boolean = false
  ): this {
    // Stop any existing monitoring
    this.stop();

    // Insert analyzers into the signal chain
    this.#insertAnalyzers();

    // Start monitoring interval
    this.#monitoringInterval = window.setInterval(() => {
      const levels = this.getLevels();

      // Call callback if provided
      if (callback) {
        callback(levels);
      }

      if (logOutput) {
        // Default behavior: log to console
        this.#logLevels(levels);
      }
    }, intervalMs);

    return this;
  }

  /**
   * Get current levels (can be called manually)
   * @returns Object containing level measurements
   */
  getLevels(): LevelData {
    // Get time domain data
    this.#inputAnalyser.getFloatTimeDomainData(this.#inputData);
    this.#outputAnalyser.getFloatTimeDomainData(this.#outputData);

    // Calculate values
    const inputRMS = this.#calculateRMS(this.#inputData);
    const outputRMS = this.#calculateRMS(this.#outputData);
    const inputPeak = this.#calculatePeak(this.#inputData);
    const outputPeak = this.#calculatePeak(this.#outputData);

    // Convert to dB
    const inputRMSdB = this.#linearToDecibel(inputRMS);
    const outputRMSdB = this.#linearToDecibel(outputRMS);
    const inputPeakdB = this.#linearToDecibel(inputPeak);
    const outputPeakdB = this.#linearToDecibel(outputPeak);

    // Calculate gain change
    const gainChange = inputPeakdB - outputPeakdB;

    return {
      input: {
        rms: inputRMS,
        peak: inputPeak,
        rmsDB: inputRMSdB,
        peakDB: inputPeakdB,
      },
      output: {
        rms: outputRMS,
        peak: outputPeak,
        rmsDB: outputRMSdB,
        peakDB: outputPeakdB,
      },
      gainChange,
      gainChangeDB: gainChange,
    };
  }

  /**
   * Insert analyzers into the signal chain
   */
  #insertAnalyzers(): void {
    try {
      // 1. Store original connections before modifying
      const outputConnections = this.#getNodeConnections(this.#outputNode);
      this.#originalConnections.set(this.#outputNode, outputConnections);

      // 2. Insert input analyzer (non-destructively)
      // Create a gain node to split the signal for analysis
      const inputSplitter = this.#context.createGain();
      inputSplitter.gain.value = 1.0;

      // Connect input node to splitter
      this.#inputNode.connect(inputSplitter);

      // Connect splitter to input analyzer (for monitoring)
      inputSplitter.connect(this.#inputAnalyser);

      // 3. Insert output analyzer
      // Disconnect output node from its destinations
      this.#outputNode.disconnect();

      // Connect output node to output analyzer
      this.#outputNode.connect(this.#outputAnalyser);

      // 4. Reconnect to original destinations
      for (const connection of outputConnections) {
        if (connection.node instanceof AudioNode) {
          this.#outputAnalyser.connect(
            connection.node,
            connection.output,
            connection.input
          );
        } else if (connection.node instanceof AudioParam) {
          this.#outputAnalyser.connect(connection.node, connection.output);
        }
      }

      // Store splitter for cleanup
      this.#splitterNode = inputSplitter;
    } catch (error) {
      console.error('Error setting up level monitoring:', error);
    }
  }

  /**
   * Helper to get all connections from a node (simplified)
   */
  #getNodeConnections(
    node: AudioNode
  ): { node: AudioNode | AudioParam; output?: number; input?: number }[] {
    // This is a placeholder - Web Audio API doesn't provide a way to inspect connections
    // In a real implementation, you'd need to track connections manually

    // For now, we'll assume the node is connected to the destination
    return [
      {
        node: this.#context.destination,
        output: 0,
        input: 0,
      },
    ];
  }

  /**
   * Remove analyzers and restore original connections
   */
  stop(): void {
    if (this.#monitoringInterval) {
      window.clearInterval(this.#monitoringInterval);
      this.#monitoringInterval = null;

      try {
        // Disconnect analyzers
        this.#inputAnalyser.disconnect();
        this.#outputAnalyser.disconnect();

        // Disconnect splitter if it exists
        if (this.#splitterNode) {
          this.#splitterNode.disconnect();
          this.#splitterNode = null;
        }

        // Restore original connections
        const outputConnections = this.#originalConnections.get(
          this.#outputNode
        );
        if (outputConnections) {
          this.#outputNode.disconnect();
          for (const connection of outputConnections) {
            if (connection.node instanceof AudioNode) {
              this.#outputNode.connect(
                connection.node,
                connection.output,
                connection.input
              );
            } else if (connection.node instanceof AudioParam) {
              this.#outputNode.connect(connection.node, connection.output);
            }
          }
        }

        this.#originalConnections.clear();
      } catch (error) {
        console.error('Error removing level monitoring:', error);
      }
    }
  }

  /**
   * Log levels to console
   */
  #logLevels(levels: LevelData): void {
    console.log(
      `Audio Levels:
       Input:  RMS ${levels.input.rmsDB.toFixed(1)} dB | Peak ${levels.input.peakDB.toFixed(1)} dB
       Output: RMS ${levels.output.rmsDB.toFixed(1)} dB | Peak ${levels.output.peakDB.toFixed(1)} dB
       Gain Change: ${levels.gainChangeDB > 0 ? '+' : ''}${levels.gainChangeDB.toFixed(1)} dB`
    );
  }

  /**
   * Calculate RMS (Root Mean Square) value of a signal
   */
  #calculateRMS(data: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i] * data[i];
    }
    return Math.sqrt(sum / data.length);
  }

  /**
   * Calculate peak value of a signal
   */
  #calculatePeak(data: Float32Array): number {
    let peak = 0;
    for (let i = 0; i < data.length; i++) {
      const abs = Math.abs(data[i]);
      if (abs > peak) {
        peak = abs;
      }
    }
    return peak;
  }

  /**
   * Convert linear amplitude to decibels
   */
  #linearToDecibel(linear: number): number {
    // Avoid log(0)
    if (linear < 0.0000001) {
      return -100;
    }
    return 20 * Math.log10(linear);
  }
}

/**
 * Level measurement data
 */
export interface LevelData {
  input: {
    rms: number;
    peak: number;
    rmsDB: number;
    peakDB: number;
  };
  output: {
    rms: number;
    peak: number;
    rmsDB: number;
    peakDB: number;
  };
  gainChange: number;
  gainChangeDB: number;
}

/* Usage Examples:

// Basic usage with MasterBus
masterBus.startLevelMonitoring();
masterBus.logLevels();
masterBus.stopLevelMonitoring();

// Direct usage with any audio nodes
import { LevelMonitor } from '@/utils';

// Create a monitor for any audio node chain
const monitor = new LevelMonitor(
  audioContext,
  inputNode,
  outputNode
);

// Start monitoring with custom interval
monitor.start(500);

// Get levels manually
const levels = monitor.getLevels();
console.log(`Peak level: ${levels.input.peakDB} dB`);

// Use custom callback
monitor.start(1000, (levels) => {
  // Update UI with levels
  meterElement.style.height = `${Math.max(0, levels.input.peakDB + 100)}%`;
});

// Stop when done
monitor.stop();
*/
