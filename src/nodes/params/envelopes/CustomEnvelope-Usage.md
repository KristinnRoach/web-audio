# CustomEnvelope Usage Guide

## Overview

`CustomEnvelope` provides audio parameter automation with unlimited number of control points, instead of the traditional 4 points: ADSR.

Each point has the properties time (in seconds) and value (absolute value to be applied to the target audioparam).

Any of these points can be dynamically set to be:

Sustain index: the envelope will stop and hold the sustain
point value until released.

Release index: envelope will continue from the release point to the end when released.

## Quick Start

### 1. Basic Creation

```typescript
import { CustomEnvelope } from '@kidlib/web-audio';

// Create with defaults - using constructor directly
const ampEnv = new CustomEnvelope(audioContext, 'amp-env');
const filterEnv = new CustomEnvelope(audioContext, 'filter-env');
const pitchEnv = new CustomEnvelope(audioContext, 'pitch-env');
```

### 2. Apply to AudioParam

```typescript
// Trigger envelope on note start
ampEnv.triggerEnvelope(gainNode.gain, audioContext.currentTime, {
  baseValue: 1,
  playbackRate: 1,
});

// Release envelope on note end
ampEnv.releaseEnvelope(gainNode.gain, audioContext.currentTime + 2);

// Pitch env modulates around a base value
pitchEnv.triggerEnvelope(oscillatorNode.detune, audioContext.currentTime, {
  baseValue: 0, // detune is in cents, not playback rate
  playbackRate: 1,
});

pitchEnv.releaseEnvelope(oscillatorNode.detune, audioContext.currentTime + 2);
```

## Envelope Types & Value Ranges

### Amplitude Envelope (`amp-env`)

- **Range**: `[0, 1]` (gain multiplier)
- **Default**: ADSR with sustain at index 2, release at index 3

```typescript
const ampEnv = new CustomEnvelope(
  audioContext,
  'amp-env',
  undefined, // sharedData
  [], // initialPoints (will use defaults)
  [0, 1], // paramValueRange
  2, // durationSeconds
  true // initEnable
);
```

### Filter Envelope (`filter-env`)

- **Range**: `[20, 20000]` (Hz frequency)
- **Default**: Fast attack to 18kHz, decay to 500Hz
- **Note**: UI components handle logarithmic scaling for perceptually linear frequency control

```typescript
const filterEnv = new CustomEnvelope(
  audioContext,
  'filter-env',
  undefined,
  [],
  [20, 20000],
  1.5
);

// Apply to filter frequency - values are actual Hz frequencies
filterEnv.triggerEnvelope(filterNode.frequency, startTime, {
  baseValue: 1,
  playbackRate: 1,
});
```

### Pitch Envelope (`pitch-env`)

- **Range**: `[0.5, 1.5]` (playback rate multiplier)
- **Default**: Flat at 0.5 (no pitch change, disabled by default)

```typescript
const pitchEnv = new CustomEnvelope(
  audioContext,
  'pitch-env',
  undefined,
  [
    { time: 0, value: 1.0, curve: 'exponential' }, // Start at normal pitch
    { time: 0.1, value: 1.2, curve: 'exponential' }, // Quick rise
    { time: 2, value: 0.8, curve: 'exponential' }, // Slow fall
  ],
  [0.5, 1.5],
  2
);
```

## Custom Envelopes

### Custom Points

```typescript
const customEnv = new CustomEnvelope(
  audioContext,
  'amp-env',
  undefined, // sharedData
  [
    { time: 0, value: 0, curve: 'exponential' }, // Start silent
    { time: 0.01, value: 1, curve: 'exponential' }, // Fast attack
    { time: 0.5, value: 0.8, curve: 'exponential' }, // Quick decay
    { time: 1.5, value: 0.6, curve: 'exponential' }, // Sustain level
    { time: 2, value: 0, curve: 'exponential' }, // Release
  ],
  [0, 1], // paramValueRange
  2, // durationSeconds
  true // initEnable
);

// Set sustain and release points after creation
customEnv.setSustainPoint(3); // Hold at index 3 until release
customEnv.setReleasePoint(3); // Release from index 3
```

### Custom Value Range

```typescript
const customRange = new CustomEnvelope(
  audioContext,
  'filter-env',
  undefined,
  [
    { time: 0, value: 100, curve: 'exponential' }, // 100 Hz
    { time: 1, value: 8000, curve: 'exponential' }, // 8000 Hz
  ],
  [100, 8000], // Custom frequency range (actual Hz values)
  1
);
```

## Architecture: UI Scaling vs Audio Values

CustomEnvelope works with **raw audio parameter values**:

- **Filter envelopes**: Actual frequency values (20Hz, 1000Hz, 20000Hz)
- **Amplitude envelopes**: Actual gain values (0.0, 0.5, 1.0)
- **Pitch envelopes**: Actual playback rates (0.5, 1.0, 1.5)

**UI components** handle coordinate scaling:

- Linear screen space ↔ Logarithmic frequency space (for filter-env)
- Linear screen space ↔ Linear gain space (for amp-env)

This separation keeps the audio logic simple and predictable.

## Control Methods

### Runtime Control

```typescript
// Enable/disable
envelope.enable();
envelope.disable();

// Loop control
envelope.setLoopEnabled(true);
envelope.setTimeScale(0.5); // Half speed

// Sync to playback rate
envelope.syncToPlaybackRate(true);
```

### Point Manipulation

```typescript
// Add point at 0.5 seconds, value 0.7
envelope.addPoint(0.5, 0.7, 'exponential');

// Update existing point
envelope.updatePoint(1, 0.3, 0.8); // index, time, value

// Delete point
envelope.deletePoint(2);
```

### Sustain & Release

```typescript
// Set sustain point (holds until release)
envelope.setSustainPoint(2); // Point index 2
envelope.setSustainPoint(null); // No sustain

// Set release point (where release starts)
envelope.setReleasePoint(3); // Point index 3
```

## Complete Example

```typescript
import { CustomEnvelope } from '@kidlib/web-audio';

// Create filter envelope with custom sweep
const filterEnv = new CustomEnvelope(
  audioContext,
  'filter-env',
  undefined, // sharedData
  [
    { time: 0, value: 200, curve: 'exponential' }, // Start low
    { time: 0.1, value: 4000, curve: 'exponential' }, // Quick sweep up
    { time: 1.8, value: 800, curve: 'exponential' }, // Slow fall
    { time: 2, value: 400, curve: 'exponential' }, // End point
  ],
  [20, 20000], // paramValueRange
  2 // durationSeconds
);

// Set sustain and release points
filterEnv.setSustainPoint(2); // Hold at 800Hz
filterEnv.setReleasePoint(2); // Release from 800Hz

// Apply to filter
const filterNode = audioContext.createBiquadFilter();
filterNode.type = 'lowpass';

// Trigger on note start
filterEnv.triggerEnvelope(filterNode.frequency, audioContext.currentTime, {
  baseValue: 1,
  playbackRate: 1,
  voiceId: 'voice-1', // Optional for UI sync
});

// Release after 1 second
setTimeout(() => {
  filterEnv.releaseEnvelope(filterNode.frequency, audioContext.currentTime);
}, 1000);

// Clean up
filterEnv.dispose();
```
