import {
  FbDelayConfig,
  DistortionConfig,
  DistortionWorklet,
  DelayConfig,
  DelayWorklet,
} from './worklet-types';
import { WorkletNode } from './WorkletNode';

function createFeedbackDelay(context: AudioContext) {
  return new WorkletNode<FbDelayConfig>(context, 'feedback-delay-processor');
}

function createDistortion(context: AudioContext) {
  return new WorkletNode<DistortionConfig>(
    context,
    'distortion-processor'
  ) as DistortionWorklet;
}

function createDelay(context: AudioContext) {
  return new WorkletNode<DelayConfig>(
    context,
    'delay-processor'
  ) as DelayWorklet;
}

export { createFeedbackDelay, createDistortion };
export { createDelay };
