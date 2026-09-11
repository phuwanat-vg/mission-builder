/**
 * The two themes, and the one place their colours are read from.
 *
 * Every colour in the application is a CSS variable declared in `style.css`:
 * `:root` carries Drafting, `:root[data-theme="dark"]` carries Dark. The DOM
 * picks a switch up on its own because `applyTheme` only moves one attribute.
 *
 * The three.js scene cannot read CSS, so it reads the same variables once per
 * theme change through `themeColors()` and pushes them into the Viewer and the
 * layers. That keeps one source of truth: no colour is written anywhere but in
 * the two variable blocks.
 */

export type ThemeName = "drafting" | "dark";

export const THEME_NAMES: readonly ThemeName[] = ["drafting", "dark"];

export const THEME_LABELS: Record<ThemeName, string> = {
  drafting: "Drafting (light)",
  dark: "Dark",
};

export function isThemeName(value: unknown): value is ThemeName {
  return value === "drafting" || value === "dark";
}

/** The colours the scene needs, resolved from the CSS variables. */
export interface ThemeColors {
  bg: string;
  panel: string;
  surface: string;
  border: string;
  border2: string;
  text: string;
  muted: string;
  accent: string;
  accentSoft: string;
  ok: string;
  warn: string;
  err: string;
  /** What the canvas is cleared to where no floor plan covers it. */
  mapBg: string;
  /** The 1 m grid under the floor plan. */
  mapGrid: string;
  /** Every tenth line of that grid. */
  mapGridStrong: string;
  /** The halo that keeps a label legible over the floor plan. */
  labelHalo: string;
  /**
   * How wide that halo is drawn, in pixels. The floor plan is white in both
   * themes, so Dark's light label text needs a heavier dark outline than
   * Drafting's dark text needs a white one.
   */
  labelHaloWidth: number;
}

type ColorKey = Exclude<keyof ThemeColors, "labelHaloWidth">;

/** The variable each colour comes from, and what to use if it is missing. */
const SOURCES: Record<ColorKey, [variable: string, fallback: string]> = {
  bg: ["--bg", "#eef0f3"],
  panel: ["--panel", "#f7f8fa"],
  surface: ["--surface", "#ffffff"],
  border: ["--border", "#dfe3e9"],
  border2: ["--border-2", "#c7cdd6"],
  text: ["--text", "#1b2027"],
  muted: ["--muted", "#5c6672"],
  accent: ["--accent", "#1a6fd4"],
  accentSoft: ["--accent-soft", "#e8f0fb"],
  ok: ["--ok", "#1c8a4b"],
  warn: ["--warn", "#b0740f"],
  err: ["--err", "#c62838"],
  mapBg: ["--map-bg", "#ffffff"],
  mapGrid: ["--map-grid", "#e7eaee"],
  mapGridStrong: ["--map-grid-strong", "#dbe0e6"],
  labelHalo: ["--label-halo", "#ffffff"],
};

type Listener = (colors: ThemeColors) => void;
const listeners = new Set<Listener>();

/** Put a theme on the document and hand the new colours to the scene. */
export function applyTheme(name: ThemeName): void {
  document.documentElement.dataset.theme = name;
  const colors = themeColors();
  for (const listener of [...listeners]) listener(colors);
}

/** The theme currently on the document. */
export function currentTheme(): ThemeName {
  const attr = document.documentElement.dataset.theme;
  return isThemeName(attr) ? attr : "drafting";
}

/** Read the active theme's colours out of the CSS variables. */
export function themeColors(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  const out = {} as Record<ColorKey, string>;
  for (const key of Object.keys(SOURCES) as ColorKey[]) {
    const [variable, fallback] = SOURCES[key];
    const value = style.getPropertyValue(variable).trim();
    out[key] = value === "" ? fallback : value;
  }
  const haloWidth = Number.parseFloat(style.getPropertyValue("--label-halo-width"));
  return { ...out, labelHaloWidth: Number.isFinite(haloWidth) ? haloWidth : 2 };
}

/** Be told when the theme changes. Returns the unsubscribe function. */
export function onThemeChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
