/**
 * People the user has introduced to JARVIS: face descriptors + voiceprints, keyed by name.
 * Biometric data — stored encrypted with Windows' per-user data protection (Electron safeStorage),
 * on this PC only, and never readable by the AI's file tools.
 */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { cosine, VOICE_MARGIN, VOICE_THRESHOLD } from './voiceprint';

export interface Person {
  name: string;
  faces: number[][]; // 128-d face descriptors
  voices: number[][]; // 512-d speaker embeddings
  created: string;
  updated: string;
}

const MAX_FACES = 20;
const MAX_VOICES = 12;

const file = () => path.join(app.getPath('userData'), 'people.dat');
let cache: Person[] | null = null;

function load(): Person[] {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    const json = raw.startsWith('enc:') ? safeStorage.decryptString(Buffer.from(raw.slice(4), 'base64')) : raw;
    cache = JSON.parse(json);
  } catch {
    cache = [];
  }
  return cache!;
}

function save(list: Person[]) {
  cache = list;
  const json = JSON.stringify(list);
  const data = safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(json).toString('base64') : json;
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), data, 'utf8');
  } catch (e: any) {
    if (e?.code === 'ENOSPC') throw new Error('Drive C: is full, so JARVIS cannot save. Free up some space and try again.');
    throw e;
  }
}

const norm = (n: string) => n.trim().toLowerCase();
const find = (list: Person[], name: string) => list.find((p) => norm(p.name) === norm(name));

function upsert(name: string, mutate: (p: Person) => void) {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('A name is required');
  const list = [...load()];
  let p = find(list, clean);
  if (!p) {
    p = { name: clean, faces: [], voices: [], created: new Date().toISOString(), updated: '' };
    list.push(p);
  }
  mutate(p);
  p.updated = new Date().toISOString();
  save(list);
  return p;
}

export const listPeople = () => load().map((p) => ({ name: p.name, faceSamples: p.faces.length, voiceSamples: p.voices.length, since: p.created.slice(0, 10) }));

export const faceDb = () => load().filter((p) => p.faces.length).map((p) => ({ name: p.name, descriptors: p.faces }));

export function addFaces(name: string, descriptors: number[][]) {
  const p = upsert(name, (p) => (p.faces = [...p.faces, ...descriptors].slice(-MAX_FACES)));
  return { name: p.name, faceSamples: p.faces.length };
}

export function addVoice(name: string, embedding: number[]) {
  const p = upsert(name, (p) => (p.voices = [...p.voices, embedding].slice(-MAX_VOICES)));
  return { name: p.name, voiceSamples: p.voices.length };
}

export function forgetPerson(name: string) {
  const list = load();
  const next = list.filter((p) => norm(p.name) !== norm(name));
  if (next.length === list.length) return false;
  save(next);
  return true;
}

/** Best voice match with a margin over the runner-up (see VOICE_THRESHOLD notes). */
export function matchVoice(embedding: number[]) {
  const scored = load()
    .filter((p) => p.voices.length)
    .map((p) => ({ name: p.name, score: Math.max(...p.voices.map((v) => cosine(v, embedding))) }))
    .sort((a, b) => b.score - a.score);
  const [best, second] = scored;
  const ok = !!best && best.score >= VOICE_THRESHOLD && best.score - (second?.score ?? 0) >= VOICE_MARGIN;
  return {
    name: ok ? best.name : null,
    score: best ? +best.score.toFixed(3) : 0,
    candidates: scored.slice(0, 3).map((s) => ({ name: s.name, score: +s.score.toFixed(3) })),
  };
}
