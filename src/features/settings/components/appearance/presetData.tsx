import type { AppTheme } from '@shared/theme';
import type { TranslationKey } from '@shared/i18n';

export interface ThemePresetPalette {
  bg: string;
  surface: string;
  border: string;
  accent: string;
  text: string;
}

export interface ThemePresetDefinition {
  id: AppTheme;
  nameKey: TranslationKey;
  tagKey: TranslationKey;
  descKey: TranslationKey;
  palette: ThemePresetPalette;
}

export const THEME_PRESET_DEFINITIONS: readonly ThemePresetDefinition[] = [
  {
    id: 'DjRomoro',
    nameKey: 'theme.preset_djromoro_name',
    tagKey: 'theme.preset_djromoro_tag',
    descKey: 'theme.preset_djromoro_desc',
    palette: {
      bg: '#05080d',
      surface: '#07131d',
      border: '#245066',
      accent: '#00e5ff',
      text: '#e6f7ff',
    },
  },
  {
    id: 'arch-electric',
    nameKey: 'theme.preset_arch_name',
    tagKey: 'theme.preset_arch_tag',
    descKey: 'theme.preset_arch_desc',
    palette: {
      bg: '#05080d',
      surface: '#07131d',
      border: '#245066',
      accent: '#1793d1',
      text: '#e6f7ff',
    },
  },
  {
    id: 'Gentleman-Sexy-Djr',
    nameKey: 'theme.preset_gentleman_name',
    tagKey: 'theme.preset_gentleman_tag',
    descKey: 'theme.preset_gentleman_desc',
    palette: {
      bg: '#070508',
      surface: '#130C12',
      border: '#723C54',
      accent: '#F43888',
      text: '#FAF5F8',
    },
  },
  {
    id: 'Minimalist-Ninja',
    nameKey: 'theme.preset_ninja_name',
    tagKey: 'theme.preset_ninja_tag',
    descKey: 'theme.preset_ninja_desc',
    palette: {
      bg: '#000000',
      surface: '#000000',
      border: '#1f1f1f',
      accent: '#10B981',
      text: '#ECECEC',
    },
  },
  {
    id: 'dark',
    nameKey: 'theme.preset_dark_name',
    tagKey: 'theme.preset_dark_tag',
    descKey: 'theme.preset_dark_desc',
    palette: {
      bg: '#0d1117',
      surface: '#161b22',
      border: '#30363d',
      accent: '#1f6feb',
      text: '#e6edf3',
    },
  },
  {
    id: 'light',
    nameKey: 'theme.preset_light_name',
    tagKey: 'theme.preset_light_tag',
    descKey: 'theme.preset_light_desc',
    palette: {
      bg: '#ffffff',
      surface: '#f6f8fa',
      border: '#d0d7de',
      accent: '#0969da',
      text: '#1f2328',
    },
  },
  {
    id: 'system',
    nameKey: 'theme.preset_system_name',
    tagKey: 'theme.preset_system_tag',
    descKey: 'theme.preset_system_desc',
    palette: {
      bg: '#161b22',
      surface: '#21262d',
      border: '#30363d',
      accent: '#58a6ff',
      text: '#f0f6fc',
    },
  },
] as const;

export const ACCENT_SWATCHES = [
  { name: 'Cian Neón', hex: '#00e5ff' },
  { name: 'Azul Eléctrico', hex: '#1f6feb' },
  { name: 'Verde Esmeralda', hex: '#10b981' },
  { name: 'Terracota Gentleman', hex: '#e06c75' },
  { name: 'Ámbar Cálido', hex: '#f59e0b' },
  { name: 'Violeta Neón', hex: '#a855f7' },
  { name: 'Celeste Suave', hex: '#38bdf8' },
] as const;

export const LOADER_PALETTE_SWATCHES = [
  { name: 'Verde Hacker', hex: '#00ff0a' },
  { name: 'Cian Neón', hex: '#00e5ff' },
  { name: 'Azul Eléctrico', hex: '#1f6feb' },
  { name: 'Verde Esmeralda', hex: '#10b981' },
  { name: 'Terracota Gentleman', hex: '#e06c75' },
  { name: 'Ámbar Cálido', hex: '#f59e0b' },
  { name: 'Violeta Neón', hex: '#a855f7' },
  { name: 'Rosa Neón', hex: '#ff007f' },
] as const;

export const TEXT_COLOR_SWATCHES = [
  { name: 'Blanco Puro', hex: '#ffffff' },
  { name: 'Gris Claro OLED', hex: '#ececec' },
  { name: 'Gris GitHub Dark', hex: '#e6edf3' },
  { name: 'Cian Hielo', hex: '#e6f7ff' },
  { name: 'Verde Menta Suave', hex: '#a7f3d0' },
  { name: 'Ámbar Cálido', hex: '#fde68a' },
  { name: 'Rosa Pastel', hex: '#fbcfe8' },
  { name: 'Gris Muted', hex: '#9ca3af' },
] as const;

export const LABEL_COLOR_SWATCHES = [
  { name: 'Verde Esmeralda', hex: '#10b981' },
  { name: 'Cian Neón', hex: '#00e5ff' },
  { name: 'Azul Eléctrico', hex: '#1f6feb' },
  { name: 'Terracota Gentleman', hex: '#e06c75' },
  { name: 'Ámbar Neón', hex: '#f59e0b' },
  { name: 'Violeta Neón', hex: '#a855f7' },
  { name: 'Rosa Neón', hex: '#ec4899' },
  { name: 'Verde Menta Neón', hex: '#34d399' },
] as const;

export function findPresetDefinition(themeId: AppTheme): ThemePresetDefinition {
  const match = THEME_PRESET_DEFINITIONS.find((p) => p.id === themeId);
  return match ?? THEME_PRESET_DEFINITIONS[0];
}

export function resolvePresetPalette(
  themeId: AppTheme,
  systemPreferred?: 'dark' | 'light'
): ThemePresetPalette {
  if (themeId === 'system') {
    const resolvedId: AppTheme = systemPreferred === 'light' ? 'light' : 'dark';
    return findPresetDefinition(resolvedId).palette;
  }
  return findPresetDefinition(themeId).palette;
}
