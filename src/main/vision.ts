import { GoogleGenAI, MediaResolution, ThinkingLevel, Type } from '@google/genai';
import { desktopCapturer, screen, type NativeImage } from 'electron';
import { getConfig } from './config';
import { gdiCapture } from './native/capture';

/**
 * Hides the HUD for the duration of a capture. Windows can't exclude Electron's transparent
 * (DirectComposition) overlay from screen capture, so the HUD renders one invisible frame instead.
 */
type Guard = <T>(fn: () => Promise<T>) => Promise<T>;
let guard: Guard = (fn) => fn();
export const setCaptureGuard = (g: Guard) => (guard = g);

/**
 * Primary display as a NativeImage at (up to) native resolution, plus its physical geometry,
 * with the JARVIS HUD hidden so the model sees only the real desktop.
 */
export function captureScreen(maxWidth = 1920) {
  return guard(() => rawCapture(maxWidth));
}

async function rawCapture(maxWidth: number) {
  const d = screen.getPrimaryDisplay();
  const physW = Math.round(d.size.width * d.scaleFactor);
  const physH = Math.round(d.size.height * d.scaleFactor);
  const width = Math.min(maxWidth, physW);
  const height = Math.round((width * physH) / physW);
  const origin = process.platform === 'win32' ? screen.dipToScreenPoint({ x: d.bounds.x, y: d.bounds.y }) : { x: d.bounds.x, y: d.bounds.y };
  let image: NativeImage;
  if (process.platform === 'win32') {
    image = gdiCapture(origin.x, origin.y, physW, physH);
    if (width !== physW) image = image.resize({ width, height, quality: 'good' });
  } else {
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
    const src = sources.find((s) => s.display_id === String(d.id)) ?? sources[0];
    if (!src) throw new Error('No screen source available');
    image = src.thumbnail;
  }
  return { image, width, height, physW, physH, origin, scale: width / physW };
}

let client: GoogleGenAI | null = null;
let clientKey = '';
function ai() {
  const key = getConfig().apiKey;
  if (!key) throw new Error('No Gemini API key configured');
  if (!client || key !== clientKey) {
    client = new GoogleGenAI({ apiKey: key });
    clientKey = key;
  }
  return client;
}

export const visionModel = () => process.env.GEMINI_VISION_MODEL || 'gemini-3.8-flash';

export interface Located {
  found: boolean;
  /** Normalized 0-1000 box on the primary screen. */
  box?: { x: number; y: number; width: number; height: number };
  center?: { x: number; y: number };
  label?: string;
  reason?: string;
}

/**
 * Precise visual grounding: a Gemini model trained for detection finds the described UI target
 * on a full-resolution screenshot and returns its bounding box (0-1000 grid).
 */
export async function locate(description: string, jpegBase64?: string): Promise<Located> {
  const data = jpegBase64 ?? (await captureScreen()).image.toJPEG(88).toString('base64');
  const prompt =
    `This is a screenshot of a Windows desktop. Find this UI target: "${description}".\n` +
    'Return the single best match as box_2d [ymin, xmin, ymax, xmax] normalized to 0-1000, tight around the clickable element. ' +
    'If it is not visible on screen, return found=false and say why in reason.';
  const res = await ai().models.generateContent({
    model: visionModel(),
    contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data } }] }],
    config: {
      temperature: 0,
      mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
      thinkingConfig: { thinkingLevel: ThinkingLevel.MINIMAL },
      responseMimeType: 'application/json',
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          found: { type: Type.BOOLEAN },
          box_2d: { type: Type.ARRAY, items: { type: Type.INTEGER } },
          label: { type: Type.STRING },
          reason: { type: Type.STRING },
        },
        required: ['found'],
      },
    },
  });
  const out = JSON.parse(res.text ?? '{}');
  const b: number[] | undefined = out.box_2d;
  if (!out.found || !Array.isArray(b) || b.length !== 4) return { found: false, reason: out.reason ?? 'Not found' };
  const [ymin, xmin, ymax, xmax] = b.map((v) => Math.max(0, Math.min(1000, v)));
  const box = { x: xmin, y: ymin, width: Math.max(1, xmax - xmin), height: Math.max(1, ymax - ymin) };
  return {
    found: true,
    box,
    center: { x: Math.round(xmin + box.width / 2), y: Math.round(ymin + box.height / 2) },
    label: out.label,
  };
}
