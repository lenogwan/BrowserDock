import type { ThemeId } from "./types";

export interface ThemeMeta {
  id: ThemeId;
  label: string;
  description: string;
  surface: string; // Preview hex
  accent: string;  // Preview hex
  text: string;    // Preview hex
}

export const THEMES: readonly ThemeMeta[] = [
  {
    id: "sage",
    label: "Sage Mint",
    description: "Botanical dark slate with fresh mint accents",
    surface: "#171c1e",
    accent: "#b8edc9",
    text: "#e4e9e5"
  },
  {
    id: "nord",
    label: "Nord Frost",
    description: "Cool arctic slate with glacier cyan highlights",
    surface: "#1e222a",
    accent: "#88c0d0",
    text: "#eceff4"
  },
  {
    id: "amber",
    label: "Midnight Amber",
    description: "Warm charcoal with radiant incandescent amber",
    surface: "#151618",
    accent: "#f5a742",
    text: "#f5ede2"
  },
  {
    id: "tokyo",
    label: "Tokyo Violet",
    description: "Deep midnight indigo with electric neon lilac",
    surface: "#1a1b26",
    accent: "#bb9af7",
    text: "#c0caf5"
  },
  {
    id: "rose",
    label: "Rosé Pine",
    description: "Soft velvet pine with warm dusty rose highlights",
    surface: "#191724",
    accent: "#ebbcba",
    text: "#e0def4"
  }
] as const;

const THEME_SET = new Set<string>(THEMES.map(t => t.id));

export function normalizeTheme(raw: unknown): ThemeId {
  if (typeof raw !== "string") return "sage";
  if (raw === "dark") return "sage";
  return THEME_SET.has(raw) ? (raw as ThemeId) : "sage";
}
