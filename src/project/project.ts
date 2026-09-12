/**
 * The project file: everything set up for one deployment in one JSON document
 * (`project/1`, saved as `.mproj`). It holds the maps with their points and
 * lanes (a `sites/1` document), every mission (`mission/1` documents) and the
 * project settings, and it opens and saves with no robot connected.
 *
 * The machine-readable contract is
 * Mission/runner/mission_runner/schema/project.schema.json; the same document
 * is what `PUT /api/project` takes and `GET /api/project` returns, and what
 * `mission_runner project import` reads on the robot.
 */

import type { Mission, SitesDoc } from "../mission/types";
import { DEFAULT_ANSWER_TOPIC, DEFAULT_REQUEST_TOPIC, MISSION_SCHEMA_ID, SITES_SCHEMA_ID, isRecord } from "../mission/types";

export const PROJECT_SCHEMA_ID = "project/1" as const;
export const PROJECT_EXTENSION = "mproj";
export const DEFAULT_PROJECT_NAME = "Untitled project";
/** The map a new project starts with. */
export const FIRST_MAP_NAME = "map";

export interface ProjectSettings {
  robot_url?: string;
  request_topic?: string;
  answer_topic?: string;
  /** The schema allows anything else; it is kept as it was. */
  [key: string]: unknown;
}

/** Everything about a project that is not its maps or its missions. */
export interface ProjectMeta {
  name: string;
  description?: string;
  created_at?: string;
  settings: ProjectSettings;
}

export interface ProjectDoc {
  schema: typeof PROJECT_SCHEMA_ID;
  name: string;
  description?: string;
  created_at?: string;
  updated_at?: string;
  settings?: ProjectSettings;
  sites: SitesDoc;
  missions: Mission[];
}

/** Local time with its offset, the way the contract's examples write it. */
export function nowIso(date = new Date()): string {
  const pad = (n: number): string => String(Math.trunc(Math.abs(n))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
  );
}

/** A new project: one empty map, no missions, the default request topics. */
export function newProjectDoc(name = DEFAULT_PROJECT_NAME): ProjectDoc {
  const now = nowIso();
  return {
    schema: PROJECT_SCHEMA_ID,
    name,
    created_at: now,
    updated_at: now,
    settings: { request_topic: DEFAULT_REQUEST_TOPIC, answer_topic: DEFAULT_ANSWER_TOPIC },
    sites: { schema: SITES_SCHEMA_ID, default_map: FIRST_MAP_NAME, maps: { [FIRST_MAP_NAME]: { frame: "map", sites: {}, edges: [] } } },
    missions: [],
  };
}

export type ParseResult = { ok: true; doc: ProjectDoc; notes: string[] } | { ok: false; error: string };

/**
 * Read a project file, saying in a sentence what is wrong when it is not one.
 * Only the shape the application depends on is checked here; each mission is
 * validated like any other once it is open.
 */
export function parseProject(text: string, fileName = "The file"): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: `${fileName} is not a project: it is not valid JSON.` };
  }
  if (!isRecord(raw)) return { ok: false, error: `${fileName} is not a project: it does not hold a JSON object.` };
  if (raw.schema !== PROJECT_SCHEMA_ID) {
    if (raw.schema === MISSION_SCHEMA_ID) return { ok: false, error: `${fileName} is a single mission, not a project. Create a project and add the mission to it instead.` };
    if (raw.schema === SITES_SCHEMA_ID) return { ok: false, error: `${fileName} is a sites.json, not a project.` };
    return { ok: false, error: `${fileName} is not a project: its schema is ${JSON.stringify(raw.schema ?? null)} instead of "project/1".` };
  }
  const notes: string[] = [];
  const sites = raw.sites;
  if (!isRecord(sites) || sites.schema !== SITES_SCHEMA_ID) return { ok: false, error: `${fileName} has no sites/1 document in "sites", so its maps cannot be read.` };
  if (!isRecord(sites.maps)) sites.maps = {};
  if (!Array.isArray(raw.missions)) return { ok: false, error: `${fileName} has no list of missions.` };
  const names = new Set<string>();
  for (const [i, m] of raw.missions.entries()) {
    if (!isRecord(m) || m.schema !== MISSION_SCHEMA_ID || typeof m.name !== "string") {
      return { ok: false, error: `Mission ${i + 1} in ${fileName} is not a mission/1 document with a name.` };
    }
    if (names.has(m.name)) return { ok: false, error: `${fileName} holds two missions called ${m.name}; mission names have to be unique.` };
    names.add(m.name);
    if (!Array.isArray(m.flow)) m.flow = [];
  }
  let name = typeof raw.name === "string" ? raw.name.trim() : "";
  if (name === "") {
    name = DEFAULT_PROJECT_NAME;
    notes.push(`The project had no name, so it is called ${name} for now.`);
  }
  const doc: ProjectDoc = {
    schema: PROJECT_SCHEMA_ID,
    name,
    sites: sites as unknown as SitesDoc,
    missions: raw.missions as Mission[],
  };
  if (typeof raw.description === "string") doc.description = raw.description;
  if (typeof raw.created_at === "string") doc.created_at = raw.created_at;
  if (typeof raw.updated_at === "string") doc.updated_at = raw.updated_at;
  doc.settings = isRecord(raw.settings) ? (raw.settings as ProjectSettings) : {};
  return { ok: true, doc, notes };
}

/** The file's text: two-space JSON with a trailing newline, so diffs stay small. */
export function serializeProject(doc: ProjectDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

/** A file name for a project: its name with the characters Windows refuses taken out. */
export function projectFileName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*]+/g, " ").replace(/\s+/g, " ").trim();
  return `${cleaned === "" ? "project" : cleaned}.${PROJECT_EXTENSION}`;
}

/** The last part of a path, on either kind of separator. */
export function baseName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}
