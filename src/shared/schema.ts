import type { JSONSchema } from './types';

export interface Validation {
  ok: boolean;
  value: any;
  errors: string[];
}

/**
 * Validates and coerces tool args against a JSONSchema subset.
 * Models occasionally send "42" for numbers or "true" for booleans; we coerce those
 * instead of failing, fill defaults, and report precise errors otherwise.
 */
export function validateArgs(schema: JSONSchema, input: unknown): Validation {
  const errors: string[] = [];
  const value = walk(schema, input ?? (schema.type === 'object' ? {} : input), 'args', errors);
  return { ok: errors.length === 0, value, errors };
}

function walk(s: JSONSchema, v: any, path: string, errors: string[]): any {
  if (v === undefined || v === null) return s.default !== undefined ? s.default : v;
  switch (s.type) {
    case 'object': {
      if (typeof v !== 'object' || Array.isArray(v)) {
        errors.push(`${path} must be an object`);
        return v;
      }
      const out: Record<string, any> = { ...v };
      for (const [k, sub] of Object.entries(s.properties ?? {})) {
        const r = walk(sub, v[k], `${path}.${k}`, errors);
        if (r !== undefined) out[k] = r;
      }
      for (const req of s.required ?? []) {
        if (out[req] === undefined || out[req] === null || out[req] === '') errors.push(`${path}.${req} is required`);
      }
      return out;
    }
    case 'array': {
      if (!Array.isArray(v)) {
        errors.push(`${path} must be an array`);
        return v;
      }
      return s.items ? v.map((x, i) => walk(s.items!, x, `${path}[${i}]`, errors)) : v;
    }
    case 'number':
    case 'integer': {
      let n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || Number.isNaN(n)) {
        errors.push(`${path} must be a number`);
        return v;
      }
      if (s.type === 'integer') n = Math.round(n);
      if (s.minimum !== undefined && n < s.minimum) n = s.minimum;
      if (s.maximum !== undefined && n > s.maximum) n = s.maximum;
      return n;
    }
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1) return true;
      if (v === 'false' || v === 0) return false;
      errors.push(`${path} must be a boolean`);
      return v;
    case 'string': {
      const str = typeof v === 'string' ? v : String(v);
      if (s.enum && !s.enum.includes(str)) {
        const ci = s.enum.find((e) => e.toLowerCase() === str.toLowerCase());
        if (ci) return ci;
        errors.push(`${path} must be one of: ${s.enum.join(', ')}`);
      }
      return str;
    }
    default:
      return v;
  }
}
