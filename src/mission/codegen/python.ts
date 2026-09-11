/**
 * Mission -> self-contained nav2_simple_commander script. Each step becomes a
 * commented block; if/loop become Python blocks; on_fail.retry becomes a
 * `for attempt in range(n + 1)` loop with before_retry inlined. Expressions are
 * evaluated at run time by ev()/val(), which mirror the runner's resolution
 * rules; pure references like "$goal.x" become direct ctx lookups.
 */

import type { Mission, SitesDoc, Step } from "../types";
import { isRecord } from "../types";
import { stepSummary } from "../blocks";

export interface PythonOptions {
  sites?: SitesDoc | null;
  activeMap?: string | null;
  /** File name shown in the docstring (defaults to `<name>.json`). */
  fileName?: string;
}

const REF_RE = /^\$([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*|\[[0-9]+\])*)$/;
const WHOLE_INTERP_RE = /^\$\{([^{}]*)\}$/;
const IND = "    ";

/** Python literal for a JSON value. */
export function pyLit(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "None";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(pyLit).join(", ")}]`;
  if (isRecord(v)) return `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}: ${pyLit(x)}`).join(", ")}}`;
  return "None";
}

function containsExpression(v: unknown): boolean {
  if (typeof v === "string") return REF_RE.test(v) || v.includes("${");
  if (Array.isArray(v)) return v.some(containsExpression);
  if (isRecord(v)) return Object.values(v).some(containsExpression);
  return false;
}

/** Python expression producing the run-time value of a mission value. */
export function pyValue(v: unknown): string {
  if (typeof v === "string") {
    const ref = REF_RE.exec(v);
    if (ref) return refLookup(ref[1]!);
    const whole = WHOLE_INTERP_RE.exec(v);
    if (whole) return `ev(${JSON.stringify(whole[1])}, ctx)`;
    if (v.includes("${")) return `val(${JSON.stringify(v)}, ctx)`;
    return JSON.stringify(v);
  }
  if (containsExpression(v)) return `val(${pyLit(v)}, ctx)`;
  return pyLit(v);
}

function refLookup(path: string): string {
  // goal.x[0] -> ctx["goal"]["x"][0]; deeper lookups tolerate missing keys via ref()
  const parts = path.split(/\.|(?=\[)/).filter((p) => p !== "");
  if (parts.length === 1) return `ctx[${JSON.stringify(parts[0])}]`;
  const keys = parts.map((p) => (p.startsWith("[") ? p.slice(1, -1) : JSON.stringify(p)));
  return `ref(ctx, ${keys.join(", ")})`;
}

function pyStr(v: unknown): string {
  return typeof v === "string" && !containsExpression(v) ? JSON.stringify(v) : `str(${pyValue(v)})`;
}

interface Emitted {
  lines: string[];
  /** Whether the step sets `ok` (and possibly `value`). */
  canFail: boolean;
  /** Whether the step sets `value` (else None). */
  hasValue: boolean;
}

interface Gen {
  mission: Mission;
  usesMqtt: boolean;
  usesRos: boolean;
  usesRosService: boolean;
  todo: number;
}

function poseExpr(p: unknown): string {
  return `pose_of(nav, ${pyValue(p)}, ctx)`;
}

function posesExpr(list: unknown): string {
  if (Array.isArray(list)) return `[${list.map(poseExpr).join(", ")}]`;
  return `[pose_of(nav, p, ctx) for p in ${pyValue(list)}]`;
}

function emitAction(g: Gen, step: Step): Emitted {
  const L: string[] = [];
  const out = (canFail: boolean, hasValue = false): Emitted => ({ lines: L, canFail, hasValue });
  switch (step.type) {
    case "nav.wait_active":
      L.push("nav.waitUntilNav2Active()");
      return out(false);
    case "nav.set_initial_pose":
      L.push(`nav.setInitialPose(${poseExpr(step.pose)})`);
      return out(false);
    case "nav.go_to_pose": {
      const bt = step.behavior_tree;
      if (typeof bt === "string") L.push(`nav.goToPose(${poseExpr(step.pose)}, behavior_tree=${JSON.stringify(bt)})`);
      else {
        if (isRecord(bt)) L.push(`# behavior tree template '${String(bt.template)}': export the XML from the editor and pass its path as behavior_tree=...`);
        L.push(`nav.goToPose(${poseExpr(step.pose)})`);
      }
      L.push("ok = wait_task(nav)");
      return out(true);
    }
    case "nav.go_through_poses": {
      const bt = step.behavior_tree;
      if (typeof bt === "string") L.push(`nav.goThroughPoses(${posesExpr(step.poses)}, behavior_tree=${JSON.stringify(bt)})`);
      else {
        if (isRecord(bt)) L.push(`# behavior tree template '${String(bt.template)}': export the XML from the editor and pass its path as behavior_tree=...`);
        L.push(`nav.goThroughPoses(${posesExpr(step.poses)})`);
      }
      L.push("ok = wait_task(nav)");
      return out(true);
    }
    case "nav.follow_waypoints":
      L.push(`nav.followWaypoints(${posesExpr(step.poses)})`);
      L.push("ok = wait_task(nav)");
      L.push("value = {\"missed\": list(getattr(nav.getResult(), \"missed_waypoints\", []) or [])}");
      return out(true, true);
    case "nav.follow_path": {
      const kw: string[] = [];
      if (typeof step.controller_id === "string" && step.controller_id !== "") kw.push(`controller_id=${JSON.stringify(step.controller_id)}`);
      if (typeof step.goal_checker_id === "string" && step.goal_checker_id !== "") kw.push(`goal_checker_id=${JSON.stringify(step.goal_checker_id)}`);
      const kws = kw.length ? `, ${kw.join(", ")}` : "";
      if (step.path !== undefined) L.push(`nav.followPath(${pyValue(step.path)}${kws})`);
      else {
        const spacing = typeof step.spacing_m === "number" ? step.spacing_m : 0.05;
        const fromRobot = step.from_robot === undefined ? true : Boolean(step.from_robot);
        L.push(`nav.followPath(make_path(nav, ${pyValue(step.points ?? [])}, spacing=${spacing}, from_robot=${fromRobot ? "True" : "False"}, ctx=ctx)${kws})`);
      }
      L.push("ok = wait_task(nav)");
      return out(true);
    }
    case "nav.compute_path": {
      const start = step.start !== undefined ? poseExpr(step.start) : "PoseStamped()";
      L.push(`value = nav.getPath(${start}, ${poseExpr(step.goal)}, planner_id=${JSON.stringify(String(step.planner_id ?? ""))}, use_start=${step.use_start ? "True" : "False"})`);
      L.push("ok = value is not None");
      return out(true, true);
    }
    case "nav.compute_path_through_poses": {
      const start = step.start !== undefined ? poseExpr(step.start) : "PoseStamped()";
      L.push(`value = nav.getPathThroughPoses(${start}, ${posesExpr(step.goals)}, planner_id=${JSON.stringify(String(step.planner_id ?? ""))}, use_start=${step.use_start ? "True" : "False"})`);
      L.push("ok = value is not None");
      return out(true, true);
    }
    case "nav.smooth_path":
      L.push(
        `value = nav.smoothPath(${pyValue(step.path)}, smoother_id=${JSON.stringify(String(step.smoother_id ?? ""))}, max_duration=${typeof step.max_duration_s === "number" ? step.max_duration_s : 2}, check_for_collision=${step.check_collision ? "True" : "False"})`,
      );
      L.push("ok = value is not None");
      return out(true, true);
    case "nav.spin":
      L.push(`nav.spin(spin_dist=math.radians(float(${pyValue(step.angle_deg)})), time_allowance=${typeof step.time_allowance_s === "number" ? step.time_allowance_s : 10})`);
      L.push("ok = wait_task(nav)");
      return out(true);
    case "nav.backup":
      L.push(`nav.backup(backup_dist=float(${pyValue(step.distance_m)}), backup_speed=float(${pyValue(step.speed_mps ?? 0.15)}), time_allowance=${typeof step.time_allowance_s === "number" ? step.time_allowance_s : 10})`);
      L.push("ok = wait_task(nav)");
      return out(true);
    case "nav.drive_on_heading":
      L.push(`nav.driveOnHeading(dist=float(${pyValue(step.distance_m)}), speed=float(${pyValue(step.speed_mps ?? 0.15)}), time_allowance=${typeof step.time_allowance_s === "number" ? step.time_allowance_s : 10})`);
      L.push("ok = wait_task(nav)");
      return out(true);
    case "nav.dock":
      if (typeof step.dock_id === "string" && step.dock_id !== "") L.push(`nav.dockRobotByID(${pyValue(step.dock_id)})`);
      else L.push(`nav.dockRobot(${poseExpr(step.dock_pose)}, ${JSON.stringify(String(step.dock_type ?? ""))})`);
      L.push("ok = wait_task(nav)");
      return out(true);
    case "nav.undock":
      L.push(`nav.undockRobot(${JSON.stringify(String(step.dock_type ?? ""))})`);
      L.push("ok = wait_task(nav)");
      return out(true);
    case "nav.change_map":
      L.push(`ok = nav.changeMap(MAPS.get(${pyValue(step.map)}, ${pyValue(step.map)})) is not False`);
      return out(true);
    case "nav.clear_costmap":
      L.push(step.which === "local" ? "nav.clearLocalCostmap()" : step.which === "global" ? "nav.clearGlobalCostmap()" : "nav.clearAllCostmaps()");
      return out(false);
    case "nav.lifecycle":
      L.push(step.action === "shutdown" ? "nav.lifecycleShutdown()" : "nav.lifecycleStartup()");
      return out(false);
    case "nav.cancel":
      L.push("nav.cancelTask()");
      return out(false);
    case "set":
      L.push(`ctx[${JSON.stringify(String(step.var))}] = ${pyValue(step.value)}`);
      return out(false);
    case "log":
      L.push(`print(${JSON.stringify(`[${String(step.level ?? "info")}]`)}, ${pyValue(step.text)})`);
      return out(false);
    case "wait":
      L.push(`time.sleep(float(${pyValue(step.seconds)}))`);
      return out(false);
    case "ask_user": {
      const opts = Array.isArray(step.options) ? step.options.map(String) : ["Continue", "Stop"];
      const dflt = typeof step.default === "string" ? step.default : opts[0]!;
      L.push(`answer = input(${pyStr(step.text)} + ${JSON.stringify(` [${opts.join("/")}] (default ${dflt}): `)}).strip()`);
      L.push(`value = answer if answer in ${pyLit(opts)} else ${JSON.stringify(dflt)}`);
      return out(false, true);
    }
    case "mqtt.publish":
      g.usesMqtt = true;
      L.push(`mqtt_publish(${pyValue(step.topic)}, ${pyValue(step.payload ?? "")}, qos=${typeof step.qos === "number" ? step.qos : 1}, retain=${step.retain ? "True" : "False"})`);
      return out(false);
    case "ros.publish":
      g.usesRos = true;
      L.push(`ros_publish(nav, ${pyValue(step.topic)}, ${pyValue(step.msg_type)}, ${pyValue(step.message ?? {})})`);
      return out(false);
    case "ros.call_service":
      g.usesRos = true;
      g.usesRosService = true;
      L.push(`value = ros_call_service(nav, ${pyValue(step.service)}, ${pyValue(step.srv_type)}, ${pyValue(step.request ?? {})})`);
      L.push("ok = value is not None");
      return out(true, true);
    case "end":
      // handled by the caller
      return out(false);
    case "break":
      L.push("break");
      return out(false);
    default: {
      g.todo++;
      L.push(`# TODO: step "${String(step.id ?? "")}" (${step.type}) is not supported by the exporter; implement it by hand:`);
      for (const line of JSON.stringify(step, null, 2).split("\n")) L.push(`#   ${line}`);
      L.push("ok = True");
      L.push("value = None");
      return out(true, true);
    }
  }
}

function emitSteps(g: Gen, steps: Step[], depth: number, ctxName: "run" | "abort"): string[] {
  const out: string[] = [];
  const pad = IND.repeat(depth);
  for (const step of steps) {
    const title = `${JSON.stringify(String(step.id ?? ""))}: ${stepSummary(step, { mission: g.mission })}`;
    if (step.enabled === false) {
      out.push(`${pad}# --- step ${title} (disabled)`);
      continue;
    }
    out.push(`${pad}# --- step ${title}`);
    if (step.type === "if") {
      out.push(`${pad}if ev(${JSON.stringify(String(step.condition ?? "False"))}, ctx):`);
      out.push(...bodyOrPass(emitSteps(g, listOf(step.then), depth + 1, ctxName), depth + 1));
      const els = listOf(step.else);
      if (els.length > 0) {
        out.push(`${pad}else:`);
        out.push(...emitSteps(g, els, depth + 1, ctxName));
      }
      continue;
    }
    if (step.type === "loop") {
      if (step.count !== undefined) out.push(`${pad}for _i in range(int(${pyValue(step.count)})):`);
      else if (typeof step.while === "string" && step.while.trim() !== "") out.push(`${pad}while ev(${JSON.stringify(step.while)}, ctx):`);
      else out.push(`${pad}while True:`);
      out.push(...bodyOrPass(emitSteps(g, listOf(step.body), depth + 1, ctxName), depth + 1));
      continue;
    }
    if (step.type === "end") {
      const msg = typeof step.message === "string" ? step.message : "";
      if (step.result === "failed") out.push(`${pad}return fail(nav, ctx, ${JSON.stringify(String(step.id ?? ""))}, ${pyStr(msg || "ended with failure")})`);
      else {
        if (msg) out.push(`${pad}print(${pyValue(msg)})`);
        out.push(`${pad}return 0`);
      }
      continue;
    }
    const act = emitAction(g, step);
    const retry = isRecord(step.on_fail) && typeof step.on_fail.retry === "number" ? Math.max(0, Math.trunc(step.on_fail.retry)) : 0;
    const delay = isRecord(step.on_fail) && typeof step.on_fail.retry_delay_s === "number" ? step.on_fail.retry_delay_s : 0;
    const before = isRecord(step.on_fail) ? listOf(step.on_fail.before_retry) : [];
    const cont = isRecord(step.on_fail) && step.on_fail.then === "continue";
    const sid = JSON.stringify(String(step.id ?? ""));

    if (!act.canFail) {
      out.push(`${pad}t0 = time.time()`);
      if (!act.hasValue) out.push(`${pad}value = None`);
      out.push(...act.lines.map((l) => pad + l));
      if (step.type !== "break") out.push(`${pad}ctx["last"] = result(True, value, "", t0)`);
      if (typeof step.out === "string" && step.type !== "break") out.push(`${pad}ctx[${JSON.stringify(step.out)}] = ctx["last"]`);
      continue;
    }

    const inner = retry > 0 ? pad + IND : pad;
    if (retry > 0) out.push(`${pad}for attempt in range(${retry + 1}):`);
    out.push(`${inner}t0 = time.time()`);
    if (!act.hasValue) out.push(`${inner}value = None`);
    out.push(...act.lines.map((l) => inner + l));
    if (retry > 0) {
      out.push(`${inner}if ok:`);
      out.push(`${inner}${IND}break`);
      out.push(`${inner}if attempt < ${retry}:`);
      out.push(`${inner}${IND}print(${JSON.stringify(`step ${String(step.id ?? "")} failed, retrying`)}, attempt + 1, "of", ${retry})`);
      if (before.length > 0) out.push(...emitSteps(g, before, depth + 2, ctxName));
      if (delay > 0) out.push(`${inner}${IND}time.sleep(${delay})`);
    }
    out.push(`${pad}ctx["last"] = result(ok, value, "" if ok else ${JSON.stringify(`${step.type} failed`)}, t0)`);
    if (typeof step.out === "string") out.push(`${pad}ctx[${JSON.stringify(step.out)}] = ctx["last"]`);
    if (ctxName === "run") {
      if (cont) out.push(`${pad}# on_fail: continue`);
      else {
        out.push(`${pad}if not ok:`);
        out.push(`${pad}${IND}return fail(nav, ctx, ${sid}, ctx["last"]["error"])`);
      }
    }
  }
  return out;
}

function bodyOrPass(lines: string[], depth: number): string[] {
  return lines.length > 0 ? lines : [`${IND.repeat(depth)}pass`];
}

function listOf(v: unknown): Step[] {
  return Array.isArray(v) ? (v as Step[]) : [];
}

const HELPERS = `

def make_pose(nav, x, y, yaw_deg=0.0, frame="map"):
    p = PoseStamped()
    p.header.frame_id = frame
    p.header.stamp = nav.get_clock().now().to_msg()
    p.pose.position.x = float(x)
    p.pose.position.y = float(y)
    yaw = math.radians(float(yaw_deg))
    p.pose.orientation.z = math.sin(yaw / 2.0)
    p.pose.orientation.w = math.cos(yaw / 2.0)
    return p


def site(nav, name, yaw_deg=None):
    if name not in SITES:
        raise KeyError(f"unknown site '{name}' (known: {', '.join(SITES) or 'none'})")
    x, y, yaw = SITES[name]
    return make_pose(nav, x, y, yaw if yaw_deg is None else yaw_deg)


def pose_of(nav, spec, ctx):
    """Resolve a mission pose (site name, {x, y, yaw_deg}, {site}, [x, y], $expr) to a PoseStamped."""
    spec = val(spec, ctx)
    if isinstance(spec, PoseStamped):
        return spec
    if isinstance(spec, str):
        return site(nav, spec)
    if isinstance(spec, (list, tuple)):
        return make_pose(nav, spec[0], spec[1], spec[2] if len(spec) > 2 else 0.0)
    if isinstance(spec, dict):
        if "site" in spec:
            return site(nav, spec["site"], spec.get("yaw_deg"))
        return make_pose(nav, spec["x"], spec["y"], spec.get("yaw_deg", 0.0), spec.get("frame", "map"))
    raise ValueError(f"not a pose: {spec!r}")


def make_path(nav, points, spacing=0.05, from_robot=True, ctx=None):
    """Straight-segment nav_msgs/Path through points (like follow_path.py)."""
    poses = [pose_of(nav, p, ctx or {}) for p in points]
    if from_robot:
        robot = robot_pose(nav)
        if robot is not None:
            poses.insert(0, robot)
    path = Path()
    path.header.frame_id = "map"
    path.header.stamp = nav.get_clock().now().to_msg()
    for a, b in zip(poses, poses[1:]):
        ax, ay = a.pose.position.x, a.pose.position.y
        bx, by = b.pose.position.x, b.pose.position.y
        dist = math.hypot(bx - ax, by - ay)
        n = max(1, int(dist / spacing))
        yaw = math.atan2(by - ay, bx - ax)
        for i in range(n):
            t = i / n
            path.poses.append(make_pose(nav, ax + (bx - ax) * t, ay + (by - ay) * t, math.degrees(yaw)))
    if poses:
        path.poses.append(poses[-1])
    return path


def robot_pose(nav):
    """Current robot pose from TF (map -> base_link), or None when unknown."""
    try:
        from tf2_ros import Buffer, TransformListener
    except ImportError:
        return None
    if not hasattr(nav, "_mission_tf"):
        nav._mission_tf = Buffer()
        nav._mission_tf_listener = TransformListener(nav._mission_tf, nav)
    deadline = time.time() + 2.0
    while time.time() < deadline:
        rclpy.spin_once(nav, timeout_sec=0.1)
        try:
            tf = nav._mission_tf.lookup_transform("map", "base_link", rclpy.time.Time())
        except Exception:  # noqa: BLE001 - not available yet
            continue
        q = tf.transform.rotation
        yaw = math.atan2(2.0 * (q.w * q.z + q.x * q.y), 1.0 - 2.0 * (q.y * q.y + q.z * q.z))
        return make_pose(nav, tf.transform.translation.x, tf.transform.translation.y, math.degrees(yaw))
    return None


def wait_task(nav):
    """Spin until the current Nav2 task finishes; returns True on SUCCEEDED."""
    while not nav.isTaskComplete():
        fb = nav.getFeedback()
        if fb is not None and hasattr(fb, "distance_remaining"):
            print(f"  {fb.distance_remaining:.2f} m left", end="\\r", flush=True)
        time.sleep(0.2)
    print()
    return nav.getResult() == TaskResult.SUCCEEDED


def result(ok, value=None, error="", t0=None):
    return {
        "ok": bool(ok),
        "status": "succeeded" if ok else "failed",
        "value": value,
        "error": error,
        "duration_s": round(time.time() - t0, 3) if t0 else 0.0,
    }


def ref(obj, *keys):
    """Nested lookup tolerant of missing keys (ctx["goal"]["x"] -> ref(ctx, "goal", "x"))."""
    for k in keys:
        if obj is None:
            return None
        if isinstance(obj, dict):
            obj = obj.get(k)
        elif isinstance(obj, (list, tuple)):
            try:
                obj = obj[int(k)]
            except (IndexError, ValueError, TypeError):
                return None
        else:
            obj = getattr(obj, str(k), None)
    return obj


class _Ns(dict):
    """dict with attribute access so expressions can write payload.pose.x"""

    def __getattr__(self, name):
        return _wrap(self.get(name))


def _wrap(v):
    if isinstance(v, dict) and not isinstance(v, _Ns):
        return _Ns(v)
    return v


def _xy(p):
    if isinstance(p, dict):
        return float(p["x"]), float(p["y"])
    if hasattr(p, "pose"):
        return float(p.pose.position.x), float(p.pose.position.y)
    return float(p[0]), float(p[1])


def _text(v):
    if v is None:
        return ""
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, float) and v.is_integer():
        return str(int(v))
    return str(v)


FUNCS = {
    "abs": abs, "min": min, "max": max, "len": len, "round": round, "int": int, "float": float, "str": str, "bool": bool,
    "lower": lambda s: str(s).lower(), "upper": lambda s: str(s).upper(), "now": time.time,
    "distance": lambda a, b: math.hypot(_xy(a)[0] - _xy(b)[0], _xy(a)[1] - _xy(b)[1]),
    "hypot": math.hypot, "sqrt": math.sqrt,
    "get": lambda o, k, d=None: o.get(k, d) if isinstance(o, dict) else d,
    "true": True, "false": False, "null": None,
}

_DOLLAR_RE = re.compile(r"\\$(\\.|[A-Za-z_])")
_REF_RE = re.compile(r"^\\$([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z_][A-Za-z0-9_]*|\\[[0-9]+\\])*)$")
_WHOLE_RE = re.compile(r"^\\$\\{([^{}]*)\\}$")
_INTERP_RE = re.compile(r"\\$\\{([^{}]*)\\}")


def _preprocess(expr):
    """Rewrite $name -> name and $.field -> payload.field outside string literals."""
    out, i, quote = [], 0, None
    while i < len(expr):
        c = expr[i]
        if quote:
            out.append(c)
            if c == "\\\\" and i + 1 < len(expr):
                out.append(expr[i + 1])
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in ("'", '"'):
            quote = c
            out.append(c)
            i += 1
            continue
        if c == "$":
            m = _DOLLAR_RE.match(expr, i)
            if m:
                if m.group(1) == ".":
                    out.append("payload.")
                    i += 2
                else:
                    i += 1
                continue
        out.append(c)
        i += 1
    return "".join(out)


def ev(expr, ctx):
    """Evaluate a mission expression with ctx as variables (restricted eval)."""
    ns = {k: _wrap(v) for k, v in ctx.items()}
    ns["sites"] = _Ns({k: {"x": v[0], "y": v[1], "yaw_deg": v[2]} for k, v in SITES.items()})
    ns.update(FUNCS)
    return eval(_preprocess(expr), {"__builtins__": {}}, ns)  # noqa: S307 - namespace is restricted


def val(v, ctx):
    """Resolve "$x", "\${...}", "text \${x}" like the runner; dicts and lists recursively."""
    if isinstance(v, str):
        m = _REF_RE.match(v)
        if m:
            return ev(m.group(1), ctx)
        m = _WHOLE_RE.match(v)
        if m:
            return ev(m.group(1), ctx)
        if "\${" in v:
            return _INTERP_RE.sub(lambda mm: _text(ev(mm.group(1), ctx)), v)
        return v
    if isinstance(v, dict):
        return {k: val(x, ctx) for k, x in v.items()}
    if isinstance(v, list):
        return [val(x, ctx) for x in v]
    return v
`;

const MQTT_HELPERS = `

_mqtt = None


def mqtt_client():
    """paho client set up from MQTT_HOST, MQTT_PORT, MQTT_USER, MQTT_PASS."""
    global _mqtt
    if _mqtt is None:
        _mqtt = mqtt.Client()
        user, password = os.environ.get("MQTT_USER"), os.environ.get("MQTT_PASS")
        if user:
            _mqtt.username_pw_set(user, password)
        _mqtt.connect(os.environ.get("MQTT_HOST", "localhost"), int(os.environ.get("MQTT_PORT", "1883")), 30)
        _mqtt.loop_start()
    return _mqtt


def mqtt_publish(topic, payload, qos=1, retain=False):
    if not isinstance(payload, (str, bytes)):
        payload = json.dumps(payload)
    mqtt_client().publish(topic, payload, qos=qos, retain=retain).wait_for_publish(5.0)
`;

const ROS_HELPERS = `

def ros_publish(nav, topic, msg_type, fields):
    msg_cls = get_message(msg_type)
    pub = nav.create_publisher(msg_cls, topic, 10)
    msg = msg_cls()
    set_message_fields(msg, fields)
    time.sleep(0.2)  # let subscribers connect
    pub.publish(msg)
    nav.destroy_publisher(pub)
`;

const ROS_SERVICE_HELPERS = `

def ros_call_service(nav, service, srv_type, fields, timeout=5.0):
    """Call a service; returns the response or None."""
    srv_cls = get_service(srv_type)
    client = nav.create_client(srv_cls, service)
    try:
        if not client.wait_for_service(timeout_sec=timeout):
            print(f"service {service} not available", file=sys.stderr)
            return None
        req = srv_cls.Request()
        set_message_fields(req, fields)
        fut = client.call_async(req)
        rclpy.spin_until_future_complete(nav, fut, timeout_sec=60.0)
        return fut.result()
    finally:
        nav.destroy_client(client)
`;

export function generatePython(mission: Mission, opts: PythonOptions = {}): string {
  const g: Gen = { mission, usesMqtt: false, usesRos: false, usesRosService: false, todo: 0 };
  const name = mission.name;
  const version = mission.version ?? 1;
  const fileName = opts.fileName ?? `${name}.json`;

  // steps first so we know which helpers are needed
  const runLines = emitSteps(g, mission.flow ?? [], 1, "run");
  const abortLines = emitSteps(g, mission.on_abort ?? [], 1, "abort");

  const sites = opts.sites ?? null;
  const activeMap = opts.activeMap ?? sites?.default_map ?? (sites ? Object.keys(sites.maps)[0] : undefined) ?? null;
  const siteEntries: string[] = [];
  if (sites && activeMap && sites.maps[activeMap]) {
    for (const [n, s] of Object.entries(sites.maps[activeMap]!.sites ?? {})) siteEntries.push(`    ${JSON.stringify(n)}: (${s.x}, ${s.y}, ${s.yaw_deg ?? 0}),`);
  }
  const mapEntries: string[] = [];
  if (sites) for (const [n, m] of Object.entries(sites.maps)) if (m.file) mapEntries.push(`    ${JSON.stringify(n)}: ${JSON.stringify(m.file)},`);

  const ctxInit: string[] = [];
  for (const [k, inp] of Object.entries(mission.inputs ?? {})) ctxInit.push(`${JSON.stringify(k)}: ${pyLit(inp.default ?? null)}`);
  for (const [k, v] of Object.entries(mission.vars ?? {})) ctxInit.push(`${JSON.stringify(k)}: ${pyLit(v)}`);

  const imports = ["import json, math, os, re, sys, time", "import rclpy", "from geometry_msgs.msg import PoseStamped", "from nav_msgs.msg import Path", "from nav2_simple_commander.robot_navigator import BasicNavigator, TaskResult"];
  if (g.usesMqtt) imports.push("import paho.mqtt.client as mqtt");
  if (g.usesRos) {
    imports.push(g.usesRosService ? "from rosidl_runtime_py.utilities import get_message, get_service" : "from rosidl_runtime_py.utilities import get_message");
    imports.push("from rosidl_runtime_py.set_message import set_message_fields");
  }

  const parts: string[] = [];
  parts.push("#!/usr/bin/env python3");
  parts.push(`"""${name} — generated by Mission Builder from ${fileName} (version ${version}). Edit freely.${mission.title ? `\n\n${mission.title}` : ""}${mission.description ? `\n${mission.description}` : ""}\n"""`);
  parts.push(imports.join("\n"));
  parts.push("");
  parts.push(`MISSION = ${JSON.stringify(name)}`);
  parts.push(`CURRENT_MAP = ${activeMap ? JSON.stringify(activeMap) : "None"}`);
  parts.push(`SITES = {${siteEntries.length ? `\n${siteEntries.join("\n")}\n` : ""}}  # from the active map${activeMap ? ` '${activeMap}'` : ""}`);
  parts.push(`MAPS = {${mapEntries.length ? `\n${mapEntries.join("\n")}\n` : ""}}  # map name -> yaml on the robot`);
  parts.push(HELPERS.trimEnd());
  if (g.usesMqtt) parts.push(MQTT_HELPERS.trimEnd());
  if (g.usesRos) parts.push(ROS_HELPERS.trimEnd());
  if (g.usesRosService) parts.push(ROS_SERVICE_HELPERS.trimEnd());

  parts.push("");
  parts.push("");
  parts.push("def on_abort(nav, ctx):");
  parts.push('    """Cleanup steps when the run fails or is canceled."""');
  parts.push(...(abortLines.length ? abortLines : ["    pass"]));
  parts.push("");
  parts.push("");
  parts.push("def fail(nav, ctx, step_id, error):");
  parts.push('    print(f"step {step_id} failed: {error}", file=sys.stderr)');
  parts.push("    nav.cancelTask()");
  parts.push("    on_abort(nav, ctx)");
  parts.push("    return 1");
  parts.push("");
  parts.push("");
  parts.push("def run(nav, ctx):");
  parts.push(...(runLines.length ? runLines : ["    pass"]));
  parts.push("    return 0");
  parts.push("");
  parts.push("");
  parts.push("def main():");
  parts.push("    rclpy.init()");
  parts.push("    nav = BasicNavigator()");
  parts.push(`    ctx = {${ctxInit.join(", ")}}  # inputs defaults + vars`);
  parts.push('    ctx.update({"mission": MISSION, "current_map": CURRENT_MAP, "last": None, "robot": None})');
  parts.push("    for arg in sys.argv[1:]:  # override inputs: python script.py rounds=3");
  parts.push('        k, _, v = arg.partition("=")');
  parts.push("        try:");
  parts.push("            ctx[k] = json.loads(v)");
  parts.push("        except ValueError:");
  parts.push("            ctx[k] = v");
  parts.push("    try:");
  parts.push("        rc = run(nav, ctx)");
  parts.push("    except KeyboardInterrupt:");
  parts.push("        nav.cancelTask()");
  parts.push("        on_abort(nav, ctx)");
  parts.push("        rc = 130");
  parts.push("    finally:");
  if (g.usesMqtt) {
    parts.push("        if _mqtt is not None:");
    parts.push("            _mqtt.loop_stop()");
    parts.push("            _mqtt.disconnect()");
  }
  parts.push("        nav.destroy_node()");
  parts.push("        rclpy.shutdown()");
  parts.push("    return rc");
  parts.push("");
  parts.push("");
  parts.push('if __name__ == "__main__":');
  parts.push("    sys.exit(main())");
  parts.push("");
  return parts.join("\n");
}
