/**
 * Face recognition, fully on this PC (face-api / TensorFlow.js on WebGL):
 * detect → 68 landmarks → 128-d descriptor → nearest enrolled person.
 */
import * as faceapi from '@vladmandic/face-api';
import { hud } from '../bridge';

/** face-api's standard Euclidean threshold for "same person" on 128-d descriptors. */
const MATCH_DISTANCE = 0.5;

let ready: Promise<void> | null = null;

export function loadFaceModels() {
  ready ??= (async () => {
    const tf = faceapi.tf as any; // bundled typings omit the backend API
    await tf.setBackend('webgl');
    await tf.ready();
    const uri = 'models://face/';
    await Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri(uri),
      faceapi.nets.faceLandmark68Net.loadFromUri(uri),
      faceapi.nets.faceRecognitionNet.loadFromUri(uri),
    ]);
  })();
  ready.catch(() => (ready = null));
  return ready;
}

export interface SeenFace {
  name: string | null;
  distance: number;
  /** Box in source pixels. */
  box: { x: number; y: number; width: number; height: number };
  descriptor: Float32Array;
}

let matcher: faceapi.FaceMatcher | null = null;
let matcherStale = true;
export const invalidateFaces = () => (matcherStale = true);

async function getMatcher() {
  if (matcherStale) {
    matcherStale = false;
    const db = await hud.people.faces();
    matcher = db.length
      ? new faceapi.FaceMatcher(
          db.map((p) => new faceapi.LabeledFaceDescriptors(p.name, p.descriptors.map((d) => Float32Array.from(d)))),
          MATCH_DISTANCE,
        )
      : null;
  }
  return matcher;
}

export async function detectFaces(input: HTMLVideoElement | HTMLCanvasElement): Promise<SeenFace[]> {
  await loadFaceModels();
  const results = await faceapi
    .detectAllFaces(input, new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.5 }))
    .withFaceLandmarks()
    .withFaceDescriptors();
  const m = await getMatcher();
  return results.map((r) => {
    const best = m?.findBestMatch(r.descriptor);
    const known = best && best.label !== 'unknown';
    const b = r.detection.box;
    return {
      name: known ? best!.label : null,
      distance: best ? +best.distance.toFixed(3) : 1,
      box: { x: b.x, y: b.y, width: b.width, height: b.height },
      descriptor: r.descriptor,
    };
  });
}
