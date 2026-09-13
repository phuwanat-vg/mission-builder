/**
 * Everything Mission Builder edits: the open project. That is the route graph
 * of every map (points and lanes), every mission, and the project's name and
 * settings, with one undo history across all of it.
 *
 * The project is the single source of truth while editing. Nothing here talks
 * to a robot or a file: the shell decides when the project is saved, deployed
 * or replaced by an import, and compares `contentKey()` with what it last saved
 * or deployed to know whether anything is unsaved.
 *
 * Undo is snapshot based (a project is a few tens of kilobytes); a drag calls
 * `beginEdit` once and `commit` once, so one drag is one undo entry.
 *
 * Ported from iViz's `src/mission/RouteStore.ts`. The graph half is unchanged;
 * the mission half edits whole `mission/1` documents as a tree, and now holds
 * every mission of the project instead of one fetched from the robot. Anything
 * the tree cannot express is left untouched in the JSON.
 */

import type { Edge, InitialPose, Interrupt, Mission, Path, Site, SiteKind, SitesDoc, Step, Trigger } from "./types";
import { SITES_SCHEMA_ID, isRecord } from "./types";
import { allStepIds, assignIds, cloneStepWithFreshIds, deepClone, ensureList, genId, getList, getStepAt, walkSteps } from "./ids";
import { round1, round3, uniqueSiteName } from "./geometry";
import type { Stop } from "./stops";
import { STOP_TYPE } from "./stops";
import type { ProjectDoc, ProjectMeta } from "../project/project";
import { DEFAULT_PROJECT_NAME, PROJECT_SCHEMA_ID } from "../project/project";

export type Selection =
  | { kind: "none" }
  | { kind: "point"; name: string }
  /** Several points, in the order they were picked (Ctrl-click). */
  | { kind: "points"; names: string[] }
  | { kind: "lane"; index: number }
  /** A node of the mission tree, addressed by the id `tree.ts` gives it. */
  | { kind: "node"; id: string };

export const NO_SELECTION: Selection = { kind: "none" };

interface Snapshot {
  sites: string;
  missions: string;
  meta: string;
  open: number;
  label: string;
}

type Listener = (reason: "data" | "selection") => void;

const MAX_HISTORY = 100;

function emptySitesDoc(): SitesDoc {
  return { schema: SITES_SCHEMA_ID, maps: {} };
}

export class RouteStore {
  #sites: SitesDoc = emptySitesDoc();
  #mapName = "";
  #missions: Mission[] = [];
  /** Index of the open mission in `#missions`, or -1. */
  #open = -1;
  #meta: ProjectMeta = { name: DEFAULT_PROJECT_NAME, settings: {} };
  #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];
  #pending: Snapshot | null = null;
  #selection: Selection = NO_SELECTION;
  #listeners = new Set<Listener>();
  /** Bumped whenever the graph or a mission changes, so the layer can rebuild. */
  version = 0;

  onChange(l: Listener): () => void {
    this.#listeners.add(l);
    return () => this.#listeners.delete(l);
  }

  // ---- documents ----------------------------------------------------------

  get sites(): SitesDoc {
    return this.#sites;
  }
  get mapName(): string {
    return this.#mapName;
  }
  get mapNames(): string[] {
    return Object.keys(this.#sites.maps ?? {});
  }
  get points(): Record<string, Site> {
    const map = this.#sites.maps?.[this.#mapName];
    if (!map) return {};
    if (!map.sites) map.sites = {};
    return map.sites;
  }
  get lanes(): Edge[] {
    const map = this.#sites.maps?.[this.#mapName];
    if (!map) return [];
    if (!map.edges) map.edges = [];
    return map.edges;
  }
  get frame(): string {
    return this.#sites.maps?.[this.#mapName]?.frame || "map";
  }
  /** The mission open in the tree, or null. */
  get mission(): Mission | null {
    return this.#missions[this.#open] ?? null;
  }
  /** Every mission of the project, in the order they are listed. */
  get missions(): readonly Mission[] {
    return this.#missions;
  }
  get missionNames(): string[] {
    return this.#missions.map((m) => m.name);
  }
  get meta(): ProjectMeta {
    return this.#meta;
  }
  get canUndo(): boolean {
    return this.#undo.length > 0;
  }
  get canRedo(): boolean {
    return this.#redo.length > 0;
  }
  get undoLabel(): string {
    return this.#undo[this.#undo.length - 1]?.label ?? "";
  }

  /**
   * Every `nav.follow_route` step of the open mission, in document order, as
   * the "stops" the map layer numbers and joins into a planned route. This
   * walks the whole tree, so a drive inside an `if` is drawn too.
   */
  get stops(): Stop[] {
    const out: Stop[] = [];
    const mission = this.mission;
    if (!mission) return out;
    for (const visit of walkSteps(mission)) {
      if (visit.step.type === STOP_TYPE) out.push({ step: visit.step, actions: [] });
    }
    return out;
  }

  // ---- the project --------------------------------------------------------

  /**
   * Replace everything with a project document (New, Open, a restored
   * autosave). Clears history and selection; no mission is open afterwards.
   * The document is taken over, not copied.
   */
  loadProject(doc: ProjectDoc): void {
    this.#sites = isRecord(doc.sites) ? doc.sites : emptySitesDoc();
    if (!isRecord(this.#sites.maps)) this.#sites.maps = {};
    this.#missions = Array.isArray(doc.missions) ? doc.missions : [];
    for (const m of this.#missions) assignIds(m);
    const meta: ProjectMeta = { name: doc.name, settings: isRecord(doc.settings) ? doc.settings : {} };
    if (typeof doc.description === "string") meta.description = doc.description;
    if (typeof doc.created_at === "string") meta.created_at = doc.created_at;
    this.#meta = meta;
    this.#open = -1;
    const names = this.mapNames;
    this.#mapName = (this.#sites.default_map && names.includes(this.#sites.default_map) ? this.#sites.default_map : names[0]) ?? "";
    this.#undo = [];
    this.#redo = [];
    this.#pending = null;
    this.#selection = NO_SELECTION;
    this.#emit("data");
  }

  /** The project as a document, deep-copied, ready to save or deploy. */
  toProjectDoc(updatedAt?: string): ProjectDoc {
    const sites = deepClone(this.#sites);
    sites.schema = SITES_SCHEMA_ID;
    // Keys in the contract's order, so saved files read the same way.
    return {
      schema: PROJECT_SCHEMA_ID,
      name: this.#meta.name,
      ...(this.#meta.description !== undefined ? { description: this.#meta.description } : {}),
      ...(this.#meta.created_at !== undefined ? { created_at: this.#meta.created_at } : {}),
      ...(updatedAt !== undefined ? { updated_at: updatedAt } : {}),
      settings: deepClone(this.#meta.settings),
      sites,
      missions: deepClone(this.#missions),
    };
  }

  /** Everything a Save writes except timestamps, as a comparable string. */
  contentKey(): string {
    return JSON.stringify([this.#meta.name, this.#meta.description ?? "", this.#meta.settings, this.#sites, this.#missions]);
  }

  /** What a Deploy sends to the robot (maps and missions), as a comparable string. */
  robotKey(): string {
    return JSON.stringify([this.#sites, this.#missions]);
  }

  /** Change the project's name, description or settings (undoable). */
  setMeta(patch: Partial<Omit<ProjectMeta, "settings">> & { settings?: ProjectMeta["settings"] }, label = "Change the project settings"): void {
    this.edit(label, () => {
      const next: ProjectMeta = { ...this.#meta, ...patch };
      if (patch.description !== undefined && patch.description.trim() === "") delete next.description;
      this.#meta = next;
    });
  }

  /**
   * Replace the maps and missions in one undoable step (Import from robot).
   * The open mission stays open when the new content still has it.
   */
  replaceContent(sites: SitesDoc, missions: Mission[], label: string): void {
    const openName = this.mission?.name ?? null;
    this.edit(label, () => {
      this.#sites = sites;
      if (!isRecord(this.#sites.maps)) this.#sites.maps = {};
      this.#missions = missions;
      for (const m of this.#missions) assignIds(m);
      this.#open = openName === null ? -1 : this.#missions.findIndex((m) => m.name === openName);
      if (!this.mapNames.includes(this.#mapName)) {
        const names = this.mapNames;
        this.#mapName = (this.#sites.default_map && names.includes(this.#sites.default_map) ? this.#sites.default_map : names[0]) ?? "";
      }
    });
    this.#clampSelection();
  }

  // ---- missions -----------------------------------------------------------

  /** Open a mission of the project in the tree. Not an edit: nothing to undo. */
  openMission(name: string | null): boolean {
    const index = name === null ? -1 : this.#missions.findIndex((m) => m.name === name);
    if (name !== null && index < 0) return false;
    if (index === this.#open) return true;
    this.#open = index;
    if (this.#selection.kind === "node") this.#selection = NO_SELECTION;
    this.#emit("data");
    return true;
  }

  /** Add a mission to the project and open it. Returns false when the name is taken. */
  addMission(mission: Mission, label = "Create a mission"): boolean {
    if (this.#missions.some((m) => m.name === mission.name)) return false;
    assignIds(mission);
    this.edit(label, () => {
      this.#missions.push(mission);
      this.#open = this.#missions.length - 1;
    });
    if (this.#selection.kind === "node") this.select(NO_SELECTION);
    return true;
  }

  removeMission(name: string): void {
    const index = this.#missions.findIndex((m) => m.name === name);
    if (index < 0) return;
    this.edit("Delete a mission", () => {
      const openName = this.mission?.name ?? null;
      this.#missions.splice(index, 1);
      this.#open = openName === null || openName === name ? -1 : this.#missions.findIndex((m) => m.name === openName);
    });
    if (this.#selection.kind === "node" && this.#open < 0) this.select(NO_SELECTION);
  }

  // ---- selection ----------------------------------------------------------

  get selection(): Selection {
    return this.#selection;
  }
  select(sel: Selection): void {
    const cur = this.#selection;
    if (sel.kind === cur.kind) {
      if (sel.kind === "none") return;
      if (sel.kind === "point" && cur.kind === "point" && sel.name === cur.name) return;
      if (sel.kind === "points" && cur.kind === "points" && sel.names.join(" ") === cur.names.join(" ")) return;
      if (sel.kind === "lane" && cur.kind === "lane" && sel.index === cur.index) return;
      if (sel.kind === "node" && cur.kind === "node" && sel.id === cur.id) return;
    }
    this.#selection = sel;
    this.#emit("selection");
  }

  /** Ctrl-click on a point: add it to the picked points, or take it out again. */
  togglePointInSelection(name: string): void {
    const cur = this.#selection;
    const names = cur.kind === "points" ? cur.names.slice() : cur.kind === "point" ? [cur.name] : [];
    const at = names.indexOf(name);
    if (at >= 0) names.splice(at, 1);
    else names.push(name);
    if (names.length === 0) this.select(NO_SELECTION);
    else if (names.length === 1) this.select({ kind: "point", name: names[0]! });
    else this.select({ kind: "points", names });
  }

  /** The points picked on the map, one or several, in picking order. */
  get selectedPoints(): string[] {
    const sel = this.#selection;
    if (sel.kind === "point") return [sel.name];
    if (sel.kind === "points") return sel.names.slice();
    return [];
  }

  // ---- history ------------------------------------------------------------

  #snapshot(label: string): Snapshot {
    return { sites: JSON.stringify(this.#sites), missions: JSON.stringify(this.#missions), meta: JSON.stringify(this.#meta), open: this.#open, label };
  }

  /** Take a snapshot before a change. Pair it with `commit` or `rollback`. */
  beginEdit(label: string): void {
    if (this.#pending) return;
    this.#pending = this.#snapshot(label);
  }

  get editing(): boolean {
    return this.#pending !== null;
  }

  /** Finish an edit: pushes the snapshot when something actually changed. */
  commit(): void {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending) return;
    const now = this.#snapshot(pending.label);
    if (now.sites === pending.sites && now.missions === pending.missions && now.meta === pending.meta) {
      if (now.open !== pending.open) this.#emit("data");
      return;
    }
    this.#undo.push(pending);
    if (this.#undo.length > MAX_HISTORY) this.#undo.shift();
    this.#redo = [];
    this.version++;
    this.#emit("data");
  }

  /** Abandon an edit in progress and restore the snapshot. */
  rollback(): void {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending) return;
    this.#restore(pending);
  }

  /** One edit in one call: `edit("Move point", () => { ... })`. */
  edit(label: string, fn: () => void): void {
    this.beginEdit(label);
    try {
      fn();
    } catch (err) {
      this.rollback();
      throw err;
    }
    this.commit();
  }

  undo(): boolean {
    const snap = this.#undo.pop();
    if (!snap) return false;
    this.#redo.push(this.#swap(snap));
    return true;
  }

  redo(): boolean {
    const snap = this.#redo.pop();
    if (!snap) return false;
    this.#undo.push(this.#swap(snap));
    return true;
  }

  /** Restore a snapshot, returning the state it replaced. */
  #swap(snap: Snapshot): Snapshot {
    const current = this.#snapshot(snap.label);
    this.#restore(snap);
    return current;
  }

  #restore(snap: Snapshot): void {
    this.#sites = JSON.parse(snap.sites) as SitesDoc;
    this.#missions = JSON.parse(snap.missions) as Mission[];
    this.#meta = JSON.parse(snap.meta) as ProjectMeta;
    this.#open = snap.open < this.#missions.length ? snap.open : -1;
    if (!this.mapNames.includes(this.#mapName)) this.#mapName = this.mapNames[0] ?? "";
    this.#clampSelection();
    this.version++;
    this.#emit("data");
  }

  #clampSelection(): void {
    const sel = this.#selection;
    if (sel.kind === "point" && !this.points[sel.name]) this.#selection = NO_SELECTION;
    else if (sel.kind === "points") {
      const names = sel.names.filter((n) => this.points[n]);
      this.#selection = names.length === 0 ? NO_SELECTION : names.length === 1 ? { kind: "point", name: names[0]! } : { kind: "points", names };
    } else if (sel.kind === "lane" && sel.index >= this.lanes.length) this.#selection = NO_SELECTION;
    else if (sel.kind === "node" && !this.mission) this.#selection = NO_SELECTION;
  }

  // ---- graph edits --------------------------------------------------------

  /** Create a point and select it. Returns its name. */
  addPoint(x: number, y: number, yawDeg: number | null, kind: SiteKind = "waypoint", baseName = "P"): string {
    const name = uniqueSiteName(this.points, baseName);
    this.edit("Add point", () => {
      const site: Site = { x: round3(x), y: round3(y), kind };
      if (yawDeg !== null) site.yaw_deg = round1(yawDeg);
      this.points[name] = site;
    });
    this.select({ kind: "point", name });
    return name;
  }

  /**
   * Create a point with a name chosen by the user (Add point by coordinates).
   * Returns false when that name is already a point of this map.
   */
  addNamedPoint(name: string, x: number, y: number, yawDeg: number | null, kind: SiteKind): boolean {
    const trimmed = name.trim();
    if (trimmed === "" || this.points[trimmed] || !this.#sites.maps[this.#mapName]) return false;
    this.edit(`Add ${trimmed}`, () => {
      const site: Site = { x: round3(x), y: round3(y), kind };
      if (yawDeg !== null) site.yaw_deg = round1(yawDeg);
      this.points[trimmed] = site;
    });
    this.select({ kind: "point", name: trimmed });
    return true;
  }

  movePoint(name: string, x: number, y: number): void {
    const site = this.points[name];
    if (!site) return;
    site.x = round3(x);
    site.y = round3(y);
  }

  setPointYaw(name: string, yawDeg: number | null): void {
    const site = this.points[name];
    if (!site) return;
    if (yawDeg === null) delete site.yaw_deg;
    else site.yaw_deg = round1(yawDeg);
  }

  setPointKind(name: string, kind: SiteKind): void {
    const site = this.points[name];
    if (!site) return;
    this.edit("Change point kind", () => {
      site.kind = kind;
    });
  }

  /** The point of the edited map the robot starts at (its initial pose), or null. */
  get initialPose(): InitialPose | null {
    const pose = this.#sites.maps?.[this.#mapName]?.initial_pose;
    return isRecord(pose) && typeof pose.site === "string" ? pose : null;
  }

  /**
   * Make a point of the edited map the start position, or clear it with null.
   * A map has one: the point it was on before stops being it. `on_start` is
   * kept when the start position moves. Returns the point it moved from.
   */
  setInitialPose(name: string | null): string | null {
    const map = this.#sites.maps[this.#mapName];
    if (!map) return null;
    const before = this.initialPose;
    if (name !== null && !this.points[name]) return null;
    if ((before?.site ?? null) === name) return null;
    this.edit(name === null ? "Clear the start position" : `Make ${name} the start position`, () => {
      if (name === null) {
        delete map.initial_pose;
        return;
      }
      const next: InitialPose = { site: name };
      if (before?.on_start === false) next.on_start = false;
      map.initial_pose = next;
    });
    return before && before.site !== name ? before.site : null;
  }

  /** Whether mission_runner sets the start position when it starts (absent = true). */
  setInitialPoseOnStart(onStart: boolean): void {
    const map = this.#sites.maps[this.#mapName];
    const pose = map?.initial_pose;
    if (!pose) return;
    this.edit(onStart ? "Set the start position when the robot starts" : "Do not set the start position when the robot starts", () => {
      if (onStart) delete pose.on_start;
      else pose.on_start = false;
    });
  }

  /** Set or clear (empty or undefined) a point's request or answer topic. */
  setPointTopics(name: string, patch: { request_topic?: string | undefined; answer_topic?: string | undefined }, label = "Change the point's topics"): void {
    const site = this.points[name];
    if (!site) return;
    this.edit(label, () => {
      for (const key of ["request_topic", "answer_topic"] as const) {
        if (!(key in patch)) continue;
        const v = patch[key]?.trim() ?? "";
        if (v === "") delete site[key];
        else site[key] = v;
      }
    });
  }

  /** Rename a point and every lane and step of every mission that referenced it. */
  renamePoint(from: string, to: string): string {
    const trimmed = to.trim();
    if (trimmed === "" || trimmed === from) return from;
    if (this.points[trimmed]) return from;
    this.edit("Rename point", () => {
      const site = this.points[from];
      if (!site) return;
      // Rebuild the record so the key order (and so the list order) is stable.
      const rebuilt: Record<string, Site> = {};
      for (const [k, v] of Object.entries(this.points)) rebuilt[k === from ? trimmed : k] = v;
      const map = this.#sites.maps[this.#mapName];
      if (map) map.sites = rebuilt;
      for (const lane of this.lanes) {
        if (lane.from === from) lane.from = trimmed;
        if (lane.to === from) lane.to = trimmed;
      }
      if (map?.initial_pose?.site === from) map.initial_pose.site = trimmed;
      for (const mission of this.#missions) renameInMission(mission, from, trimmed);
    });
    if (this.#selection.kind === "point" && this.#selection.name === from) this.select({ kind: "point", name: trimmed });
    return trimmed;
  }

  /** Lanes and steps (in any mission) that would break if `name` were removed. */
  referencesTo(name: string): string[] {
    const refs: string[] = [];
    for (const lane of this.lanes) {
      if (lane.from === name || lane.to === name) refs.push(`the lane ${lane.from} to ${lane.to}`);
    }
    for (const mission of this.#missions) {
      for (const visit of walkSteps(mission)) {
        const step = visit.step;
        const values: unknown[] = [step.to, step.from, step.pose, step.goal, step.start, step.dock_pose, step.station, ...(Array.isArray(step.through) ? step.through : [])];
        const hit = values.some((v) => v === name || (isRecord(v) && v.site === name));
        if (hit) refs.push(`the step '${typeof step.name === "string" && step.name !== "" ? step.name : String(step.id ?? step.type)}' of ${mission.name}`);
      }
    }
    return refs;
  }

  deletePoint(name: string): void {
    this.edit("Delete point", () => {
      delete this.points[name];
      const map = this.#sites.maps[this.#mapName];
      if (map?.edges) map.edges = map.edges.filter((e) => e.from !== name && e.to !== name);
      if (map?.initial_pose?.site === name) delete map.initial_pose;
    });
    this.#clampSelection();
    this.#emit("selection");
  }

  /** Add a lane, unless one already joins the two points. Returns its index. */
  addLane(from: string, to: string, oneWay: boolean): number {
    if (from === to || !this.points[from] || !this.points[to]) return -1;
    const existing = this.lanes.findIndex((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from));
    if (existing >= 0) return existing;
    let index = -1;
    this.edit("Add lane", () => {
      const lane: Edge = { from, to };
      if (oneWay) lane.bidirectional = false;
      this.lanes.push(lane);
      index = this.lanes.length - 1;
    });
    if (index >= 0) this.select({ kind: "lane", index });
    return index;
  }

  /**
   * Join points in the order given with two-way lanes, skipping pairs that a
   * lane already joins. One undo step. Returns how many lanes were added.
   */
  connectInOrder(names: readonly string[]): number {
    let added = 0;
    this.edit("Connect points in order", () => {
      for (let i = 1; i < names.length; i++) {
        const a = names[i - 1]!;
        const b = names[i]!;
        if (a === b || !this.points[a] || !this.points[b]) continue;
        if (this.lanes.some((e) => (e.from === a && e.to === b) || (e.from === b && e.to === a))) continue;
        this.lanes.push({ from: a, to: b });
        added++;
      }
    });
    return added;
  }

  updateLane(index: number, patch: Partial<Edge>, label = "Change lane"): void {
    const lane = this.lanes[index];
    if (!lane) return;
    this.edit(label, () => {
      for (const [k, v] of Object.entries(patch)) {
        if (v === undefined) delete (lane as unknown as Record<string, unknown>)[k];
        else (lane as unknown as Record<string, unknown>)[k] = v;
      }
    });
  }

  /** Swap the ends of a lane, which is how "one way B to A" is expressed. */
  flipLane(index: number): void {
    const lane = this.lanes[index];
    if (!lane) return;
    this.edit("Reverse lane", () => {
      const from = lane.from;
      lane.from = lane.to;
      lane.to = from;
    });
  }

  deleteLane(index: number): void {
    if (!this.lanes[index]) return;
    this.edit("Delete lane", () => {
      this.lanes.splice(index, 1);
    });
    this.select(NO_SELECTION);
  }

  /** Drop a new point onto a lane: the lane becomes two, meeting at the point. */
  splitLane(index: number, x: number, y: number, baseName = "P"): string | null {
    const lane = this.lanes[index];
    if (!lane) return null;
    const name = uniqueSiteName(this.points, baseName);
    this.edit("Split lane", () => {
      this.points[name] = { x: round3(x), y: round3(y), kind: "waypoint" };
      const rest: Edge = { ...lane, from: name, to: lane.to };
      lane.to = name;
      this.lanes.splice(index + 1, 0, rest);
    });
    this.select({ kind: "point", name });
    return name;
  }

  // ---- maps (sites) -------------------------------------------------------

  setMapName(name: string): void {
    if (name === this.#mapName) return;
    this.#mapName = name;
    const sel = this.#selection;
    if (sel.kind === "point" || sel.kind === "points" || sel.kind === "lane") this.#selection = NO_SELECTION;
    this.#emit("data");
  }

  addMap(name: string, file: string, frame = "map"): boolean {
    const trimmed = name.trim();
    if (trimmed === "" || this.#sites.maps[trimmed]) return false;
    this.edit("Register map", () => {
      const def: SitesDoc["maps"][string] = { frame, sites: {}, edges: [] };
      if (file.trim() !== "") def.file = file.trim();
      this.#sites.maps[trimmed] = def;
      if (!this.#sites.default_map) this.#sites.default_map = trimmed;
    });
    this.setMapName(trimmed);
    return true;
  }

  renameMap(from: string, to: string): boolean {
    const trimmed = to.trim();
    if (trimmed === "" || trimmed === from || this.#sites.maps[trimmed] || !this.#sites.maps[from]) return false;
    this.edit("Rename map", () => {
      const rebuilt: SitesDoc["maps"] = {};
      for (const [k, v] of Object.entries(this.#sites.maps)) rebuilt[k === from ? trimmed : k] = v;
      this.#sites.maps = rebuilt;
      if (this.#sites.default_map === from) this.#sites.default_map = trimmed;
    });
    if (this.#mapName === from) this.setMapName(trimmed);
    return true;
  }

  deleteMap(name: string): void {
    if (!this.#sites.maps[name]) return;
    this.edit("Delete map", () => {
      delete this.#sites.maps[name];
      if (this.#sites.default_map === name) this.#sites.default_map = Object.keys(this.#sites.maps)[0];
    });
    if (this.#mapName === name) this.setMapName(this.mapNames[0] ?? "");
  }

  setDefaultMap(name: string): void {
    if (!this.#sites.maps[name] || this.#sites.default_map === name) return;
    this.edit("Change the active map", () => {
      this.#sites.default_map = name;
    });
  }

  setMapFile(name: string, file: string): void {
    const map = this.#sites.maps[name];
    if (!map) return;
    this.edit("Change map file", () => {
      const trimmed = file.trim();
      if (trimmed === "") delete map.file;
      else map.file = trimmed;
    });
  }

  // ---- mission edits (the open mission) -----------------------------------

  /** Set (or clear, with `undefined`) a top-level field of the open mission. */
  setMissionField(key: string, value: unknown, label = "Edit mission"): void {
    const mission = this.mission;
    if (!mission) return;
    this.edit(label, () => {
      const doc = mission as unknown as Record<string, unknown>;
      if (value === undefined) delete doc[key];
      else doc[key] = value;
    });
  }

  /** Set one parameter of a step that is already in a mission. */
  setStepParam(step: Step, key: string, value: unknown, label = "Edit step"): void {
    this.edit(label, () => {
      if (value === undefined) delete step[key];
      else step[key] = value;
    });
  }

  /** A step id that is not taken in the open mission. */
  freshStepId(): string {
    const mission = this.mission;
    return genId("s", mission ? allStepIds(mission) : new Set<string>());
  }

  /**
   * Insert a step into the list at `listPath` of the open mission (creating
   * `else` and `before_retry` when they are missing). `index < 0` appends.
   */
  insertStep(listPath: Path, index: number, step: Step, label = "Add step"): Path | null {
    const mission = this.mission;
    if (!mission) return null;
    let at = -1;
    this.edit(label, () => {
      const list = ensureList(mission, listPath);
      if (!list) return;
      at = index < 0 || index > list.length ? list.length : index;
      list.splice(at, 0, step);
    });
    return at < 0 ? null : [...listPath, at];
  }

  removeStep(path: Path): void {
    const mission = this.mission;
    if (!mission || path.length === 0) return;
    this.edit("Delete step", () => {
      const list = getList(mission, path.slice(0, -1));
      const idx = path[path.length - 1];
      if (list && typeof idx === "number") list.splice(idx, 1);
    });
  }

  /** Copy a step (and everything under it) just after itself, with fresh ids. */
  duplicateStep(path: Path): Step | null {
    const mission = this.mission;
    if (!mission || path.length === 0) return null;
    const source = getStepAt(mission, path);
    if (!source) return null;
    let copy: Step | null = null;
    this.edit("Duplicate step", () => {
      const list = getList(mission, path.slice(0, -1));
      const idx = path[path.length - 1];
      if (!list || typeof idx !== "number") return;
      copy = cloneStepWithFreshIds(source, allStepIds(mission));
      list.splice(idx + 1, 0, copy);
    });
    return copy;
  }

  /**
   * Move a step one place up or down inside its own list, which is what
   * Alt+arrow does. Unlike `moveStep` the index is a destination, not a slot
   * in the list as it was before the removal.
   */
  nudgeStep(path: Path, delta: -1 | 1): boolean {
    const mission = this.mission;
    if (!mission || path.length === 0) return false;
    const list = getList(mission, path.slice(0, -1));
    const index = path[path.length - 1];
    if (!list || typeof index !== "number") return false;
    const target = index + delta;
    if (target < 0 || target >= list.length) return false;
    this.edit(delta < 0 ? "Move the step up" : "Move the step down", () => {
      const [moved] = list.splice(index, 1);
      if (moved) list.splice(target, 0, moved);
    });
    return true;
  }

  /** `enabled: false` skips the step; the field is removed when turning it on. */
  setStepEnabled(path: Path, enabled: boolean): void {
    const mission = this.mission;
    if (!mission) return;
    const step = getStepAt(mission, path);
    if (!step) return;
    this.edit(enabled ? "Turn the step on" : "Turn the step off", () => {
      if (enabled) delete step.enabled;
      else step.enabled = false;
    });
  }

  /**
   * Move a step to `toList` at `toIndex`. Moving inside one list accounts for
   * the hole the removal leaves, so dropping "after the next one" behaves.
   * Returns the path the step ended up at, or null when the move is illegal
   * (dropping a container inside its own subtree).
   */
  moveStep(fromPath: Path, toList: Path, toIndex: number): Path | null {
    const mission = this.mission;
    if (!mission || fromPath.length === 0) return null;
    if (toList.length >= fromPath.length && fromPath.every((seg, i) => toList[i] === seg)) return null;
    let result: Path | null = null;
    this.edit("Move step", () => {
      const srcList = getList(mission, fromPath.slice(0, -1));
      const srcIndex = fromPath[fromPath.length - 1];
      if (!srcList || typeof srcIndex !== "number") return;
      const dstList = ensureList(mission, toList);
      if (!dstList) return;
      const [moved] = srcList.splice(srcIndex, 1);
      if (!moved) return;
      let at = toIndex < 0 ? dstList.length : toIndex;
      if (srcList === dstList && srcIndex < at) at--;
      at = Math.max(0, Math.min(dstList.length, at));
      dstList.splice(at, 0, moved);
      result = [...toList, at];
    });
    return result;
  }

  // ---- triggers and interrupts --------------------------------------------

  addTrigger(kind: "triggers" | "interrupts", trigger: Trigger | Interrupt): number {
    const mission = this.mission;
    if (!mission) return -1;
    let index = -1;
    this.edit(kind === "triggers" ? "Add a trigger" : "Add an interrupt", () => {
      if (kind === "triggers") {
        const list = (mission.triggers ??= []);
        list.push(trigger as Trigger);
        index = list.length - 1;
      } else {
        const list = (mission.interrupts ??= []);
        list.push(trigger as Interrupt);
        index = list.length - 1;
      }
    });
    return index;
  }

  removeTrigger(kind: "triggers" | "interrupts", index: number): void {
    const mission = this.mission;
    if (!mission) return;
    this.edit(kind === "triggers" ? "Delete a trigger" : "Delete an interrupt", () => {
      const list: Trigger[] | undefined = kind === "triggers" ? mission.triggers : mission.interrupts;
      if (Array.isArray(list)) list.splice(index, 1);
    });
  }

  setTriggerParam(kind: "triggers" | "interrupts", index: number, key: string, value: unknown): void {
    const mission = this.mission;
    if (!mission) return;
    const list: Trigger[] | undefined = kind === "triggers" ? mission.triggers : mission.interrupts;
    const item = list?.[index];
    if (!item) return;
    this.edit("Edit a trigger", () => {
      const rec = item as unknown as Record<string, unknown>;
      if (value === undefined) delete rec[key];
      else rec[key] = value;
    });
  }

  // ---- misc ---------------------------------------------------------------

  /** A deep copy of the open mission, for validation and export. */
  missionCopy(): Mission | null {
    const mission = this.mission;
    return mission ? deepClone(mission) : null;
  }

  sitesCopy(): SitesDoc {
    return deepClone(this.#sites);
  }

  #emit(reason: "data" | "selection"): void {
    if (reason === "data") this.version++;
    for (const l of this.#listeners) l(reason);
  }
}

/** Rewrite only the places of a mission that name a site, never free text. */
function renameInMission(mission: Mission, from: string, to: string): void {
  const swapPose = (value: unknown): unknown => {
    if (value === from) return to;
    if (Array.isArray(value)) return value.map(swapPose);
    if (isRecord(value) && value.site === from) return { ...value, site: to };
    return value;
  };
  for (const visit of walkSteps(mission)) {
    const step = visit.step;
    if (step.type === "nav.follow_route") {
      if (step.to === from) step.to = to;
      if (step.from === from) step.from = to;
      if (Array.isArray(step.through)) step.through = step.through.map((v) => (v === from ? to : v));
      continue;
    }
    if (step.type === "ros.request" && step.station === from) step.station = to;
    for (const key of ["pose", "goal", "start", "dock_pose"]) {
      if (step[key] !== undefined) step[key] = swapPose(step[key]);
    }
    for (const key of ["poses", "points", "goals"]) {
      const list = step[key];
      if (Array.isArray(list)) step[key] = list.map(swapPose);
    }
  }
}
