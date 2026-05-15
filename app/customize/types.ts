import { themes } from '../../lib/svg/themes';

export type Scale = 'linear' | 'log';

export type ExportFormat = 'markdown' | 'html';

export type ThemeKey = Extract<keyof typeof themes, string>;

export const THEME_KEYS = Object.keys(themes) as ThemeKey[];

export const SPEEDS = [
  { value: '4s', label: 'Fast  (4s)' },
  { value: '8s', label: 'Default (8s)' },
  { value: '12s', label: 'Slow  (12s)' },
  { value: '20s', label: 'Ultra-slow (20s)' },
] as const;
