/**
 * Draws the route graph and the open mission in the scene, in the map frame.
 *
 * The drawing rules are a draughtsman's, not a telemetry display's. There are
 * two line weights and no others: a lane is a hairline, the open mission's
 * route is the emphasis weight. Colour carries meaning and nothing else —
 * lanes are muted, the route is the accent, a blocked lane is dashed in the
 * error colour, run status is ok / warn / err. A point is a small open circle,
 * a thin ring on the surface colour, with its kind shown by a tiny outline
 * glyph beside the name rather than by a fill. Headings are a short tick and
 * lane directions small open chevrons. Labels are plain text with a halo, no
 * chip behind them.
 *
 * Every colour comes from the theme's CSS variables through `ui/theme.ts`, so
 * the same code draws both themes; `setThemeColors` rebuilds on a switch.
 *
 * Geometry is rebuilt only when the data changes (the store's `version`) or
 * the zoom has moved far enough to matter, because everything is sized in
 * screen pixels and so depends on the metres-per-pixel of the camera. Hover,
 * selection and run state only mutate materials and one small highlight mesh,
 * so dragging a point across a large graph stays cheap.
 *
 * Text keeps a constant size on screen: labels are sprites scaled every frame
 * from the metres-per-pixel of the active camera, and labels that would
 * collide at the current zoom are hidden, least important first.
 */

import {
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  CircleGeometry,
  Color,
  Group,
  LinearFilter,
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Sprite,
  SpriteMaterial,
  Vector2,
  Vector3,
} from "three";
import { Layer, disposeObject } from "./Layer";
import type { LayerContext, SettingsSchema } from "./Layer";
import type { Viewer } from "../Viewer";
import type { RouteStore } from "../../mission/RouteStore";
import type { Edge, Site, SiteKind } from "../../mission/types";
import { pointOnSegment } from "../../mission/geometry";
import { planRoute, stopSite } from "../../mission/stops";
import { themeColors } from "../../ui/theme";
import type { ThemeColors } from "../../ui/theme";

/** What a point or lane was hit by a click. */
export type RouteHit = { kind: "point"; name: string } | { kind: "lane"; index: number; x: number; y: number } | null;

export interface RouteRunState {
  /** Stop the robot is driving to or working at. */
  activeStop: number | null;
  /** Stops that finished successfully. */
  doneStops: ReadonlySet<number>;
  /** Stop that failed, if any. */
  failedStop: number | null;
}

export const EMPTY_RUN_STATE: RouteRunState = { activeStop: null, doneStops: new Set(), failedStop: null };

// ---- the two line weights, and everything else in screen pixels -------------

/** A lane: the hairline. */
const LANE_PX = 1.25;
/** The open mission's route: the emphasis weight. Nothing else is a ribbon. */
const ROUTE_PX = 2.5;
/** The soft band marking the hovered or selected lane, under the lane itself. */
const HIGHLIGHT_PX = 7;
const DASH_PX = 9;
const DASH_GAP_PX = 6;
const CHEVRON_PX = 5;
const CHEVRON_STROKE_PX = 1.25;

/** A point: a small open circle. */
const POINT_PX = 7;
const POINT_RING_PX = 1.25;
const SELECT_RING_PX = 1.25;
const SELECT_RING_RADIUS_PX = 10.5;
const SELECT_DOT_PX = 3;
/** Where a point's heading tick ends — and so where it is grabbed to turn it. */
export const HEADING_TIP_PX = 15;
const HEADING_BASE_PX = 9.5;
const HEADING_STROKE_PX = 1.25;

const LABEL_PX = 11;
const BADGE_PX = 10;

// Picking is deliberately more generous than the drawing: a point is a click
// target first and a dot second, and these two numbers are the ones the Select
// tool has always used.
const DISC_RADIUS = 0.16;
const MIN_DISC_PX = 11;

// Widths are metres, so the geometry is rebuilt when the zoom moves far enough
// for a screen-pixel width to drift.
const ZOOM_REBUILD_RATIO = 1.15;

const Z_LANE = 0.01;
const Z_ROUTE = 0.02;
const Z_HIGHLIGHT = 0.005;
const Z_HALO = 0.028;
const Z_DISC = 0.03;
const Z_ARROW = 0.035;
const Z_LABEL = 0.06;

const _screen = new Vector2();
const _world = new Vector3();

interface PointVisual {
  group: Group;
  /** The circle's fill: the surface colour, so the floor plan does not show through. */
  fill: Mesh<CircleGeometry, MeshBasicMaterial>;
  /** The thin ring that is the point. Run status colours this. */
  ring: Mesh<RingGeometry, MeshBasicMaterial>;
  /** The accent ring: selection, or hover. */
  halo: Mesh<RingGeometry, MeshBasicMaterial>;
  /** The filled accent dot: selection only. */
  dot: Mesh<CircleGeometry, MeshBasicMaterial>;
  heading: Mesh<BufferGeometry, MeshBasicMaterial>;
  name: string;
}

interface LabelVisual {
  sprite: Sprite;
  widthPx: number;
  heightPx: number;
  anchor: Vector3;
  /** Higher wins when two labels overlap. */
  priority: number;
}

/** How a label is drawn. Every field is part of its texture cache key. */
interface LabelStyle {
  color: string;
  halo: string;
  haloWidth: number;
  size: number;
  bold?: boolean;
  /** A stop number sits in a small outlined badge; a name does not. */
  badge?: { stroke: string; fill: string };
  /** A tiny outline glyph drawn to the left of the text. */
  glyph?: SiteKind;
  glyphColor?: string;
}

/**
 * A layer, so it is transformed into the fixed frame by the same TF machinery
 * as every other layer, but fed by the Route store instead of by a topic.
 */
export class RouteLayer extends Layer {
  readonly schema: SettingsSchema = {};

  #viewer: Viewer;
  #store: RouteStore;
  #version = -1;
  /** World metres per pixel the geometry was last built for. */
  #builtWpp = 0.02;
  #colors: ThemeColors = themeColors();

  #laneMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  #routeMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  #drivingMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  #highlightMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  #pointsGroup = new Group();
  #labelGroup = new Group();

  #points: PointVisual[] = [];
  #labels: LabelVisual[] = [];
  /** Lane endpoints in world coordinates, for hit-testing and highlighting. */
  #laneEnds: { ax: number; ay: number; bx: number; by: number }[] = [];
  #pendingMesh: Mesh<BufferGeometry, MeshBasicMaterial>;
  #hover: RouteHit = null;
  #run: RouteRunState = EMPTY_RUN_STATE;
  #drivingLeg: [number, number][] = [];
  #lastLabelPass = 0;

  showLanes = true;
  showPoints = true;
  showRoute = true;

  constructor(viewer: Viewer, store: RouteStore) {
    super("route", "iviz/RouteGraph", {});
    this.#viewer = viewer;
    this.#store = store;
    this.#laneMesh = emptyMesh();
    this.#routeMesh = emptyMesh();
    this.#drivingMesh = emptyMesh();
    this.#highlightMesh = emptyMesh();
    this.#pendingMesh = emptyMesh();
    this.#highlightMesh.material.opacity = 0.3;
    this.#drivingMesh.material.opacity = 0.9;
    this.root.add(this.#highlightMesh, this.#laneMesh, this.#routeMesh, this.#drivingMesh, this.#pendingMesh, this.#pointsGroup, this.#labelGroup);
  }

  onMessage(): void {
    /* fed by the store, not by a topic */
  }

  /**
   * The theme changed. Everything drawn here takes its colour from the theme,
   * so the whole drawing is rebuilt — cheap, and it happens once per switch.
   */
  setThemeColors(colors: ThemeColors): void {
    this.#colors = colors;
    clearTextCache();
    this.#version = -1;
  }

  /** The lane currently being driven, so it can be animated. */
  setRunState(run: RouteRunState): void {
    this.#run = run;
    this.#applyRunColors();
  }

  /** The rubber band the Link tool draws while dragging from one point. */
  setPendingLink(from: { x: number; y: number } | null, to: { x: number; y: number } | null): void {
    const pos: number[] = [];
    const col: number[] = [];
    if (from && to) pushRibbon(pos, col, from.x, from.y, to.x, to.y, this.#builtWpp * ROUTE_PX, new Color(this.#colors.accent), Z_ROUTE);
    setGeometry(this.#pendingMesh, pos, col);
  }

  /**
   * Repaint the hover and selection marks. Selecting a lane from somewhere
   * other than the map — the "Lanes here" list of a point, say — changes the
   * store without touching the hover, so the shell calls this after a refresh.
   */
  refreshHighlight(): void {
    this.#applyHighlight();
  }

  setHover(hit: RouteHit): void {
    const same =
      (this.#hover === null && hit === null) ||
      (this.#hover?.kind === "point" && hit?.kind === "point" && this.#hover.name === hit.name) ||
      (this.#hover?.kind === "lane" && hit?.kind === "lane" && this.#hover.index === hit.index);
    if (same) return;
    this.#hover = hit;
    this.#applyHighlight();
  }
  get hover(): RouteHit {
    return this.#hover;
  }

  /**
   * What is under a world position, within `pixels` screen pixels. The route
   * graph lies on the ground plane, so the ray from the pointer is intersected
   * with that plane once (by the Viewer) and hit-testing is exact 2D geometry
   * from there, in 2D and in 3D alike.
   */
  pick(x: number, y: number, worldPerPixel: number, pixels = 18): RouteHit {
    const tol = worldPerPixel * pixels;
    let best: RouteHit = null;
    let bestDist = Infinity;
    for (const p of this.#points) {
      const site = this.#store.points[p.name];
      if (!site) continue;
      const d = Math.hypot(x - site.x, y - site.y);
      const r = Math.max(DISC_RADIUS, worldPerPixel * MIN_DISC_PX) + tol * 0.5;
      if (d <= r && d < bestDist) {
        bestDist = d;
        best = { kind: "point", name: p.name };
      }
    }
    if (best) return best;
    for (let i = 0; i < this.#laneEnds.length; i++) {
      const e = this.#laneEnds[i]!;
      const hit = pointOnSegment(x, y, e.ax, e.ay, e.bx, e.by);
      if (hit.dist <= tol && hit.dist < bestDist) {
        bestDist = hit.dist;
        best = { kind: "lane", index: i, x: hit.x, y: hit.y };
      }
    }
    return best;
  }

  override update(ctx: LayerContext): void {
    const wpp = this.#viewer.worldPerPixel(0, 0, 0);
    const zoomed = wpp > this.#builtWpp * ZOOM_REBUILD_RATIO || wpp < this.#builtWpp / ZOOM_REBUILD_RATIO;
    if (this.#version !== this.#store.version || zoomed) {
      this.#version = this.#store.version;
      this.frameId = this.#store.frame;
      this.#builtWpp = wpp;
      this.#rebuild();
    }
    this.#laneMesh.visible = this.showLanes;
    this.#routeMesh.visible = this.showRoute;
    this.#pointsGroup.visible = this.showPoints;
    this.#labelGroup.visible = this.showPoints || this.showLanes;
    if (!this.applyTf(ctx, this.root, this.frameId)) return;
    this.#scaleScreenSizes();
    if (ctx.nowMs - this.#lastLabelPass > 120) {
      this.#lastLabelPass = ctx.nowMs;
      this.#hideCollidingLabels();
    }
    this.#animateDriving(ctx.nowMs);
  }

  override dispose(): void {
    disposeObject(this.root);
  }

  // ---- geometry -----------------------------------------------------------

  #rebuild(): void {
    const c = this.#colors;
    const sites = this.#store.points;
    const lanes = this.#store.lanes;
    const wpp = this.#builtWpp;
    const laneWidth = wpp * LANE_PX;
    const routeWidth = wpp * ROUTE_PX;

    // lanes: one weight, one colour, dashed when blocked
    const pos: number[] = [];
    const col: number[] = [];
    this.#laneEnds = [];
    const laneLabels: { text: string; x: number; y: number }[] = [];
    for (const lane of lanes) {
      const a = sites[lane.from];
      const b = sites[lane.to];
      if (!a || !b) {
        this.#laneEnds.push({ ax: 0, ay: 0, bx: 0, by: 0 });
        continue;
      }
      this.#laneEnds.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y });
      const color = new Color(lane.blocked === true ? c.err : c.muted);
      if (lane.blocked === true) pushDashes(pos, col, a.x, a.y, b.x, b.y, laneWidth, color, Z_LANE, wpp * DASH_PX, wpp * DASH_GAP_PX);
      else pushRibbon(pos, col, a.x, a.y, b.x, b.y, laneWidth, color, Z_LANE);
      pushLaneChevrons(pos, col, lane, a, b, color, wpp);
      // A speed cap keeps the lane colour and says what it is in text.
      if (typeof lane.speed_mps === "number" && lane.speed_mps > 0) {
        laneLabels.push({ text: `${lane.speed_mps} m/s`, x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
      }
    }
    setGeometry(this.#laneMesh, pos, col);

    // the planned route through the mission's stops, on top of the lanes
    const stops = this.#store.stops;
    const legs = planRoute(stops, sites, lanes, this.#store.mission);
    const rpos: number[] = [];
    const rcol: number[] = [];
    this.#legRanges = [];
    for (const leg of legs) {
      const color = new Color(leg.problem ? c.err : c.accent);
      const start = rpos.length / 3;
      for (let i = 1; i < leg.route.length; i++) {
        const a = sites[leg.route[i - 1]!];
        const b = sites[leg.route[i]!];
        if (!a || !b) continue;
        pushRibbon(rpos, rcol, a.x, a.y, b.x, b.y, routeWidth, color, Z_ROUTE);
      }
      this.#legRanges.push({ stopIndex: leg.stopIndex, start, count: rpos.length / 3 - start, route: leg.route.slice() });
    }
    setGeometry(this.#routeMesh, rpos, rcol);
    this.#routeMesh.material.opacity = 1;
    this.#routeMesh.material.transparent = true;

    // points
    disposeObject(this.#pointsGroup);
    this.#points = [];
    const stopNumbers = new Map<string, number[]>();
    stops.forEach((stop, i) => {
      const site = stopSite(stop, this.#store.mission);
      if (site === null) return;
      const list = stopNumbers.get(site);
      if (list) list.push(i + 1);
      else stopNumbers.set(site, [i + 1]);
    });
    for (const [name, site] of Object.entries(sites)) {
      this.#points.push(this.#makePoint(name, site));
    }

    // labels: plain text with a halo, the kind as a glyph, stops in a badge
    disposeObject(this.#labelGroup);
    this.#labels = [];
    for (const [name, site] of Object.entries(sites)) {
      const nums = stopNumbers.get(name);
      const kind = site.kind ?? "waypoint";
      this.#addLabel(
        name,
        site.x,
        site.y,
        { color: c.text, halo: c.labelHalo, haloWidth: c.labelHaloWidth, size: LABEL_PX, glyph: kind, glyphColor: c.muted },
        nums ? 100 : kind === "waypoint" ? 10 : 40,
        { offsetRight: true },
      );
      if (nums) {
        this.#addLabel(nums.join(","), site.x, site.y, { color: c.text, halo: c.labelHalo, haloWidth: c.labelHaloWidth, size: BADGE_PX, bold: true, badge: { stroke: c.accent, fill: c.surface } }, 200, { above: true });
      }
    }
    for (const l of laneLabels) {
      this.#addLabel(l.text, l.x, l.y, { color: c.muted, halo: c.labelHalo, haloWidth: c.labelHaloWidth, size: BADGE_PX }, 30, {});
    }

    this.#applyRunColors();
    this.#applyHighlight();
    this.status = Object.keys(sites).length === 0 ? "Nothing drawn on this map yet" : "";
  }

  #legRanges: { stopIndex: number; start: number; count: number; route: string[] }[] = [];

  /**
   * One point. Everything inside the group is in screen pixels; the group is
   * scaled by metres-per-pixel every frame, so the circle stays the same size
   * on screen at every zoom.
   */
  #makePoint(name: string, site: Site): PointVisual {
    const c = this.#colors;
    const fill = new Mesh(new CircleGeometry(POINT_PX, 32), flatMaterial(c.surface));
    fill.position.z = Z_DISC;
    fill.renderOrder = 12;
    const ring = new Mesh(new RingGeometry(POINT_PX - POINT_RING_PX, POINT_PX, 40), flatMaterial(c.text));
    ring.position.z = Z_DISC + 0.001;
    ring.renderOrder = 13;
    const halo = new Mesh(new RingGeometry(SELECT_RING_RADIUS_PX - SELECT_RING_PX, SELECT_RING_RADIUS_PX, 44), flatMaterial(c.accent));
    halo.position.z = Z_HALO;
    halo.renderOrder = 11;
    halo.visible = false;
    const dot = new Mesh(new CircleGeometry(SELECT_DOT_PX, 20), flatMaterial(c.accent));
    dot.position.z = Z_DISC + 0.002;
    dot.renderOrder = 14;
    dot.visible = false;
    const heading = new Mesh(headingGeometry(), flatMaterial(c.text));
    heading.position.z = Z_ARROW;
    heading.renderOrder = 13;
    if (typeof site.yaw_deg === "number") heading.rotation.z = (site.yaw_deg * Math.PI) / 180;
    else heading.visible = false;
    const group = new Group();
    group.position.set(site.x, site.y, 0);
    group.add(halo, fill, ring, dot, heading);
    this.#pointsGroup.add(group);
    return { group, fill, ring, halo, dot, heading, name };
  }

  #addLabel(text: string, x: number, y: number, style: LabelStyle, priority: number, place: { offsetRight?: boolean; above?: boolean }): void {
    const tex = textTexture(text, style);
    const sprite = new Sprite(new SpriteMaterial({ map: tex.texture, depthTest: false, depthWrite: false, transparent: true, sizeAttenuation: true }));
    sprite.renderOrder = 20;
    sprite.position.set(x, y, Z_LABEL);
    // `center` shifts the sprite in screen space, so the offset survives orbiting.
    if (place.offsetRight) sprite.center.set(-0.12, 0.5);
    else if (place.above) sprite.center.set(0.5, -0.9);
    this.#labelGroup.add(sprite);
    this.#labels.push({ sprite, widthPx: tex.widthPx, heightPx: tex.heightPx, anchor: new Vector3(x, y, Z_LABEL), priority });
  }

  // ---- per-frame mutation -------------------------------------------------

  #scaleScreenSizes(): void {
    for (const p of this.#points) {
      const wpp = this.#viewer.worldPerPixel(p.group.position.x, p.group.position.y, 0);
      p.group.scale.set(wpp, wpp, 1);
    }
    for (const l of this.#labels) {
      const wpp = this.#viewer.worldPerPixel(l.anchor.x, l.anchor.y, 0);
      l.sprite.scale.set(wpp * l.widthPx, wpp * l.heightPx, 1);
    }
  }

  /** Greedy screen-space declutter: the important labels win the space. */
  #hideCollidingLabels(): void {
    const taken: { x0: number; y0: number; x1: number; y1: number }[] = [];
    if (!this.#labelGroup.visible) return;
    const order = this.#labels.slice().sort((a, b) => b.priority - a.priority);
    for (const l of order) {
      _world.copy(l.anchor).applyMatrix4(this.root.matrix);
      if (!this.#viewer.projectToScreen(_world, _screen)) {
        l.sprite.visible = false;
        continue;
      }
      const w = l.widthPx;
      const h = l.heightPx;
      const cx = l.sprite.center.x;
      const cy = l.sprite.center.y;
      const x0 = _screen.x - cx * w;
      const y0 = _screen.y - (1 - cy) * h;
      const rect = { x0, y0, x1: x0 + w, y1: y0 + h };
      const clash = taken.some((t) => rect.x0 < t.x1 && rect.x1 > t.x0 && rect.y0 < t.y1 && rect.y1 > t.y0);
      l.sprite.visible = !clash;
      if (!clash) taken.push(rect);
    }
  }

  #applyHighlight(): void {
    const sel = this.#store.selection;
    for (const p of this.#points) {
      const selected = sel.kind === "point" && sel.name === p.name;
      const hovered = this.#hover?.kind === "point" && this.#hover.name === p.name;
      // Selected is a filled accent dot inside a thin accent ring; hover is
      // the ring on its own.
      p.halo.visible = selected || hovered;
      p.halo.material.opacity = selected ? 1 : 0.55;
      p.dot.visible = selected;
    }
    // One soft accent band under the hovered or selected lane; no full rebuild.
    const index = sel.kind === "lane" ? sel.index : this.#hover?.kind === "lane" ? this.#hover.index : -1;
    const e = index >= 0 ? this.#laneEnds[index] : undefined;
    const pos: number[] = [];
    const col: number[] = [];
    const selectedLane = sel.kind === "lane";
    if (e && (e.ax !== e.bx || e.ay !== e.by)) {
      const width = this.#builtWpp * HIGHLIGHT_PX * (selectedLane ? 1.4 : 1);
      pushRibbon(pos, col, e.ax, e.ay, e.bx, e.by, width, new Color(this.#colors.accent), Z_HIGHLIGHT);
    }
    setGeometry(this.#highlightMesh, pos, col);
    this.#highlightMesh.material.opacity = selectedLane ? 0.45 : 0.2;
    this.#highlightMesh.material.transparent = true;
  }

  /** Colour the stops by run status and pick out the leg being driven. */
  #applyRunColors(): void {
    const c = this.#colors;
    const stops = this.#store.stops;
    const bySite = new Map<string, number>();
    stops.forEach((stop, i) => {
      const site = stopSite(stop, this.#store.mission);
      if (site !== null && !bySite.has(site)) bySite.set(site, i);
    });
    for (const p of this.#points) {
      const stopIndex = bySite.get(p.name);
      let color = c.text;
      if (stopIndex !== undefined) {
        if (this.#run.failedStop === stopIndex) color = c.err;
        else if (this.#run.doneStops.has(stopIndex)) color = c.ok;
        else if (this.#run.activeStop === stopIndex) color = c.warn;
      }
      p.ring.material.color.set(color);
      p.heading.material.color.set(color);
    }
    // The lane the robot is on: the leg that arrives at the active stop.
    this.#drivingLeg = [];
    const active = this.#run.activeStop;
    if (active !== null) {
      const leg = this.#legRanges.find((l) => l.stopIndex === active);
      if (leg) {
        const sites = this.#store.points;
        for (const name of leg.route) {
          const s = sites[name];
          if (s) this.#drivingLeg.push([s.x, s.y]);
        }
      }
    }
    if (this.#drivingLeg.length < 2) setGeometry(this.#drivingMesh, [], []);
  }

  /** A pulse travelling along the lane being driven. */
  #animateDriving(nowMs: number): void {
    if (this.#drivingLeg.length < 2) {
      this.#drivingMesh.visible = false;
      return;
    }
    this.#drivingMesh.visible = true;
    const total = this.#drivingLeg.reduce((sum, p, i) => (i === 0 ? 0 : sum + Math.hypot(p[0] - this.#drivingLeg[i - 1]![0], p[1] - this.#drivingLeg[i - 1]![1])), 0);
    if (total <= 0) return;
    const span = Math.min(1.2, total * 0.35);
    const head = ((nowMs / 900) % 1) * (total + span);
    const pos: number[] = [];
    const col: number[] = [];
    const color = new Color(this.#colors.warn);
    const width = this.#builtWpp * ROUTE_PX;
    let walked = 0;
    for (let i = 1; i < this.#drivingLeg.length; i++) {
      const a = this.#drivingLeg[i - 1]!;
      const b = this.#drivingLeg[i]!;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len <= 0) continue;
      const from = Math.max(walked, head - span);
      const to = Math.min(walked + len, head);
      if (to > from) {
        const t0 = (from - walked) / len;
        const t1 = (to - walked) / len;
        pushRibbon(
          pos,
          col,
          a[0] + (b[0] - a[0]) * t0,
          a[1] + (b[1] - a[1]) * t0,
          a[0] + (b[0] - a[0]) * t1,
          a[1] + (b[1] - a[1]) * t1,
          width,
          color,
          Z_ROUTE + 0.002,
        );
      }
      walked += len;
    }
    setGeometry(this.#drivingMesh, pos, col);
  }
}

// ---- geometry helpers -------------------------------------------------------

function flatMaterial(color: string): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true });
}

function emptyMesh(): Mesh<BufferGeometry, MeshBasicMaterial> {
  // Frustum culling is off, so the geometry must carry real (empty) attributes:
  // a BufferGeometry with no position attribute draws whatever is still bound,
  // which paints garbage over the map.
  const geom = new BufferGeometry();
  geom.setAttribute("position", new BufferAttribute(new Float32Array(0), 3));
  geom.setAttribute("color", new BufferAttribute(new Float32Array(0), 3));
  const mesh = new Mesh(geom, new MeshBasicMaterial({ vertexColors: true, depthTest: false, depthWrite: false, transparent: true }));
  mesh.frustumCulled = false;
  mesh.renderOrder = 8;
  mesh.visible = false;
  return mesh;
}

function setGeometry(mesh: Mesh<BufferGeometry, MeshBasicMaterial>, pos: number[], col: number[]): void {
  const geom = new BufferGeometry();
  geom.setAttribute("position", new BufferAttribute(new Float32Array(pos), 3));
  geom.setAttribute("color", new BufferAttribute(new Float32Array(col), 3));
  const old = mesh.geometry;
  mesh.geometry = geom;
  old.dispose();
  mesh.visible = pos.length > 0;
}

function pushVertex(pos: number[], col: number[], x: number, y: number, z: number, c: Color): void {
  pos.push(x, y, z);
  col.push(c.r, c.g, c.b);
}

/** Two triangles forming a band of `width` metres from a to b. */
function pushRibbon(pos: number[], col: number[], ax: number, ay: number, bx: number, by: number, width: number, c: Color, z: number): void {
  const dx = bx - ax;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const nx = (-dy / len) * (width / 2);
  const ny = (dx / len) * (width / 2);
  pushVertex(pos, col, ax + nx, ay + ny, z, c);
  pushVertex(pos, col, ax - nx, ay - ny, z, c);
  pushVertex(pos, col, bx - nx, by - ny, z, c);
  pushVertex(pos, col, ax + nx, ay + ny, z, c);
  pushVertex(pos, col, bx - nx, by - ny, z, c);
  pushVertex(pos, col, bx + nx, by + ny, z, c);
}

/** A dashed line: a blocked lane. Dash and gap are screen-constant. */
function pushDashes(pos: number[], col: number[], ax: number, ay: number, bx: number, by: number, width: number, c: Color, z: number, dash: number, gap: number): void {
  const len = Math.hypot(bx - ax, by - ay);
  if (len < 1e-6 || dash <= 0) return;
  for (let s = 0; s < len; s += dash + gap) {
    const t0 = s / len;
    const t1 = Math.min(1, (s + dash) / len);
    pushRibbon(pos, col, ax + (bx - ax) * t0, ay + (by - ay) * t0, ax + (bx - ax) * t1, ay + (by - ay) * t1, width, c, z);
  }
}

/** A small open chevron: two short strokes meeting at the tip. */
function pushChevron(pos: number[], col: number[], x: number, y: number, dx: number, dy: number, size: number, stroke: number, c: Color, z: number): void {
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const ux = dx / len;
  const uy = dy / len;
  const px = -uy;
  const py = ux;
  const tipX = x + ux * size * 0.5;
  const tipY = y + uy * size * 0.5;
  const backX = tipX - ux * size;
  const backY = tipY - uy * size;
  const armX = px * size * 0.7;
  const armY = py * size * 0.7;
  pushRibbon(pos, col, backX + armX, backY + armY, tipX, tipY, stroke, c, z);
  pushRibbon(pos, col, backX - armX, backY - armY, tipX, tipY, stroke, c, z);
}

/** One chevron when the lane is one-way, two when it goes both ways. */
function pushLaneChevrons(pos: number[], col: number[], lane: Edge, a: Site, b: Site, c: Color, wpp: number): void {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return;
  const size = Math.min(wpp * CHEVRON_PX, len * 0.2);
  const stroke = wpp * CHEVRON_STROKE_PX;
  const z = Z_LANE + 0.001;
  if (lane.bidirectional === false) {
    pushChevron(pos, col, a.x + dx * 0.62, a.y + dy * 0.62, dx, dy, size, stroke, c, z);
  } else {
    pushChevron(pos, col, a.x + dx * 0.74, a.y + dy * 0.74, dx, dy, size, stroke, c, z);
    pushChevron(pos, col, a.x + dx * 0.26, a.y + dy * 0.26, -dx, -dy, size, stroke, c, z);
  }
}

/** A point's heading: a short thin tick outside the circle, in pixel units. */
function headingGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  const t = HEADING_STROKE_PX / 2;
  const a = HEADING_BASE_PX;
  const b = HEADING_TIP_PX;
  const verts = new Float32Array([a, -t, 0, b, -t, 0, b, t, 0, a, -t, 0, b, t, 0, a, t, 0]);
  g.setAttribute("position", new BufferAttribute(verts, 3));
  return g;
}

// ---- text sprites -----------------------------------------------------------

interface TextTexture {
  texture: CanvasTexture;
  widthPx: number;
  heightPx: number;
}

const textCache = new Map<string, TextTexture>();

function clearTextCache(): void {
  for (const t of textCache.values()) t.texture.dispose();
  textCache.clear();
}

/**
 * Render a label to a canvas once and reuse it. `widthPx`/`heightPx` are the
 * on-screen size the sprite is scaled to every frame. A name is plain text
 * with a halo so it stays legible over a floor plan; a stop number sits in a
 * small outlined badge.
 */
function textTexture(text: string, style: LabelStyle): TextTexture {
  const key = JSON.stringify([text, style]);
  const cached = textCache.get(key);
  if (cached) return cached;
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  const fontPx = style.size;
  const badge = style.badge;
  const halo = Math.max(0, style.haloWidth);
  const padX = badge ? 5 : Math.ceil(halo) + 1;
  const padY = badge ? 3 : Math.ceil(halo) + 1;
  const glyphW = style.glyph ? fontPx : 0;
  const glyphGap = style.glyph ? 4 : 0;
  const font = `${style.bold === true ? "600 " : ""}${fontPx}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const measure = document.createElement("canvas").getContext("2d");
  if (measure) measure.font = font;
  const textW = measure ? measure.measureText(text).width : text.length * fontPx * 0.6;
  const widthPx = Math.ceil(textW + glyphW + glyphGap + padX * 2);
  const heightPx = fontPx + padY * 2;
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(widthPx * dpr));
  canvas.height = Math.max(1, Math.ceil(heightPx * dpr));
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.scale(dpr, dpr);
    if (badge) {
      roundRect(ctx, 0.5, 0.5, widthPx - 1, heightPx - 1, 3);
      ctx.fillStyle = badge.fill;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = badge.stroke;
      ctx.stroke();
    }
    if (style.glyph) drawKindGlyph(ctx, style.glyph, padX, heightPx / 2, glyphW, style.glyphColor ?? style.color);
    ctx.font = font;
    ctx.textBaseline = "middle";
    const textX = padX + glyphW + glyphGap;
    const textY = heightPx / 2 + 0.5;
    if (!badge) {
      // A halo instead of a chip: enough to read over a floor plan, invisible
      // over an empty floor.
      ctx.lineWidth = style.haloWidth;
      ctx.lineJoin = "round";
      ctx.lineCap = "round";
      ctx.strokeStyle = style.halo;
      ctx.strokeText(text, textX, textY);
    }
    ctx.fillStyle = style.color;
    ctx.fillText(text, textX, textY);
  }
  const texture = new CanvasTexture(canvas);
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  const out = { texture, widthPx, heightPx };
  if (textCache.size > 500) clearTextCache();
  textCache.set(key, out);
  return out;
}

/** The tiny outline glyph that says what kind of place a point is. */
function drawKindGlyph(ctx: CanvasRenderingContext2D, kind: SiteKind, x: number, cy: number, box: number, color: string): void {
  const s = box * 0.72;
  const left = x + (box - s) / 2;
  const top = cy - s / 2;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  ctx.beginPath();
  switch (kind) {
    case "home":
      // a house
      ctx.moveTo(left, top + s * 0.42);
      ctx.lineTo(left + s / 2, top);
      ctx.lineTo(left + s, top + s * 0.42);
      ctx.lineTo(left + s, top + s);
      ctx.lineTo(left, top + s);
      ctx.closePath();
      break;
    case "dock":
      // a berth, open towards the robot
      ctx.moveTo(left, top);
      ctx.lineTo(left + s, top);
      ctx.lineTo(left + s, top + s);
      ctx.lineTo(left, top + s);
      break;
    case "station":
      // a square
      ctx.rect(left, top, s, s);
      break;
    default:
      // a waypoint: a diamond
      ctx.moveTo(left + s / 2, top);
      ctx.lineTo(left + s, top + s / 2);
      ctx.lineTo(left + s / 2, top + s);
      ctx.lineTo(left, top + s / 2);
      ctx.closePath();
      break;
  }
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}
