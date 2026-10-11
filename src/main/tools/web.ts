import { obj, type ToolDef } from './registry';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function htmlToText(html: string) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim() ?? '';
  const text = html
    .replace(/<(script|style|noscript|svg|head|nav|footer)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|br|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#\d+|#x[0-9a-f]+|\w+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITIES[e] ?? m,
    )
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
  return { title, text };
}

export const webTools: ToolDef[] = [
  {
    name: 'web_fetch',
    description:
      'Fetch a web page or JSON API and return its readable text. For general questions prefer your built-in Google Search; use this to read a specific URL.',
    parameters: obj({ url: { type: 'string' }, max_chars: { type: 'integer', default: 8000, maximum: 40000 } }, ['url']),
    timeoutMs: 20000,
    async run({ url, max_chars }) {
      const u = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      const res = await fetch(u, {
        headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36' },
        signal: AbortSignal.timeout(15000),
        redirect: 'follow',
      });
      const type = res.headers.get('content-type') ?? '';
      const body = await res.text();
      if (type.includes('json')) return { status: res.status, url: res.url, json: body.slice(0, max_chars) };
      const { title, text } = type.includes('html') ? htmlToText(body) : { title: '', text: body };
      return { status: res.status, url: res.url, title, truncated: text.length > max_chars, text: text.slice(0, max_chars) };
    },
  },
];
