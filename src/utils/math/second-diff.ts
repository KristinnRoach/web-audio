export const second_difference = (input: number[]) => {
  // Computes the second discrete difference of the input array.
  // Returns a new array of length len(input_array) - 2.

  const n = input.length;
  const output: number[] = [];

  for (let i = 0; i < n - 2; i++) {
    // Calculate: -input_array[i] + 2*input_array[i+1] - input_array[i+2]
    output.push(-input[i] + 2 * input[i + 1] - input[i + 2]);
  }

  return output;
};

/*
// Example with audio sample data (simulated)
const audioSamples = [0, 2, 5, 9, 14, 15, 13, 8, 4, 2, 1];
const secondDiff = second_difference(audioSamples);

console.log('Original audio samples:', audioSamples);
console.log('Second difference:', secondDiff);

// Demonstrates edge detection in audio signal
const steadySignal = [10, 10, 10, 10, 10, 10, 10];
const step = [10, 10, 10, 50, 50, 50, 50];
const peak = [10, 10, 30, 50, 30, 10, 10];

console.log('Steady signal 2nd diff:', second_difference(steadySignal));
console.log('Step signal 2nd diff:', second_difference(step));
console.log('Peak signal 2nd diff:', second_difference(peak));

// Simple use case: Detecting sudden changes in audio volume
const audioVolume = [5, 6, 7, 8, 30, 32, 33, 10, 9, 8, 7];
const changes = second_difference(audioVolume);

console.log('Audio volume levels:', audioVolume);
console.log('Volume change detection:', changes);
console.log('Significant changes at indices:');

// Find where significant changes occur (threshold-based detection)
changes.forEach((value, index) => {
  if (Math.abs(value) > 15) {
    console.log(`Position ${index + 1}: Change of ${value} detected`);
  }
});

// This shows how second_difference helps identify sudden changes in a signal
// Useful for: beat detection, audio segmentation, and onset detection
*/
