/** Named accent colors shared by panels, marks and the HUD theme switch. Default: gold. */
export const ACCENTS = {
  gold: '#ffc23d',
  red: '#ff3b3b',
  orange: '#ff8a3d',
  crimson: '#c4161c',
  cyan: '#00e5ff',
  green: '#69f0ae',
  violet: '#b388ff',
  white: '#fff6e6',
} as const;

export type AccentName = keyof typeof ACCENTS;
export const ACCENT_NAMES = Object.keys(ACCENTS) as AccentName[];

export const accentColor = (name?: string) => (name ? ACCENTS[name as AccentName] ?? name : undefined);
