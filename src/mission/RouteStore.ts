/**
 * Everything Mission Builder edits: the route graph (a map's sites and lanes)
 * and the open mission document, with undo/redo and unsaved-change tracking.
 *
 * The graph belongs to the map, not to a mission: it is saved with
 * `PUT /api/sites` and shared by every mission. A mission is saved separately
 * with `PUT /api/missions/{name}`, so the two dirty flags are independent.
 *
 * Undo is snapshot based (the documents are a few kilobytes); a drag calls
 * `beginEdit` once and `commit` once, so one drag is one undo entry.
 *
 * Ported from iViz's `src/mission/RouteStore.ts`. The graph half is unchanged;
 * the mission half was replaced, because Mission Builder edits the whole
 * `mission/1` document as a tree instead of the flat list of stops Route mode
 * showed. Anything the tree cannot express is left untouched in the JSON.
 */

import type { Edge, Interrupt, Mission, Path, Site, SiteKind, SitesDoc, Step, Trigger } from "./types";
import { SITES_SCHEMA_ID, isRecord } from "./types";
import { allStepIds, assignIds, cloneStepWithFreshIds, deepClone, ensureList, genId, getList, getStepAt, walkSteps } from "./ids";
import { round1, round3, uniqueSiteName } from "./geometry";
import type { Stop } from "./stops";
import { STOP_TYPE } from "./stops";

export type Selection =
  | { kind: "none" }
  | { kind: "point"; name: string }
  | { kind: "lane"; index: number }
  /** A node of the mission tree, addressed by the id `tree.ts` gives it. */
  | { kind: "node"; id: string };

export const NO_SELECTION: Selection = { kind: "none" };

interface Snapshot {
  sites: string;
  mission: string | null;
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
  #mission: Mission | null = null;
  #sitesDirty = false;
  #missionDirty = false;
  #undo: Snapshot[] = [];
  #redo: Snapshot[] = [];
  #pending: Snapshot | null = null;
  #selection: Selection = NO_SELECTION;
  #listeners = new Set<Listener>();
  /** Bumped whenever the graph or the mission changes, so the layer can rebuild. */
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
  get mission(): Mission | null {
    return this.#mission;
  }
  get sitesDirty(): boolean {
    return this.#sitesDirty;
  }
  get missionDirty(): boolean {
    return this.#missionDirty;
  }
  get dirty(): boolean {
    return this.#sitesDirty || this.#missionDirty;
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
   * Every `nav.follow_route` step of the mission, in document order, as the
   * "stops" the map layer numbers and joins into a planned route. Unlike Route
   * mode this walks the whole tree, so a drive inside an `if` is drawn too.
   */
  get stops(): Stop[] {
    const out: Stop[] = [];
    if (!this.#mission) return out;
    for (const visit of walkSteps(this.#mission)) {
      if (visit.step.type === STOP_TYPE) out.push({ step: visit.step, actions: [] });
    }
    return out;
  }

  /** Load a freshly fetched sites document; clears history and dirty state. */
  setSites(doc: SitesDoc, keepMap = true): void {
    this.#sites = doc && typeof doc === "object" ? doc : emptySitesDoc();
    if (!this.#sites.maps) this.#sites.maps = {};
    const names = Object.keys(this.#sites.maps);
    if (!keepMap || !this.#mapName || !names.includes(this.#mapName)) {
      this.#mapName = (this.#sites.default_map && names.includes(this.#sites.default_map) ? this.#sites.default_map : names[0]) ?? "";
    }
    this.#sitesDirty = false;
    this.#undo = [];
    this.#redo = [];
    this.#selection = NO_SELECTION;
    this.#emit("data");
  }

  setMapName(name: string): void {
    if (name === this.#mapName) return;
    this.#mapName = name;
    if (this.#selection.kind === "point" || this.#selection.kind === "lane") this.#selection = NO_SELECTION;
    this.#emit("data");
  }

  /**
   * Load a mission (or none); clears the mission dirty flag and history.
   *
   * Every step is given an id here if it lacks one — the format says the
   * editor generates them, and the tree keys its expanded set and its
   * selection on them, so they have to exist before anything is drawn.
   * Existing ids are never changed, so the document still round-trips.
   */
  setMission(mission: Mission | null): void {
    if (mission) assignIds(mission);
    this.#mission = mission;
    this.#missionDirty = false;
    this.#undo = [];
    this.#redo = [];
    if (this.#selection.kind === "node") this.#selection = NO_SELECTION;
    this.#emit("data");
  }

  markSitesSaved(): void {
    this.#sitesDirty = false;
    this.#emit("data");
  }
  markMissionSaved(): void {
    this.#missionDirty = false;
    this.#emit("data");
  }

  // ---- selection ----------------------------------------------------------

  get selection(): Selection {
    return this.#selection;
  }
  select(sel: Selection): void {
    if (sel.kind === this.#selection.kind) {
      if (sel.kind === "none") return;
      if (sel.kind === "point" && this.#selection.kind === "point" && sel.name === this.#selection.name) return;
      if (sel.kind === "lane" && this.#selection.kind === "lane" && sel.index === this.#selection.index) return;
      if (sel.kind === "node" && this.#selection.kind === "node" && sel.id === this.#selection.id) return;
    }
    this.#selection = sel;
    this.#emit("selection");
  }

  // ---- history ------------------------------------------------------------

  /** Take a snapshot before a change. Pair it with `commit` or `rollback`. */
  beginEdit(label: string): void {
    if (this.#pending) return;
    this.#pending = { sites: JSON.stringify(this.#sites), mission: this.#mission ? JSON.stringify(this.#mission) : null, label };
  }

  /** Finish an edit: pushes the snapshot when something actually changed. */
  commit(opts: { sites?: boolean; mission?: boolean } = {}): void {
    const pending = this.#pending;
    this.#pending = null;
    if (!pending) return;
    const sitesNow = JSON.stringify(this.#sites);
    const missionNow = this.#mission ? JSON.stringify(this.#mission) : null;
    if (sitesNow === pending.sites && missionNow === pending.mission) return;
    this.#undo.push(pending);
    if (this.#undo.length > MAX_HISTORY) this.#undo.shift();
    this.#redo = [];
    if (opts.sites !== false && sitesNow !== pending.sites) this.#sitesDirty = true;
    if (opts.mission !== false && missionNow !== pending.mission) this.#missionDirty = true;
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
  edit(label: string, fn: () => void, opts: { sites?: boolean; mission?: boolean } = {}): void {
    this.beginEdit(label);
    try {
      fn();
    } catch (err) {
      this.rollback();
      throw err;
    }
    this.commit(opts);
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

  /**
   * Restore a snapshot, returning the state it replaced. Only the half that
   * actually changed becomes dirty, so undoing a map edit does not pretend the
   * mission needs deploying.
   */
  #swap(snap: Snapshot): Snapshot {
    const current: Snapshot = { sites: JSON.stringify(this.#sites), mission: this.#mission ? JSON.stringify(this.#mission) : null, label: snap.label };
    this.#restore(snap);
    if (current.sites !== snap.sites) this.#sitesDirty = true;
    if (current.mission !== snap.mission) this.#missionDirty = true;
    return current;
  }

  #restore(snap: Snapshot): void {
    this.#sites = JSON.parse(snap.sites) as SitesDoc;
    this.#mission = snap.mission === null ? null : (JSON.parse(snap.mission) as Mission);
    if (!this.mapNames.includes(this.#mapName)) this.#mapName = this.mapNames[0] ?? "";
    this.#clampSelection();
    this.version++;
    this.#emit("data");
  }

  #clampSelection(): void {
    const sel = this.#selection;
    if (sel.kind === "point" && !this.points[sel.name]) this.#selection = NO_SELECTION;
    else if (sel.kind === "lane" && sel.index >= this.lanes.length) this.#selection = NO_SELECTION;
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

  /** Rename a point and every lane and pose that referenced it. */
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
      this.#renameInMission(from, trimmed);
    });
    if (this.#selection.kind === "point" && this.#selection.name === from) this.select({ kind: "point", name: trimmed });
    return trimmed;
  }

  /** Rewrite only the places that name a site, never free text. */
  #renameInMission(from: string, to: string): void {
    if (!this.#mission) return;
    const swapPose = (value: unknown): unknown => {
      if (value === from) return to;
      if (Array.isArray(value)) return value.map(swapPose);
      if (isRecord(value) && value.site === from) return { ...value, site: to };
      return value;
    };
    for (const visit of walkSteps(this.#mission)) {
      const step = visit.step;
      if (step.type === "nav.follow_route") {
        if (step.to === from) step.to = to;
        if (step.from === from) step.from = to;
        continue;
      }
      for (const key of ["pose", "goal", "start", "dock_pose"]) {
        if (step[key] !== undefined) step[key] = swapPose(step[key]);
      }
      for (const key of ["poses", "points", "goals"]) {
        const list = step[key];
        if (Array.isArray(list)) step[key] = list.map(swapPose);
      }
    }
  }

  /** Lanes and steps that would break if `name` were removed. */
  referencesTo(name: string): string[] {
    const refs: string[] = [];
    for (const lane of this.lanes) {
      if (lane.from === name || lane.to === name) refs.push(`the lane ${lane.from} to ${lane.to}`);
    }
    if (this.#mission) {
      for (const visit of walkSteps(this.#mission)) {
        const step = visit.step;
        const values: unknown[] = [step.to, step.from, step.pose, step.goal, step.start, step.dock_pose];
        const hit = values.some((v) => v === name || (isRecord(v) && v.site === name));
        if (hit) refs.push(`the step '${typeof step.name === "string" && step.name !== "" ? step.name : String(step.id ?? step.type)}'`);
      }
    }
    return refs;
  }

  deletePoint(name: string): void {
    this.edit("Delete point", () => {
      delete this.points[name];
      const map = this.#sites.maps[this.#mapName];
      if (map?.edges) map.edges = map.edges.filter((e) => e.from !== name && e.to !== name);
    });
    if (this.#selection.kind === "point" && this.#selection.name === name) this.select(NO_SELECTION);
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

  // ---- maps (sites.json) --------------------------------------------------

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

  // ---- mission edits ------------------------------------------------------

  /** Set (or clear, with `undefined`) a top-level field of the mission. */
  setMissionField(key: string, value: unknown, label = "Edit mission"): void {
    const mission = this.#mission;
    if (!mission) return;
    this.edit(label, () => {
      const doc = mission as unknown as Record<string, unknown>;
      if (value === undefined) delete doc[key];
      else doc[key] = value;
    });
  }

  /** Set one parameter of a step that is already in the mission. */
  setStepParam(step: Step, key: string, value: unknown, label = "Edit step"): void {
    this.edit(label, () => {
      if (value === undefined) delete step[key];
      else step[key] = value;
    });
  }

  /** A step id that is not taken in this mission. */
  freshStepId(): string {
    return genId("s", this.#mission ? allStepIds(this.#mission) : new Set<string>());
  }

  /**
   * Insert a step into the list at `listPath` (creating `else` and
   * `before_retry` when they are missing). `index < 0` appends.
   */
  insertStep(listPath: Path, index: number, step: Step, label = "Add step"): Path | null {
    const mission = this.#mission;
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
    const mission = this.#mission;
    if (!mission || path.length === 0) return;
    this.edit("Delete step", () => {
      const list = getList(mission, path.slice(0, -1));
      const idx = path[path.length - 1];
      if (list && typeof idx === "number") list.splice(idx, 1);
    });
  }

  /** Copy a step (and everything under it) just after itself, with fresh ids. */
  duplicateStep(path: Path): Step | null {
    const mission = this.#mission;
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
    const mission = this.#mission;
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
    const mission = this.#mission;
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
    const mission = this.#mission;
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
    const mission = this.#mission;
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
    const mission = this.#mission;
    if (!mission) return;
    this.edit(kind === "triggers" ? "Delete a trigger" : "Delete an interrupt", () => {
      const list: Trigger[] | undefined = kind === "triggers" ? mission.triggers : mission.interrupts;
      if (Array.isArray(list)) list.splice(index, 1);
    });
  }

  setTriggerParam(kind: "triggers" | "interrupts", index: number, key: string, value: unknown): void {
    const mission = this.#mission;
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

  /** A deep copy of the mission, for validation and deployment. */
  missionCopy(): Mission | null {
    return this.#mission ? deepClone(this.#mission) : null;
  }

  sitesCopy(): SitesDoc {
    return deepClone(this.#sites);
  }

  #emit(reason: "data" | "selection"): void {
    if (reason === "data") this.version++;
    for (const l of this.#listeners) l(reason);
  }
}
