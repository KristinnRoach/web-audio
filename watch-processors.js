#!/usr/bin/env node
import { watch } from 'fs';
import { exec } from 'child_process';
import path from 'path';

console.log('Starting worklet processor watcher...');

// Watch for changes in the worklets directory
const watcher = watch('./src/worklets', { recursive: true });

console.log('Watching for changes in worklet processors...');

watcher.on('change', (eventType, filename) => {
  if (filename) {
    console.log(`${filename} changed, rebuilding processors...`);
    
    // Execute the build-processors.js script
    exec('node build-processors.js', (error, stdout, stderr) => {
      if (error) {
        console.error(`Error: ${error.message}`);
        return;
      }
      
      if (stderr) {
        console.error(`stderr: ${stderr}`);
        return;
      }
      
      console.log(stdout);
    });
  }
});

// Keep the process running
process.stdin.resume();

// Handle CTRL+C gracefully
process.on('SIGINT', () => {
  console.log('Stopping worklet processor watcher...');
  process.exit(0);
});
