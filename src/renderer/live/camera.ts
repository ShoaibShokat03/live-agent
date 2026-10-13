/** Webcam: live preview element + JPEG frames for Gemini and face recognition. */
export class Camera {
  readonly video: HTMLVideoElement;
  private stream?: MediaStream;
  private canvas = document.createElement('canvas');

  constructor() {
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.className = 'cam-video';
  }

  get active() {
    return !!this.stream;
  }

  async start() {
    if (this.stream) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await this.video.play();
    // first frames can be black while the sensor warms up
    await new Promise((r) => setTimeout(r, 300));
  }

  stop() {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = undefined;
    this.video.srcObject = null;
  }

  /** Current frame as base64 JPEG (downscaled for the model). */
  frame(maxWidth = 768, quality = 0.75): string {
    const v = this.video;
    if (!v.videoWidth) throw new Error('Camera has no picture yet');
    const w = Math.min(maxWidth, v.videoWidth);
    const h = Math.round((w * v.videoHeight) / v.videoWidth);
    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.getContext('2d')!.drawImage(v, 0, 0, w, h);
    return this.canvas.toDataURL('image/jpeg', quality).split(',')[1];
  }
}
