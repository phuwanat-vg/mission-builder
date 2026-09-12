/** What Mission Builder remembers between sessions, in localStorage. */

import { isThemeName } from "../ui/theme";
import type { ThemeName } from "../ui/theme";

const KEY = "missionbuilder.settings";

export interface AppSettings {
  url: string;
  autoConnect: boolean;
  /** The mission that was open, reopened on the next launch. */
  lastMission: string;
  treeCollapsed: boolean;
  activityOpen: boolean;
  /** Which half of the right column was showing: the selection or the maps. */
  rightTab: "selection" | "maps";
  /** Drafting (light) or Dark. */
  theme: ThemeName;
  /** The project file that was open, reopened on the next launch (desktop only). */
  lastProjectPath: string;
  /** Recently opened or saved project files, newest first (desktop only). */
  recentProjects: string[];
}

export const MAX_RECENT_PROJECTS = 8;

export const DEFAULT_SETTINGS: AppSettings = {
  url: "ws://localhost:8765",
  autoConnect: false,
  lastMission: "",
  treeCollapsed: false,
  activityOpen: false,
  rightTab: "selection",
  theme: "drafting",
  lastProjectPath: "",
  recentProjects: [],
};

/** Put a path at the top of the recent list, without duplicates. */
export function rememberRecent(settings: AppSettings, path: string): void {
  const same = (a: string): boolean => a.toLowerCase() === path.toLowerCase();
  settings.recentProjects = [path, ...settings.recentProjects.filter((p) => !same(p))].slice(0, MAX_RECENT_PROJECTS);
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const merged = { ...DEFAULT_SETTINGS, ...parsed };
    // A settings file written by an older version has no theme, or a name this
    // version no longer knows.
    if (!isThemeName(merged.theme)) merged.theme = DEFAULT_SETTINGS.theme;
    if (typeof merged.lastProjectPath !== "string") merged.lastProjectPath = "";
    if (!Array.isArray(merged.recentProjects)) merged.recentProjects = [];
    merged.recentProjects = merged.recentProjects.filter((p): p is string => typeof p === "string" && p !== "");
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* private mode: the app just forgets between sessions */
  }
}
