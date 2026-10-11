import { Type, type FunctionDeclaration, type Schema } from '@google/genai';
import type { JSONSchema, ToolManifest } from '../../shared/types';

const TYPES = {
  object: Type.OBJECT,
  string: Type.STRING,
  number: Type.NUMBER,
  integer: Type.INTEGER,
  boolean: Type.BOOLEAN,
  array: Type.ARRAY,
} as const;

/** JSONSchema subset → Gemini OpenAPI-style Schema. */
export function toGeminiSchema(s: JSONSchema): Schema {
  const out: Schema = {};
  if (s.type) out.type = TYPES[s.type];
  const desc = [s.description, s.default !== undefined ? `Default: ${JSON.stringify(s.default)}.` : '']
    .filter(Boolean)
    .join(' ');
  if (desc) out.description = desc;
  if (s.enum) {
    out.enum = s.enum;
    out.format = 'enum';
  }
  if (s.minimum !== undefined) out.minimum = s.minimum;
  if (s.maximum !== undefined) out.maximum = s.maximum;
  if (s.items) out.items = toGeminiSchema(s.items);
  if (s.properties) {
    out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, toGeminiSchema(v)]));
    if (s.required?.length) out.required = s.required;
  }
  return out;
}

export function toDeclarations(tools: ToolManifest[]): FunctionDeclaration[] {
  return tools.map((t) => {
    const hasParams = Object.keys(t.parameters.properties ?? {}).length > 0;
    return {
      name: t.name,
      description: t.description,
      ...(hasParams ? { parameters: toGeminiSchema(t.parameters) } : {}),
    };
  });
}
