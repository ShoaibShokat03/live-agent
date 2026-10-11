import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../shared/types';

const envPath = path.join(app.getAppPath(), '.env');
if (fs.existsSync(envPath)) process.loadEnvFile(envPath);

const file = () => path.join(app.getPath('userData'), 'config.json');

let cache: AppConfig | null = null;

export function getConfig(): AppConfig {
  if (cache) return cache;
  let saved: Partial<AppConfig> = {};
  try {
    saved = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch {}
  const env = process.env;
  cache = {
    apiKey: saved.apiKey || env.GEMINI_API_KEY || '',
    model: env.GEMINI_MODEL || saved.model || 'gemini-3.8-live',
    voice: env.GEMINI_VOICE || saved.voice || 'Charon',
    userTitle: env.USER_TITLE || saved.userTitle || 'sir',
    autoApprove: env.AUTO_APPROVE ? env.AUTO_APPROVE === 'true' : !!saved.autoApprove,
    memories: saved.memories ?? [],
  };
  return cache;
}

export function setConfig(patch: Partial<AppConfig>): AppConfig {
  cache = { ...getConfig(), ...patch };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  return cache;
}

export const hideFromCapture = () => process.env.HIDE_FROM_CAPTURE !== 'false';
