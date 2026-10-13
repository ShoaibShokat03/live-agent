/**
 * Speaker recognition ("voiceprints"), fully local: WavLM-Base-Plus fine-tuned for speaker
 * verification (Xenova/wavlm-base-plus-sv, ONNX fp32 ~400 MB, downloaded once and cached).
 * fp32, not int8: measured here, int8 quantization scrambled the embeddings (different speakers
 * scored up to 0.76), while fp32 separated voices cleanly even on 2-second clips.
 * Produces a 512-d x-vector per utterance; same speaker ⇒ high cosine similarity.
 */

const MODEL = 'Xenova/wavlm-base-plus-sv';
/**
 * Decision rule, measured on this machine with the fp32 model on 2-8 s clips: same speaker
 * 0.81-0.98, different speakers 0.35-0.49. Accept the best match only if it clears the threshold
 * AND beats the runner-up by a margin; otherwise report "unknown".
 */
export const VOICE_THRESHOLD = 0.7;
export const VOICE_MARGIN = 0.05;

let cacheDir = '';
export const setVoiceCacheDir = (dir: string) => (cacheDir = dir);

type Loaded = { processor: any; model: any };
let loading: Promise<Loaded> | null = null;

export function loadVoiceModel(onProgress?: (pct: number) => void): Promise<Loaded> {
  loading ??= (async () => {
    const t = await import('@huggingface/transformers');
    if (cacheDir) t.env.cacheDir = cacheDir;
    const progress_callback = (p: any) => {
      if (p?.status === 'progress' && typeof p.progress === 'number' && /onnx/.test(p.file ?? '')) onProgress?.(p.progress);
    };
    const [processor, model] = await Promise.all([
      t.AutoProcessor.from_pretrained(MODEL),
      t.AutoModel.from_pretrained(MODEL, { dtype: 'fp32', progress_callback }),
    ]);
    return { processor, model };
  })();
  loading.catch(() => (loading = null)); // allow retry after a failed download
  return loading;
}

/** 16 kHz mono PCM16 → L2-normalized speaker embedding. */
export async function embedVoice(pcm: Int16Array): Promise<number[]> {
  if (pcm.length < 16000 * 0.8) throw new Error('Need at least ~1 second of speech');
  const { processor, model } = await loadVoiceModel();
  const audio = Float32Array.from(pcm, (v) => v / 32768);
  const inputs = await processor(audio);
  const { embeddings } = await model(inputs);
  const e = Array.from(embeddings.data as Float32Array);
  const n = Math.hypot(...e) || 1;
  return e.map((v) => v / n);
}

export const cosine = (a: number[], b: number[]) => a.reduce((s, v, i) => s + v * (b[i] ?? 0), 0);
