/**
 * Compilation both ways between a mission's flat `flow` and the list of stops
 * the Route panel edits.
 *
 * A stop is one `nav.follow_route` step plus the action steps that follow it
 * in the flow. Anything that does not fit that shape — steps before the first
 * stop, and control flow (`if`, `loop`, `break`) — becomes an "other" segment:
 * it is shown in the panel's "Other steps" list, never edited away and never
 * dropped. Because the flow is modelled as an ordered list of segments and the
 * original step objects are reused, reading and writing round-trips exactly:
 * step ids and unknown fields survive.
 */

import type { Mission, Path, Site, Step } from "./types";
import { DEFAULT_WAYPOINT_SPACING_M, STRICT_PATH_SPACING_M } from "./types";
import type { Edge } from "./types";
import { getList, walkSteps } from "./ids";
import { routeThroughGraph } from "./geometry";
import { hasExpression } from "./expressions";

export const STOP_TYPE = "nav.follow_route";

/** Step types that end a stop: their nested steps are not stop actions. */
const CONTROL_FLOW = new Set(["if", "loop", "break"]);

export interface Stop {
  /** The `nav.follow_route` step, reused as-is so its id and extra fields survive. */
  step: Step;
  /** Steps that follow it in the flat flow, in order. */
  actions: Step[];
}

export type FlowSegment = { kind: "stop"; stop: Stop } | { kind: "other"; step: Step; reason: string };

export interface FlowModel {
  segments: FlowSegment[];
  stops: Stop[];
  others: { step: Step; reason: string }[];
}

/** Split a mission's flow into stops and the steps that do not fit the pattern. */
export function readFlow(mission: Mission | null): FlowModel {
  const segments: FlowSegment[] = [];
  const flow = mission?.flow ?? [];
  let current: Stop | null = null;
  let seenStop = false;
  for (const step of flow) {
    const type = typeof step.type === "string" ? step.type : "";
    if (type === STOP_TYPE) {
      current = { step, actions: [] };
      seenStop = true;
      segments.push({ kind: "stop", stop: current });
      continue;
    }
    if (CONTROL_FLOW.has(type)) {
      current = null;
      segments.push({ kind: "other", step, reason: "control flow" });
      continue;
    }
    if (current) {
      current.actions.push(step);
      continue;
    }
    segments.push({ kind: "other", step, reason: seenStop ? "after control flow" : "before the first stop" });
  }
  const stops: Stop[] = [];
  const others: { step: Step; reason: string }[] = [];
  for (const s of segments) {
    if (s.kind === "stop") stops.push(s.stop);
    else others.push({ step: s.step, reason: s.reason });
  }
  // A mission with no stops at all has no "first stop" to be before.
  if (stops.length === 0) {
    for (const s of segments) if (s.kind === "other" && s.reason === "before the first stop") s.reason = "not part of a stop";
    for (const o of others) if (o.reason === "before the first stop") o.reason = "not part of a stop";
  }
  return { segments, stops, others };
}

/** Flatten segments back into a `flow`, in segment order. */
export function writeFlow(segments: readonly FlowSegment[]): Step[] {
  const flow: Step[] = [];
  for (const seg of segments) {
    if (seg.kind === "stop") {
      flow.push(seg.stop.step, ...seg.stop.actions);
    } else {
      flow.push(seg.step);
    }
  }
  return flow;
}

/** Write the segments into `mission.flow`, leaving everything else untouched. */
export function applyFlow(mission: Mission, segments: readonly FlowSegment[]): void {
  mission.flow = writeFlow(segments);
}

/**
 * Move the stop at `fromIndex` (counting stops only) to `toIndex`. Other
 * segments keep their absolute slot, so control flow does not travel with a
 * reordered stop.
 */
export function reorderStops(segments: FlowSegment[], fromIndex: number, toIndex: number): FlowSegment[] {
  const slots: number[] = [];
  segments.forEach((s, i) => {
    if (s.kind === "stop") slots.push(i);
  });
  if (fromIndex < 0 || fromIndex >= slots.length) return segments;
  const target = Math.max(0, Math.min(slots.length - 1, toIndex));
  const stops = slots.map((i) => (segments[i] as { kind: "stop"; stop: Stop }).stop);
  const [moved] = stops.splice(fromIndex, 1);
  if (!moved) return segments;
  stops.splice(target, 0, moved);
  const out = segments.slice();
  slots.forEach((slot, i) => {
    out[slot] = { kind: "stop", stop: stops[i]! };
  });
  return out;
}

export interface StopDestination {
  /** The site, when it can be known without running the mission. */
  site: string | null;
  /** The input or variable the destination comes from, when it is `$name`. */
  input: string | null;
  /** What the step actually says. */
  raw: string;
}

/**
 * Where a stop drives to. `to` is usually a site name; when it is `$name` the
 * declared default of that input (or variable) is used, which is what lets a
 * mission with parameterised stops still be drawn and edited on the map.
 */
export function stopDestination(stop: Stop, mission?: Mission | null): StopDestination {
  const to = typeof stop.step.to === "string" ? stop.step.to : "";
  if (to === "") return { site: null, input: null, raw: to };
  if (!hasExpression(to)) return { site: to, input: null, raw: to };
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(to);
  if (!m || !mission) return { site: null, input: null, raw: to };
  const name = m[1]!;
  const def = mission.inputs?.[name];
  const value = def ? def.default : mission.vars?.[name];
  return { site: typeof value === "string" && value !== "" ? value : null, input: name, raw: to };
}

/** The site a stop drives to, or null when it is only known at run time. */
export function stopSite(stop: Stop, mission?: Mission | null): string | null {
  return stopDestination(stop, mission).site;
}

/** Human label for a stop: its name, else its destination. */
export function stopLabel(stop: Stop): string {
  const name = stop.step.name;
  if (typeof name === "string" && name.trim() !== "") return name.trim();
  const to = stop.step.to;
  return typeof to === "string" && to !== "" ? to : "(no destination)";
}

export interface PlannedLeg {
  /**
   * Site names the robot passes, in order: from where it starts (when that is
   * known before running) through every `through` site to the destination.
   * A hop the graph cannot drive is kept as a straight hop and named in
   * `problem`.
   */
  route: string[];
  /** Index of the stop this leg arrives at. */
  stopIndex: number;
  /** A sentence when some hop has no route on the graph; "" when it drives. */
  problem: string;
  /** Where the chain starts: a site, or null when it is the point nearest the robot. */
  start: string | null;
  /** `on_no_route: direct`: a missing route is driven straight instead of failing. */
  direct: boolean;
  /** Length of the planned chain in metres. */
  lengthM: number;
}

/** Static site names of a `through` list; expressions are left out. */
export function throughSites(step: Step): string[] {
  const list = step.through;
  if (!Array.isArray(list)) return [];
  return list.filter((v): v is string => typeof v === "string" && v !== "" && !hasExpression(v));
}

/** Why the graph has no route from `a` to `b`, as a sentence. */
export function noRouteSentence(sites: Record<string, Site>, edges: readonly Edge[], a: string, b: string): string {
  if (routeThroughGraph(sites, edges, a, b, true)) return `There is no route from ${a} to ${b}: every way there uses a blocked lane.`;
  if (routeThroughGraph(sites, edges, b, a)) return `There is no route from ${a} to ${b}: the lanes between them are one-way, from ${b} to ${a}.`;
  if (!edges.some((e) => e.to === b || (e.from === b && e.bidirectional !== false))) return `There is no route from ${a} to ${b}: no lane leads to ${b}.`;
  return `There is no route from ${a} to ${b} along the lanes.`;
}

/**
 * The route the robot takes through the stops, leg by leg, along the lanes,
 * with mission_runner's rules: each Follow route starts at its `from`, else at
 * the destination of the Follow route before it, else at the point nearest the
 * robot (unknown here, so that first hop is decided on the robot); then it
 * passes every `through` site in order and ends at `to`, each hop planned on
 * the graph.
 */
export function planRoute(stops: readonly Stop[], sites: Record<string, Site>, edges: readonly Edge[], mission?: Mission | null, start?: string | null): PlannedLeg[] {
  const legs: PlannedLeg[] = [];
  let previous = start && sites[start] ? start : null;
  stops.forEach((stop, stopIndex) => {
    const step = stop.step;
    const direct = step.on_no_route === "direct";
    const to = stopSite(stop, mission);
    if (to === null) {
      previous = null;
      return;
    }
    const through = throughSites(step);
    const missing = [...through, to].filter((name) => !sites[name]);
    if (missing.length > 0) {
      const names = missing.join(", ");
      legs.push({ route: [], stopIndex, problem: `${names} ${missing.length === 1 ? "is not a point" : "are not points"} on this map.`, start: null, direct, lengthM: 0 });
      previous = null;
      return;
    }
    const from = typeof step.from === "string" && step.from !== "" && !hasExpression(step.from) && sites[step.from] ? step.from : previous;
    const waypoints = from !== null ? [from, ...through, to] : [...through, to];
    const route = [waypoints[0]!];
    let problem = "";
    for (let i = 1; i < waypoints.length; i++) {
      const a = waypoints[i - 1]!;
      const b = waypoints[i]!;
      if (a === b) continue;
      const hop = routeThroughGraph(sites, edges, a, b);
      if (hop) route.push(...hop.slice(1));
      else {
        route.push(b);
        if (problem === "") problem = noRouteSentence(sites, edges, a, b);
      }
    }
    let lengthM = 0;
    for (let i = 1; i < route.length; i++) {
      const p = sites[route[i - 1]!]!;
      const q = sites[route[i]!]!;
      lengthM += Math.hypot(q.x - p.x, q.y - p.y);
    }
    legs.push({ route, stopIndex, problem, start: from, direct, lengthM });
    previous = to;
  });
  return legs;
}

export interface Arrival {
  mission: string;
  /** The Follow route that arrives at the point. */
  step: Step;
  /** Path of that step in its mission. */
  path: Path;
  /** The steps after it in the same list, up to the next Follow route: what happens there. */
  actions: Step[];
}

/**
 * Where a mission arrives at a point, and what it does there. A mission is a
 * sequence, so "the actions at a point" are the steps that follow a Follow
 * route to that point in the same list, until the next Follow route.
 */
export function arrivalsAt(missions: readonly Mission[], site: string): Arrival[] {
  const out: Arrival[] = [];
  for (const mission of missions) {
    for (const visit of walkSteps(mission)) {
      if (visit.step.type !== STOP_TYPE || visit.step.to !== site) continue;
      const list = getList(mission, visit.path.slice(0, -1));
      const index = visit.path[visit.path.length - 1];
      const actions: Step[] = [];
      if (list && typeof index === "number") {
        for (let i = index + 1; i < list.length; i++) {
          const next = list[i]!;
          if (next.type === STOP_TYPE) break;
          actions.push(next);
        }
      }
      out.push({ mission: mission.name, step: visit.step, path: visit.path, actions });
    }
  }
  return out;
}

// ---- how a planned chain is driven ------------------------------------------------

export type RouteSegmentMode = "through_poses" | "follow_path" | "go_to_pose";

/** One Nav2 request of a Follow route, like the runner's result `segments`. */
export interface RouteSegment {
  mode: RouteSegmentMode;
  /** Sites along this part, first to last. */
  sites: string[];
  /** Poses sent: waypoints for through_poses / go_to_pose, path poses for follow_path. */
  poses: number;
  /** A lead-in to a strict lane's first point, only driven when the robot is not already there. */
  leadIn?: boolean;
}

/** The step's `waypoint_spacing_m`, or the default when it is absent or only known at run time. */
export function waypointSpacing(step: Step): number {
  const v = step.waypoint_spacing_m;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : DEFAULT_WAYPOINT_SPACING_M;
}

/** The lane the robot drives from `a` to `b`: the first open one allowing that direction. */
export function laneBetween(edges: readonly Edge[], a: string, b: string): Edge | null {
  for (const e of edges) {
    if (e.blocked === true) continue;
    if ((e.from === a && e.to === b) || (e.bidirectional !== false && e.from === b && e.to === a)) return e;
  }
  return null;
}

/** Path poses of one straight piece of a FollowPath path, like the runner's `path_from_points` (end point not counted). */
function pathSteps(lengthM: number): number {
  return Math.max(1, Math.trunc(lengthM / Math.max(0.005, STRICT_PATH_SPACING_M)));
}

/** Poses strictly between the two ends of a normal lane: at spacing, 2 x spacing, ... short of its end (0 = none). */
export function intermediatePoses(lengthM: number, spacing: number): number {
  if (spacing <= 0 || lengthM <= 0) return 0;
  let k = 1;
  while (k * spacing < lengthM - 1e-6) k++;
  return k - 1;
}

/**
 * How a chain of sites is driven, with the rules mission_runner follows:
 * consecutive normal lanes are one NavigateThroughPoses with a pose every
 * `spacing` metres along each lane (a single pose is a NavigateToPose), and
 * consecutive strict lanes are one FollowPath along the straight lines, with
 * poses every 0.05 m. A chain that starts with a strict lane first drives to
 * its first point with NavigateToPose when the robot is not already there
 * (more than 0.3 m away). With `splitBySpeed` (Apply lane speed limits, and
 * some lane on the route has a cap) runs are also split where the cap changes.
 */
export function routeSegments(route: readonly string[], sites: Record<string, Site>, edges: readonly Edge[], spacing: number, splitBySpeed = false): RouteSegment[] {
  if (route.length === 0) return [];
  if (route.length === 1) return [{ mode: "go_to_pose", sites: [route[0]!], poses: 1 }];
  const hops = route.slice(1).map((b, i) => ({ a: route[i]!, b, lane: laneBetween(edges, route[i]!, b) }));
  const split = splitBySpeed && hops.some((h) => typeof h.lane?.speed_mps === "number" && h.lane.speed_mps > 0);
  const runs: { strict: boolean; speed: number | null; sites: string[]; poses: number }[] = [];
  for (const { a, b, lane } of hops) {
    const strict = lane?.strict === true;
    const speed = split && typeof lane?.speed_mps === "number" && lane.speed_mps > 0 ? lane.speed_mps : null;
    const pa = sites[a];
    const pb = sites[b];
    const length = pa && pb ? Math.hypot(pb.x - pa.x, pb.y - pa.y) : 0;
    const poses = strict ? pathSteps(length) : intermediatePoses(length, spacing) + 1;
    const last = runs[runs.length - 1];
    if (last && last.strict === strict && last.speed === speed) {
      last.sites.push(b);
      last.poses += poses;
    } else {
      runs.push({ strict, speed, sites: [a, b], poses });
    }
  }
  const out: RouteSegment[] = [];
  runs.forEach((run, i) => {
    if (run.strict) {
      if (i === 0) out.push({ mode: "go_to_pose", sites: [run.sites[0]!], poses: 1, leadIn: true });
      // The path's last pose is the end point itself.
      out.push({ mode: "follow_path", sites: run.sites, poses: run.poses + 1 });
    } else {
      out.push({ mode: run.poses === 1 ? "go_to_pose" : "through_poses", sites: run.sites, poses: run.poses });
    }
  });
  return out;
}

/** The planned leg of one Follow route step of the open mission. */
export function planForStep(stepId: string, stops: readonly Stop[], sites: Record<string, Site>, edges: readonly Edge[], mission?: Mission | null): PlannedLeg | null {
  const index = stops.findIndex((s) => s.step.id === stepId);
  if (index < 0) return null;
  return planRoute(stops, sites, edges, mission).find((leg) => leg.stopIndex === index) ?? null;
}
