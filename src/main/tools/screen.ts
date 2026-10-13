import { captureScreen } from '../vision';
import { obj, type ToolDef } from './registry';

/** Grab the primary display as JPEG for the model (HUD excluded — see native/capture.ts). */
export async function captureFrame(maxWidth = 1280, quality = 70) {
  const f = await captureScreen(maxWidth);
  return { data: f.image.toJPEG(quality).toString('base64'), mimeType: 'image/jpeg', width: f.width, height: f.height };
}

export const screenTools: ToolDef[] = [
  {
    name: 'look_at_screen',
    description:
      "Capture the user's screen so you can see it. Use before clicking UI elements, or when asked about what's on screen. Locate targets on the 0-1000 grid of this image.",
    parameters: obj({ detail: { type: 'string', enum: ['normal', 'high'], default: 'normal' } }),
    timeoutMs: 8000,
    async run({ detail }) {
      const f = await captureFrame(detail === 'high' ? 1920 : 1280, detail === 'high' ? 85 : 70);
      return {
        __image: { data: f.data, mimeType: f.mimeType },
        captured: `${f.width}x${f.height}`,
        note: 'Screenshot sent as the latest vision frame. Use the 0-1000 normalized grid for coordinates.',
      };
    },
  },
];
