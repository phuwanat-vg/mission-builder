/**
 * Reading and writing project files.
 *
 * In the desktop app this is the first-party Tauri dialog and file-system
 * plugins; the capability in src-tauri only lets them touch `.mproj` files and
 * their `.mproj.autosave` siblings. In the browser dev build there is no file
 * system, so Open falls back to a file input, Save to a download, and the
 * autosave to localStorage. That keeps every flow testable without Tauri.
 */

import { isDesktop } from "../updater";
import { PROJECT_EXTENSION, baseName } from "./project";

export interface OpenedFile {
  /** Where it came from on disk, or null in the browser (no path is known there). */
  path: string | null;
  /** The file name, for sentences and the title bar. */
  name: string;
  text: string;
}

export interface Autosave {
  text: string;
  /** When it was written, when that is known. */
  at: Date | null;
}

const FILTERS = [{ name: "Mission Builder project", extensions: [PROJECT_EXTENSION] }];

/** True when real paths can be read and written (the desktop app). */
export function hasFileSystem(): boolean {
  return isDesktop();
}

/** Ask for a project file and read it. Null when the user cancels. */
export async function pickAndReadProject(): Promise<OpenedFile | null> {
  if (!isDesktop()) return await browserPickFile();
  const dialog = await import("@tauri-apps/plugin-dialog");
  const selected = await dialog.open({ multiple: false, directory: false, filters: FILTERS, title: "Open a project" });
  if (typeof selected !== "string") return null;
  return { path: selected, name: baseName(selected), text: await readProjectAt(selected) };
}

export async function readProjectAt(path: string): Promise<string> {
  const fs = await import("@tauri-apps/plugin-fs");
  return await fs.readTextFile(path);
}

export async function projectExists(path: string): Promise<boolean> {
  if (!isDesktop()) return false;
  const fs = await import("@tauri-apps/plugin-fs");
  return await fs.exists(path);
}

/** Ask where to save. Null when the user cancels. Always ends in `.mproj`. */
export async function pickSavePath(defaultName: string): Promise<string | null> {
  const dialog = await import("@tauri-apps/plugin-dialog");
  const chosen = await dialog.save({ defaultPath: defaultName, filters: FILTERS, title: "Save the project as" });
  if (typeof chosen !== "string" || chosen === "") return null;
  return chosen.toLowerCase().endsWith(`.${PROJECT_EXTENSION}`) ? chosen : `${chosen}.${PROJECT_EXTENSION}`;
}

export async function writeProjectAt(path: string, text: string): Promise<void> {
  const fs = await import("@tauri-apps/plugin-fs");
  await fs.writeTextFile(path, text);
}

/** The browser's Save: the project is handed over as a download. */
export function downloadProject(fileName: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---- autosave -------------------------------------------------------------

const BROWSER_AUTOSAVE_KEY = "missionbuilder.autosave";

interface BrowserAutosave {
  /** The path or file name the autosave belongs to ("" for an untitled project). */
  key: string;
  text: string;
  at: string;
}

function autosavePath(path: string): string {
  return `${path}.autosave`;
}

/**
 * The autosave next to a project, when there is one. `key` is the project's
 * path on the desktop; in the browser (and for a project never saved) the one
 * autosave lives in localStorage under whatever key it was written with.
 */
export async function readAutosave(key: string | null): Promise<Autosave | null> {
  if (isDesktop() && key) {
    const fs = await import("@tauri-apps/plugin-fs");
    const path = autosavePath(key);
    if (!(await fs.exists(path))) return null;
    const text = await fs.readTextFile(path);
    let at: Date | null = null;
    try {
      at = (await fs.stat(path)).mtime;
    } catch {
      at = null;
    }
    return { text, at };
  }
  const stored = readBrowserAutosave();
  if (!stored || stored.key !== (key ?? "")) return null;
  return { text: stored.text, at: new Date(stored.at) };
}

export async function writeAutosave(key: string | null, text: string): Promise<void> {
  if (isDesktop() && key) {
    const fs = await import("@tauri-apps/plugin-fs");
    await fs.writeTextFile(autosavePath(key), text);
    return;
  }
  try {
    const entry: BrowserAutosave = { key: key ?? "", text, at: new Date().toISOString() };
    localStorage.setItem(BROWSER_AUTOSAVE_KEY, JSON.stringify(entry));
  } catch {
    /* storage full or blocked: the autosave is a convenience */
  }
}

export async function clearAutosave(key: string | null): Promise<void> {
  if (isDesktop() && key) {
    const fs = await import("@tauri-apps/plugin-fs");
    const path = autosavePath(key);
    if (await fs.exists(path)) await fs.remove(path);
    return;
  }
  try {
    localStorage.removeItem(BROWSER_AUTOSAVE_KEY);
  } catch {
    /* nothing to clear */
  }
}

/** The browser autosave's key, so a restart knows which project it belongs to. */
export function browserAutosaveKey(): string | null {
  return readBrowserAutosave()?.key ?? null;
}

function readBrowserAutosave(): BrowserAutosave | null {
  try {
    const raw = localStorage.getItem(BROWSER_AUTOSAVE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BrowserAutosave>;
    if (typeof parsed.text !== "string" || typeof parsed.key !== "string") return null;
    return { key: parsed.key, text: parsed.text, at: typeof parsed.at === "string" ? parsed.at : new Date().toISOString() };
  } catch {
    return null;
  }
}

// ---- the browser's Open ---------------------------------------------------

function browserPickFile(): Promise<OpenedFile | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = `.${PROJECT_EXTENSION},.json,application/json`;
    input.style.display = "none";
    let settled = false;
    const finish = (value: OpenedFile | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      file.text().then(
        (text) => finish({ path: null, name: file.name, text }),
        () => finish(null),
      );
    });
    input.addEventListener("cancel", () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}
