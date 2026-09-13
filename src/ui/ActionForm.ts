/**
 * The forms for the actions on a stop, generated from the ported block
 * registry (`src/mission/blocks.ts`), and the grouped picker that adds one.
 *
 * The groups are named for what the operator wants to do, not for the step
 * type underneath; each entry names a step type and, where one picker entry
 * covers several event sources, the preset that distinguishes it.
 */

import { h, row } from "./dom";
import { icon } from "./icons";
import type { IconName } from "./icons";
import type { ParamDef } from "../mission/blocks";
import { blockDefOrUnknown, newEventSource, newStep, triggerDef } from "../mission/blocks";
import type { EventSource, Step } from "../mission/types";
import { isRecord } from "../mission/types";

export interface FormContext {
  siteNames: string[];
  mapNames: string[];
  connectorNames: string[];
  missionNames: string[];
  /** The project's request and answer topics (`ros.request` placeholders). */
  requestTopic: string;
  answerTopic: string;
}

export interface ActionChoice {
  label: string;
  type: string;
  /** Extra fields merged into the new step, e.g. which event a wait listens to. */
  preset?: Record<string, unknown>;
  /** Shown under the label when the choice has a consequence worth knowing. */
  note?: string;
}

export interface ActionGroup {
  name: string;
  icon: IconName;
  items: ActionChoice[];
}

/** The picker of the Route mode spec, in its order. */
export const ACTION_GROUPS: ActionGroup[] = [
  {
    name: "Send a signal",
    icon: "send",
    items: [
      { label: "MQTT message", type: "mqtt.publish" },
      { label: "Modbus coil or register", type: "modbus.write" },
      { label: "GPIO output", type: "gpio.write" },
      { label: "ROS topic", type: "ros.publish" },
    ],
  },
  {
    name: "Wait for something",
    icon: "hourglass",
    items: [
      { label: "MQTT message", type: "wait_event", preset: { source: { type: "mqtt.subscribe", connector: "", topic: "" } } },
      { label: "Modbus coil", type: "wait_event", preset: { source: { type: "modbus.poll", connector: "", kind: "coil", address: 0, when: "payload.value", edge: "rising" } } },
      { label: "GPIO input", type: "wait_event", preset: { source: { type: "gpio.input", pin: 17, gpio_edge: "falling" } } },
      { label: "ROS topic", type: "wait_event", preset: { source: { type: "ros.topic", topic: "" } } },
      { label: "Web call", type: "wait_event", preset: { source: { type: "http.webhook", path: "" } } },
      { label: "A delay", type: "wait" },
    ],
  },
  { name: "Ask a person", icon: "message", items: [{ label: "A question with buttons", type: "ask_user" }] },
  {
    name: "Robot",
    icon: "bot",
    items: [
      { label: "Dock", type: "nav.dock" },
      { label: "Undock", type: "nav.undock" },
      { label: "Spin", type: "nav.spin" },
      { label: "Back up", type: "nav.backup" },
      { label: "Clear costmaps", type: "nav.clear_costmap" },
      { label: "Change map", type: "nav.change_map" },
    ],
  },
  {
    name: "Call another system",
    icon: "globe",
    items: [
      { label: "HTTP request", type: "http.request" },
      { label: "ROS service", type: "ros.call_service" },
      { label: "ROS action", type: "ros.call_action" },
      { label: "Set a ROS parameter", type: "ros.set_param" },
    ],
  },
  {
    name: "Logic",
    icon: "variable",
    items: [
      { label: "Set a value", type: "set" },
      { label: "If", type: "if", note: "Control flow moves to Other steps when the mission is read back." },
      { label: "Loop", type: "loop", note: "Control flow moves to Other steps when the mission is read back." },
      { label: "Log", type: "log" },
      { label: "Run another mission", type: "run_mission" },
      { label: "End", type: "end" },
    ],
  },
];

/** Build the step a picker entry stands for. */
export function stepForChoice(choice: ActionChoice, id: string): Step {
  const step = newStep(choice.type, id);
  if (choice.preset) for (const [k, v] of Object.entries(choice.preset)) step[k] = JSON.parse(JSON.stringify(v)) as unknown;
  return step;
}

/** A grouped picker. `onPick` receives the chosen entry. */
export function actionPicker(onPick: (choice: ActionChoice) => void): HTMLElement {
  const wrap = h("div", { class: "picker" });
  for (const group of ACTION_GROUPS) {
    const items = h("div", { class: "picker-items" });
    for (const item of group.items) {
      const btn = h("button", { class: "picker-item", title: item.note ?? blockDefOrUnknown(item.type).help }, h("span", { text: item.label }));
      btn.addEventListener("click", () => onPick(item));
      items.appendChild(btn);
    }
    wrap.append(h("div", { class: "picker-group" }, icon(group.icon), h("span", { text: group.name })), items);
  }
  return wrap;
}

/** Every editable parameter of a step, advanced ones behind a toggle. */
export function actionForm(step: Step, ctx: FormContext, onChange: (key: string, value: unknown) => void): HTMLElement {
  const def = blockDefOrUnknown(step.type);
  const body = h("div", { class: "action-form" });
  const advanced: HTMLElement[] = [];
  for (const p of def.params) {
    const el = paramRow(p, step[p.key], ctx, (v) => onChange(p.key, v));
    if (p.advanced) advanced.push(el);
    else body.appendChild(el);
  }
  const nameRow = row("Name", textInput(typeof step.name === "string" ? step.name : "", "(step label)", (v) => onChange("name", v === "" ? undefined : v)));
  body.appendChild(nameRow);
  if (advanced.length) {
    const more = h("div", { class: "advanced" }, ...advanced);
    more.hidden = true;
    const toggle = h("button", { class: "link-btn" }, icon("sliders"), "Advanced");
    toggle.addEventListener("click", () => {
      more.hidden = !more.hidden;
    });
    body.append(toggle, more);
  }
  return body;
}

function paramRow(def: ParamDef, value: unknown, ctx: FormContext, onChange: (v: unknown) => void): HTMLElement {
  if (def.kind === "event_source") {
    return h("div", { class: "sub-form" }, h("div", { class: "sub-title", text: def.label }), eventSourceForm(isRecord(value) ? (value as EventSource) : newEventSource("ros.topic"), ctx, onChange));
  }
  const control = row(def.label, paramControl(def, value, ctx, onChange));
  if (!def.note) return control;
  return h("div", { class: "param-with-note" }, control, h("p", { class: "prose muted", text: def.note }));
}

/** One control for one parameter. Shapes without a dedicated editor fall back to JSON. */
export function paramControl(def: ParamDef, value: unknown, ctx: FormContext, onChange: (v: unknown) => void): HTMLElement {
  switch (def.kind) {
    case "number":
    case "integer": {
      if (typeof value === "string") return textInput(value, def.placeholder ?? "$expression", (v) => onChange(v));
      const inp = h("input", { type: "number", value: value === undefined ? "" : String(value) });
      if (def.min !== undefined) inp.min = String(def.min);
      if (def.max !== undefined) inp.max = String(def.max);
      if (def.step !== undefined) inp.step = String(def.step);
      if (def.placeholder !== undefined) inp.placeholder = def.placeholder;
      inp.addEventListener("change", () => {
        const n = parseFloat(inp.value);
        onChange(Number.isFinite(n) ? (def.kind === "integer" ? Math.round(n) : n) : undefined);
      });
      return inp;
    }
    case "boolean": {
      const chk = h("input", { type: "checkbox" });
      chk.checked = value === true;
      chk.addEventListener("change", () => onChange(chk.checked));
      return chk;
    }
    case "select":
      return selectInput(def.options ?? [], typeof value === "string" ? value : String(def.default ?? ""), false, (v) => onChange(v));
    case "site":
      return selectInput(ctx.siteNames, typeof value === "string" ? value : "", true, (v) => onChange(v === "" && !def.required ? undefined : v));
    case "sites":
      return sitesListControl(Array.isArray(value) ? value.map(String) : [], ctx, onChange);
    case "map":
      return selectInput(ctx.mapNames, typeof value === "string" ? value : "", true, (v) => onChange(v));
    case "connector":
      return selectInput(ctx.connectorNames, typeof value === "string" ? value : "", true, (v) => onChange(v));
    case "text": {
      const ta = h("textarea", { rows: 2, placeholder: def.placeholder ?? "" });
      ta.value = typeof value === "string" ? value : "";
      ta.addEventListener("change", () => onChange(ta.value));
      return ta;
    }
    case "options": {
      const list = Array.isArray(value) ? value.map(String).join(", ") : "";
      return textInput(list, "Yes, No", (v) => onChange(v.split(",").map((s) => s.trim()).filter((s) => s !== "")));
    }
    case "value": {
      // A value may be any JSON; plain text stays plain text.
      const text = typeof value === "string" ? value : value === undefined ? "" : JSON.stringify(value);
      return textInput(text, def.placeholder ?? "", (v) => onChange(parseValue(v)));
    }
    case "expression":
    case "string":
      return textInput(typeof value === "string" ? value : "", def.placeholder ?? "", (v) => onChange(v));
    case "pose":
      return poseControl(value, ctx, onChange);
    default: {
      // pose, poses, points, json, steps, behavior_tree: edited as JSON.
      const ta = h("textarea", { rows: 3, class: "mono", placeholder: "JSON" });
      ta.value = value === undefined ? "" : JSON.stringify(value, null, value && typeof value === "object" ? 0 : undefined);
      ta.addEventListener("change", () => {
        if (ta.value.trim() === "") {
          onChange(undefined);
          ta.classList.remove("bad");
          return;
        }
        try {
          onChange(JSON.parse(ta.value));
          ta.classList.remove("bad");
        } catch {
          ta.classList.add("bad");
        }
      });
      return ta;
    }
  }
}

/**
 * A pose: usually one of the map's points, sometimes coordinates or an
 * expression. The dropdown covers the common case; anything else falls back to
 * the raw JSON, so nothing a mission already says is lost.
 */
function poseControl(value: unknown, ctx: FormContext, onChange: (v: unknown) => void): HTMLElement {
  const wrap = h("div", { class: "pose-control" });
  const site = typeof value === "string" && !value.startsWith("$") && value !== "" ? value : isRecord(value) && typeof value.site === "string" && !value.site.startsWith("$") ? value.site : "";
  const sel = h("select");
  sel.appendChild(h("option", { value: "", text: "Coordinates or expression" }));
  for (const o of ctx.siteNames.includes(site) || site === "" ? ctx.siteNames : [...ctx.siteNames, site]) sel.appendChild(h("option", { value: o, text: o }));
  sel.value = site;

  const raw = h("input", { type: "text", class: "mono", placeholder: '$pickup or {"x": 1, "y": 0.5}' });
  raw.value = site === "" ? (value === undefined ? "" : typeof value === "string" ? value : JSON.stringify(value)) : "";
  raw.hidden = site !== "";
  raw.addEventListener("change", () => {
    const text = raw.value.trim();
    if (text === "") {
      onChange(undefined);
      return;
    }
    if (text.startsWith("{") || text.startsWith("[")) {
      try {
        onChange(JSON.parse(text));
        raw.classList.remove("bad");
      } catch {
        raw.classList.add("bad");
      }
      return;
    }
    raw.classList.remove("bad");
    onChange(text);
  });

  sel.addEventListener("change", () => {
    if (sel.value === "") {
      raw.hidden = false;
      raw.focus();
      return;
    }
    raw.hidden = true;
    // Keep the shape the mission already used, so a yaw override survives.
    if (isRecord(value) && typeof value.site === "string") onChange({ ...value, site: sel.value });
    else onChange(sel.value);
  });
  wrap.append(sel, raw);
  return wrap;
}

/**
 * An ordered list of points (a Follow route's `through`): one row per point
 * with up, down and remove, and a dropdown that appends one. An empty list is
 * removed from the step rather than written as `[]`.
 */
function sitesListControl(list: string[], ctx: FormContext, onChange: (v: unknown) => void): HTMLElement {
  const wrap = h("div", { class: "list-control" });
  const emit = (next: string[]): void => onChange(next.length === 0 ? undefined : next);
  list.forEach((name, i) => {
    const up = h("button", { class: "icon-only", title: `Visit ${name} earlier` }, icon("arrowUp"));
    up.disabled = i === 0;
    up.addEventListener("click", () => {
      const next = list.slice();
      [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
      emit(next);
    });
    const down = h("button", { class: "icon-only", title: `Visit ${name} later` }, icon("arrowDown"));
    down.disabled = i === list.length - 1;
    down.addEventListener("click", () => {
      const next = list.slice();
      [next[i + 1], next[i]] = [next[i]!, next[i + 1]!];
      emit(next);
    });
    const del = h("button", { class: "icon-only danger", title: `Do not pass ${name}` }, icon("close"));
    del.addEventListener("click", () => emit(list.filter((_, j) => j !== i)));
    const known = ctx.siteNames.includes(name);
    wrap.append(h("div", { class: `list-item${known ? "" : " bad"}`, title: known ? "" : `${name} is not a point on this map.` }, h("span", { class: "list-no", text: String(i + 1) }), h("span", { class: "list-name", text: name }), up, down, del));
  });
  const add = h("select");
  add.appendChild(h("option", { value: "", text: list.length === 0 ? "Pass through a point…" : "Add another point…" }));
  for (const name of ctx.siteNames) add.appendChild(h("option", { value: name, text: name }));
  add.addEventListener("change", () => {
    if (add.value !== "") emit([...list, add.value]);
  });
  wrap.append(add);
  return wrap;
}

/** The parameters of the event a `wait_event` listens to. */
function eventSourceForm(source: EventSource, ctx: FormContext, onChange: (v: EventSource) => void): HTMLElement {
  const wrap = h("div");
  const def = triggerDef(source.type);
  const patch = (key: string, v: unknown): void => {
    const next: EventSource = { ...source };
    if (v === undefined) delete next[key];
    else next[key] = v;
    onChange(next);
  };
  wrap.appendChild(row("Event", h("span", { class: "stats", text: def?.label ?? source.type })));
  for (const p of def?.params ?? []) wrap.appendChild(row(p.label, paramControl(p, source[p.key], ctx, (v) => patch(p.key, v))));
  wrap.appendChild(row("Only when", textInput(typeof source.when === "string" ? source.when : "", "payload.value", (v) => patch("when", v === "" ? undefined : v))));
  wrap.appendChild(row("Edge", selectInput(["any", "rising"], typeof source.edge === "string" ? source.edge : "any", false, (v) => patch("edge", v === "any" ? undefined : v))));
  return wrap;
}

// ---- small control builders --------------------------------------------------

export function textInput(value: string, placeholder: string, onChange: (v: string) => void): HTMLInputElement {
  const inp = h("input", { type: "text", value, placeholder });
  inp.addEventListener("change", () => onChange(inp.value));
  return inp;
}

export function selectInput(options: readonly string[], value: string, allowEmpty: boolean, onChange: (v: string) => void): HTMLSelectElement {
  const sel = h("select");
  if (allowEmpty) sel.appendChild(h("option", { value: "", text: "(none)" }));
  const all = options.includes(value) || value === "" ? options : [...options, value];
  for (const o of all) sel.appendChild(h("option", { value: o, text: o }));
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  return sel;
}

/** `true`, `12`, `{"a":1}` become their JSON value; anything else stays text. */
function parseValue(text: string): unknown {
  const t = text.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  if (t.startsWith("{") || t.startsWith("[") || t.startsWith('"')) {
    try {
      return JSON.parse(t);
    } catch {
      return text;
    }
  }
  return text;
}
