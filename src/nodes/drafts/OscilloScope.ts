export class Oscilloscope {
  private node: AnalyserNode;

  private canvas: HTMLCanvasElement;
  private canvasCtx: CanvasRenderingContext2D;

  private get width() {
    return this.canvas.width;
  }
  private get height() {
    return this.canvas.height;
  }

  constructor(ctx: AudioContext, input: AudioNode, canvas: HTMLCanvasElement) {
    this.node = ctx.createAnalyser();
    this.node.fftSize = 2048;
    input.connect(this.node);
    this.node.smoothingTimeConstant = 0.2;

    this.canvas = canvas;
    let canctx = this.canvas.getContext('2d');
    if (!canctx) throw new Error(`canvas.getContext returns null`);

    this.canvasCtx = canctx;
    this.canvasCtx.lineWidth = 1;
    this.canvasCtx.strokeStyle = 'rgb(20,200,120)';
    this.canvasCtx.fillStyle = 'rgba(0, 0, 0, 0)';

    this.run();
  }

  public run() {
    const data = new Uint8Array(this.node.fftSize);
    this.node.getByteTimeDomainData(data);
    this.render(this.getWaveform(data));

    requestAnimationFrame(this.run.bind(this));
  }

  public render(data: Uint8Array) {
    this.canvasCtx.clearRect(0, 0, this.width, this.height);
    this.canvasCtx.fillRect(0, 0, this.width, this.height);
    this.canvasCtx.beginPath();
    this.canvasCtx.moveTo(0, this.height / 2);
    this.canvasCtx.lineTo(this.width, this.height / 2);
    this.canvasCtx.setLineDash([1, 2]);

    this.canvasCtx.stroke();
    this.canvasCtx.beginPath();
    this.canvasCtx.moveTo(this.width / 2, 0);
    this.canvasCtx.lineTo(this.width / 2, this.height);
    this.canvasCtx.setLineDash([1, 2]);
    this.canvasCtx.stroke();

    if (!data.length) {
      return;
    }

    this.canvasCtx.beginPath();
    if (!this.width || !this.height) return;

    let sz = this.canvas.width / data.length,
      i = 0,
      x = 0;

    let y = 0;

    while (x <= this.width) {
      if (i === data.length) {
        i = 0;
      }

      let v = data[i] / 128.0;
      y = this.height - (v * this.height) / 2;

      if (i === 0) {
        this.canvasCtx.moveTo(x, y);
      } else {
        this.canvasCtx.lineTo(x, y);
      }

      x += sz;
      ++i;
    }

    const dash = [Math.round(8 * (100 - y)), Math.round(2 * Math.random() + 1)];
    this.canvasCtx.setLineDash(Math.round(0.42 + Math.random()) ? [0] : dash);

    this.canvasCtx.setLineDash([0]);
    this.canvasCtx.lineTo(this.width, this.height / 2);
    this.canvasCtx.stroke();
  }

  public getWaveform(data: Uint8Array): Uint8Array {
    for (let phase = 0, offset = 0, x = 0, xx = data.length; x != xx; ++x) {
      if (data[x] > 127) {
        // 8-bit unsigned, 127 = 0dB

        switch (
          phase // positive phase
        ) {
          case 0:
            offset = x; // set waveform start
            phase += 180; // shift 180 degrees
            continue;

          case 360: // return captured waveform
            return data.slice(offset - 1, x);
        }
      } else {
        switch (
          phase // negative phase
        ) {
          case 180:
            phase += 180; // shift 180 degrees
            continue;
        }
      }
    }

    return new Uint8Array(0);
  }
}

export const createOscilloscope = (
  ctx: AudioContext,
  input: AudioNode,
  canvas: HTMLCanvasElement
) => new Oscilloscope(ctx, input, canvas);
