import { BufferGeometry, DoubleSide, Group, Line, LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, Shape, ShapeGeometry, Vector3 } from "three";
import { Layer, disposeObject } from "./Layer";
import type { LayerContext, SettingsSchema, SettingsValues } from "./Layer";
import type { PolygonStamped } from "../../ros/types";
import { themeColors } from "../../ui/theme";
import type { ThemeColors } from "../../ui/theme";

const SCHEMA: SettingsSchema = {};
const DEFAULTS: SettingsValues = {};

/** Frames tried, in order, for where the robot is. */
const ROBOT_FRAMES = ["base_link", "base_footprint"];
/** Until Nav2 publishes a footprint: a 0.5 m x 0.4 m body. */
const DEFAULT_FOOTPRINT: [number, number][] = [
  [0.25, 0.2],
  [-0.25, 0.2],
  [-0.25, -0.2],
  [0.25, -0.2],
];
const AXIS_RED = "#e53935";
const AXIS_GREEN = "#2e9e44";
const Z = 0.06;

const _m = new Matrix4();
const _v = new Vector3();

/**
 * The robot, drawn as what it is rather than as TF frames: its footprint (from
 * Nav2's `published_footprint` when there is one, a default body otherwise), a
 * chevron pointing forward, and the x / y axes of base_link. Nothing else from
 * TF is drawn.
 */
export class RobotLayer extends Layer {
  readonly schema = SCHEMA;
  #colors: ThemeColors = themeColors();
  #body = new Group();
  #footprint: [number, number][] = DEFAULT_FOOTPRINT;
  #fromTopic = false;
  #pending: PolygonStamped | null = null;
  #robotFrame = "";
  #reach = 0.3;
  #pixelsPerMeter: () => number;

  /** `pixelsPerMeter` lets the robot keep a readable size when the whole map is in view. */
  constructor(pixelsPerMeter: () => number = () => 0) {
    super("robot", "robot", DEFAULTS, {});
    this.#pixelsPerMeter = pixelsPerMeter;
    this.root.add(this.#body);
    this.#rebuild();
  }

  /** The robot is drawn from TF; the footprint arrives through `onFootprint`. */
  onMessage(): void {
    /* not tied to a topic */
  }

  /** A `geometry_msgs/PolygonStamped` footprint, in whatever frame the costmap publishes it. */
  onFootprint(msg: PolygonStamped): void {
    this.#pending = msg;
  }

  setThemeColors(colors: ThemeColors): void {
    this.#colors = colors;
    this.#rebuild();
  }

  update(ctx: LayerContext): void {
    this.root.visible = false;
    if (!this.visible) return;
    const frame = ROBOT_FRAMES.find((f) => ctx.tf.hasFrame(f));
    if (!frame) return;
    this.#robotFrame = frame;
    if (this.#pending) this.#takeFootprint(ctx, this.#pending);
    if (!ctx.tf.lookup(ctx.fixedFrame, frame, _m)) return;
    this.root.matrix.copy(_m);
    // Never smaller than ~18 px across its reach, so it stays visible zoomed out.
    const ppm = this.#pixelsPerMeter();
    const minPx = 18;
    this.#body.scale.setScalar(ppm > 0 && this.#reach * ppm < minPx ? minPx / (this.#reach * ppm) : 1);
    this.root.visible = true;
  }

  /** Bring the footprint into the robot's own frame, so it moves with TF every frame. */
  #takeFootprint(ctx: LayerContext, msg: PolygonStamped): void {
    const src = msg.header.frame_id || ctx.fixedFrame;
    if (!ctx.tf.lookup(this.#robotFrame, src, _m)) return;
    this.#pending = null;
    const pts: [number, number][] = [];
    for (const p of msg.polygon.points) {
      _v.set(p.x, p.y, 0).applyMatrix4(_m);
      pts.push([_v.x, _v.y]);
    }
    const extent = Math.max(...pts.map(([x, y]) => Math.hypot(x, y)));
    // Ignore empty or implausible footprints (e.g. published before TF settled).
    if (pts.length < 3 || !(extent > 0.02 && extent < 5)) return;
    if (this.#fromTopic && sameShape(pts, this.#footprint)) return;
    this.#footprint = pts;
    this.#fromTopic = true;
    this.#rebuild();
  }

  #rebuild(): void {
    disposeObject(this.#body);
    const c = this.#colors;
    const pts = this.#footprint;
    const reach = Math.max(0.15, ...pts.map(([x, y]) => Math.hypot(x, y)));
    this.#reach = reach;
    const front = Math.max(0.1, ...pts.map(([x]) => x));

    const shape = new Shape(pts.map(([x, y]) => ({ x, y }) as never));
    // A white halo under the body so it reads on black walls and on grey unknown space.
    const grow = 1 + 0.06 / reach;
    const haloShape = new Shape(pts.map(([x, y]) => ({ x: x * grow, y: y * grow }) as never));
    const halo = new Mesh(new ShapeGeometry(haloShape), overlay(new MeshBasicMaterial({ color: "#ffffff", opacity: 0.9, side: DoubleSide })));
    halo.position.z = Z - 0.001;
    halo.renderOrder = 14;
    const fill = new Mesh(new ShapeGeometry(shape), overlay(new MeshBasicMaterial({ color: c.accent, opacity: 0.45, side: DoubleSide })));
    fill.position.z = Z;
    fill.renderOrder = 15;

    const outlinePts = [...pts, pts[0]!].map(([x, y]) => new Vector3(x, y, Z));
    const outline = new Line(new BufferGeometry().setFromPoints(outlinePts), overlay(new LineBasicMaterial({ color: c.accent })));
    outline.renderOrder = 16;
    // A second, slightly larger ring so the edge reads as a thick line.
    const s = 1 + 0.02 / reach;
    const outline2 = new Line(new BufferGeometry().setFromPoints(outlinePts.map((p) => new Vector3(p.x * s, p.y * s, Z))), overlay(new LineBasicMaterial({ color: c.accent })));
    outline2.renderOrder = 16;

    // Chevron pointing forward, inside the body.
    const w = Math.min(reach * 0.45, 0.25);
    const chevron = new Shape();
    chevron.moveTo(front * 0.8, 0);
    chevron.lineTo(front * 0.8 - w, w * 0.7);
    chevron.lineTo(front * 0.8 - w * 0.7, 0);
    chevron.lineTo(front * 0.8 - w, -w * 0.7);
    chevron.closePath();
    const arrow = new Mesh(new ShapeGeometry(chevron), overlay(new MeshBasicMaterial({ color: "#ffffff", side: DoubleSide })));
    arrow.position.z = Z + 0.001;
    arrow.renderOrder = 17;

    // base_link axes as thin bars, long enough to stick out of the body.
    const len = reach * 1.5;
    const thick = Math.max(0.018, reach * 0.06);
    const xAxis = bar(len, thick, AXIS_RED);
    const yAxis = bar(len * 0.7, thick, AXIS_GREEN);
    yAxis.rotation.z = Math.PI / 2;
    for (const a of [xAxis, yAxis]) {
      a.position.z = Z + 0.002;
      a.renderOrder = 18;
    }

    this.#body.add(halo, fill, outline, outline2, arrow, xAxis, yAxis);
  }

  dispose(): void {
    disposeObject(this.root);
  }
}

function overlay<T extends MeshBasicMaterial | LineBasicMaterial>(m: T): T {
  m.depthTest = false;
  m.depthWrite = false;
  m.transparent = true;
  return m;
}

/** A bar from the origin along +x, `len` long and `thick` wide. */
function bar(len: number, thick: number, color: string): Mesh {
  const shape = new Shape();
  shape.moveTo(0, -thick / 2);
  shape.lineTo(len, -thick / 2);
  shape.lineTo(len, thick / 2);
  shape.lineTo(0, thick / 2);
  shape.closePath();
  const mesh = new Mesh(new ShapeGeometry(shape), overlay(new MeshBasicMaterial({ color, side: DoubleSide })));
  return mesh;
}

function sameShape(a: [number, number][], b: [number, number][]): boolean {
  if (a.length !== b.length) return false;
  return a.every(([x, y], i) => Math.abs(x - b[i]![0]) < 0.01 && Math.abs(y - b[i]![1]) < 0.01);
}
