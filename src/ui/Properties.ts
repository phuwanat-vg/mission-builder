/**
 * The right column: whatever is selected, edited in place.
 *
 * A tree node, a point or a lane all land here. The per-step forms are
 * generated from the ported block registry (`ActionForm.ts`); the lane
 * configuration below is written by hand because direction, blocked, speed cap
 * and cost are the four things an operator actually reasons about.
 */

import { h, row } from "./dom";
import { icon } from "./icons";
import { actionForm, selectInput, textInput } from "./ActionForm";
import type { FormContext } from "./ActionForm";
import { paramControl } from "./ActionForm";
import type { RouteStore } from "../mission/RouteStore";
import type { Edge, Finding, Mission, Site, Step, Trigger } from "../mission/types";
import { POLICIES, SITE_KINDS, INPUT_TYPES } from "../mission/types";
import { blockDefOrUnknown, triggerDef, triggerSummary } from "../mission/blocks";
import { getStepAt } from "../mission/ids";
import { buildTree, findNode } from "../mission/tree";
import type { TreeNode } from "../mission/tree";
import { pathToString } from "../mission/validate";

export interface PropertiesHost {
  store: RouteStore;
  formContext(): FormContext;
  /** Validation findings for the open mission. */
  findings(): readonly Finding[];
  /** Redraw the tree and the map after a change made here. */
  refresh(): void;
  /** Ask the map to move the camera onto a point. */
  focusPoint(name: string): void;
  toast(message: string, kind?: "error" | "info"): void;
}

export class Properties {
  readonly element: HTMLElement;
  #host: PropertiesHost;
  #body: HTMLElement;
  #title: HTMLElement;

  constructor(host: PropertiesHost) {
    this.#host = host;
    this.#title = h("span", { class: "col-title", text: "Nothing selected" });
    this.#body = h("div", { class: "props-body" });
    this.element = h("div", { class: "props-col" }, h("div", { class: "col-head" }, this.#title, h("div", { class: "spacer" })), this.#body);
  }

  render(): void {
    const store = this.#host.store;
    const sel = store.selection;
    if (sel.kind === "point") return this.#renderPoint(sel.name);
    if (sel.kind === "lane") return this.#renderLane(sel.index);
    if (sel.kind === "node") return this.#renderNode(sel.id);
    this.#title.textContent = "Nothing selected";
    this.#body.replaceChildren(
      h("p", { class: "prose", text: "Pick something in the tree on the left, or a point or a lane on the map, and it is edited here." }),
    );
  }

  // ---- tree nodes ---------------------------------------------------------

  #renderNode(id: string): void {
    const store = this.#host.store;
    const mission = store.mission;
    const tree = buildTree(mission);
    const node = tree ? findNode(tree, id) : null;
    if (!mission || !node) {
      this.#title.textContent = "Nothing selected";
      this.#body.replaceChildren(h("p", { class: "prose", text: "That part of the mission is no longer there." }));
      return;
    }
    this.#title.textContent = node.label;
    switch (node.kind) {
      case "mission":
        return this.#renderMission(mission);
      case "settings":
        return this.#renderSettings(mission);
      case "trigger":
        return this.#renderTrigger("triggers", node.index ?? 0);
      case "interrupt":
        return this.#renderTrigger("interrupts", node.index ?? 0);
      case "step":
        return this.#renderStep(node);
      default:
        return this.#renderContainer(node);
    }
  }

  #renderMission(mission: Mission): void {
    const store = this.#host.store;
    const body = h("div");
    body.append(
      row("Name", textInput(mission.name, "pickup_job", (v) => {
        store.setMissionField("name", v.trim(), "Rename mission");
        this.#host.refresh();
      })),
      row("Title", textInput(mission.title ?? "", "Pickup job", (v) => {
        store.setMissionField("title", v.trim() === "" ? undefined : v, "Change the title");
        this.#host.refresh();
      })),
    );
    const desc = h("textarea", { rows: 3, placeholder: "What this mission is for" });
    desc.value = mission.description ?? "";
    desc.addEventListener("change", () => {
      store.setMissionField("description", desc.value.trim() === "" ? undefined : desc.value, "Change the description");
      this.#host.refresh();
    });
    body.append(h("div", { class: "sub-title", text: "Description" }), desc);
    body.append(h("p", { class: "prose muted", text: "The name is the file name on the robot and the name of its ROS service. Lowercase letters, digits, underscore and hyphen." }));
    this.#appendFindings(body, [], mission);
    this.#body.replaceChildren(body);
  }

  #renderSettings(mission: Mission): void {
    const store = this.#host.store;
    const body = h("div");
    body.append(
      row(
        "When it is asked to start",
        selectInput(POLICIES, mission.policy ?? "queue", false, (v) => {
          store.setMissionField("policy", v === "queue" ? undefined : v, "Change the policy");
          this.#host.refresh();
        }),
      ),
    );
    const priority = h("input", { type: "number", min: 0, max: 100, value: String(mission.priority ?? 50) });
    priority.addEventListener("change", () => {
      const n = Math.round(Number(priority.value));
      store.setMissionField("priority", Number.isFinite(n) ? n : undefined, "Change the priority");
      this.#host.refresh();
    });
    body.append(row("Priority", priority));
    body.append(h("p", { class: "prose muted", text: policySentence(mission.policy ?? "queue") }));

    body.append(h("div", { class: "sub-title", text: "Inputs" }));
    const inputs = mission.inputs ?? {};
    if (Object.keys(inputs).length === 0) body.append(h("p", { class: "prose", text: "This mission takes no parameters." }));
    for (const [name, def] of Object.entries(inputs)) {
      const line = h("div", { class: "kv-row" });
      line.append(h("span", { class: "kv-key", text: name }));
      line.append(
        selectInput(INPUT_TYPES, def.type, false, (v) => {
          const next = { ...inputs, [name]: { ...def, type: v as (typeof INPUT_TYPES)[number] } };
          store.setMissionField("inputs", next, "Change an input");
          this.#host.refresh();
        }),
      );
      line.append(
        textInput(def.default === undefined ? "" : String(def.default), "default", (v) => {
          const next = { ...inputs, [name]: { ...def, default: v === "" ? undefined : v } };
          store.setMissionField("inputs", next, "Change an input");
          this.#host.refresh();
        }),
      );
      const del = h("button", { class: "icon-only danger", title: `Remove the input ${name}` }, icon("trash"));
      del.addEventListener("click", () => {
        const next = { ...inputs };
        delete next[name];
        store.setMissionField("inputs", Object.keys(next).length === 0 ? undefined : next, "Remove an input");
        this.#host.refresh();
      });
      line.append(del);
      body.append(line);
    }
    const addInput = h("button", {}, icon("plus"), "Add an input");
    addInput.addEventListener("click", () => {
      const name = uniqueKey(inputs, "value");
      store.setMissionField("inputs", { ...inputs, [name]: { type: "string" } }, "Add an input");
      this.#host.refresh();
    });
    body.append(h("div", { class: "row" }, addInput));

    body.append(h("div", { class: "sub-title", text: "Variables" }));
    const vars = mission.vars ?? {};
    if (Object.keys(vars).length === 0) body.append(h("p", { class: "prose", text: "This mission starts with no variables." }));
    for (const [name, value] of Object.entries(vars)) {
      const line = h("div", { class: "kv-row" });
      line.append(h("span", { class: "kv-key", text: name }));
      line.append(
        textInput(value === undefined ? "" : JSON.stringify(value), "value", (v) => {
          const next = { ...vars, [name]: parseLoose(v) };
          store.setMissionField("vars", next, "Change a variable");
          this.#host.refresh();
        }),
      );
      const del = h("button", { class: "icon-only danger", title: `Remove the variable ${name}` }, icon("trash"));
      del.addEventListener("click", () => {
        const next = { ...vars };
        delete next[name];
        store.setMissionField("vars", Object.keys(next).length === 0 ? undefined : next, "Remove a variable");
        this.#host.refresh();
      });
      line.append(del);
      body.append(line);
    }
    const addVar = h("button", {}, icon("plus"), "Add a variable");
    addVar.addEventListener("click", () => {
      const name = uniqueKey(vars, "count");
      store.setMissionField("vars", { ...vars, [name]: 0 }, "Add a variable");
      this.#host.refresh();
    });
    body.append(h("div", { class: "row" }, addVar));
    this.#body.replaceChildren(body);
  }

  #renderTrigger(kind: "triggers" | "interrupts", index: number): void {
    const store = this.#host.store;
    const mission = store.mission;
    const list: Trigger[] | undefined = kind === "triggers" ? mission?.triggers : mission?.interrupts;
    const trigger = list?.[index];
    if (!trigger) {
      this.#body.replaceChildren(h("p", { class: "prose", text: "That trigger is no longer there." }));
      return;
    }
    const ctx = this.#host.formContext();
    const def = triggerDef(trigger.type);
    const body = h("div");
    body.append(h("p", { class: "prose", text: def?.help ?? `The runner does not know the event type '${trigger.type}'.` }));
    body.append(row("Name", textInput(typeof trigger.name === "string" ? trigger.name : "", triggerSummary(trigger), (v) => {
      store.setTriggerParam(kind, index, "name", v.trim() === "" ? undefined : v);
      this.#host.refresh();
    })));
    for (const p of def?.params ?? []) {
      body.append(row(p.label, paramControl(p, trigger[p.key], ctx, (v) => {
        store.setTriggerParam(kind, index, p.key, v);
        this.#host.refresh();
      })));
    }
    body.append(row("Only when", textInput(typeof trigger.when === "string" ? trigger.when : "", "payload.value", (v) => {
      store.setTriggerParam(kind, index, "when", v.trim() === "" ? undefined : v);
      this.#host.refresh();
    })));
    body.append(row("Edge", selectInput(["any", "rising"], typeof trigger.edge === "string" ? trigger.edge : "any", false, (v) => {
      store.setTriggerParam(kind, index, "edge", v === "any" ? undefined : v);
      this.#host.refresh();
    })));
    if (kind === "interrupts") {
      body.append(row("Run this mission", textInput(typeof (trigger as { run?: string }).run === "string" ? (trigger as { run?: string }).run! : "", "go_charge", (v) => {
        store.setTriggerParam(kind, index, "run", v.trim());
        this.#host.refresh();
      })));
    }
    const on = h("input", { type: "checkbox" });
    on.checked = trigger.enabled !== false;
    on.addEventListener("change", () => {
      store.setTriggerParam(kind, index, "enabled", on.checked ? undefined : false);
      this.#host.refresh();
    });
    body.append(row("Armed", on));
    this.#appendFindings(body, [kind, index]);
    this.#body.replaceChildren(body);
  }

  #renderStep(node: TreeNode): void {
    const store = this.#host.store;
    const mission = store.mission;
    if (!mission || !node.path) return;
    const step = getStepAt(mission, node.path);
    if (!step) {
      this.#body.replaceChildren(h("p", { class: "prose", text: "That step is no longer there." }));
      return;
    }
    const def = blockDefOrUnknown(step.type);
    const ctx = this.#host.formContext();
    const body = h("div");
    body.append(h("div", { class: "props-type" }, icon(def.icon), h("span", { text: def.label }), h("span", { class: "props-typename", text: step.type })));
    body.append(h("p", { class: "prose", text: def.help }));

    body.append(actionForm(step, ctx, (key, value) => {
      store.setStepParam(step, key, value);
      this.#host.refresh();
    }));

    body.append(h("div", { class: "sub-title", text: "When it goes wrong" }));
    const onFail = step.on_fail ?? {};
    const retry = h("input", { type: "number", min: 0, max: 20, value: String(onFail.retry ?? 0) });
    retry.addEventListener("change", () => {
      const n = Math.max(0, Math.round(Number(retry.value) || 0));
      const next = { ...onFail, retry: n === 0 ? undefined : n };
      store.setStepParam(step, "on_fail", cleanOnFail(next), "Change the retries");
      this.#host.refresh();
    });
    body.append(row("Retries", retry));
    body.append(
      row(
        "Then",
        selectInput(["abort", "continue"], onFail.then ?? "abort", false, (v) => {
          const next = { ...onFail, then: v === "abort" ? undefined : ("continue" as const) };
          store.setStepParam(step, "on_fail", cleanOnFail(next), "Change what happens after a failure");
          this.#host.refresh();
        }),
      ),
    );
    const beforeRetry = Array.isArray(onFail.before_retry) ? onFail.before_retry.length : 0;
    const addFail = h("button", {}, icon("plus"), beforeRetry === 0 ? "Add a step to run before a retry" : `${beforeRetry} step${beforeRetry === 1 ? "" : "s"} run before a retry`);
    addFail.addEventListener("click", () => {
      const next = { ...onFail, before_retry: Array.isArray(onFail.before_retry) ? onFail.before_retry : ([] as Step[]) };
      store.setStepParam(step, "on_fail", next, "Add a clean-up level");
      this.#host.refresh();
      this.#host.toast("Use the plus on the step's 'When it fails' level to add the steps.", "info");
    });
    body.append(h("div", { class: "row" }, addFail));

    body.append(h("div", { class: "sub-title", text: "This step" }));
    const timeout = h("input", { type: "number", min: 0, value: step.timeout_s === undefined ? "" : String(step.timeout_s) });
    timeout.addEventListener("change", () => {
      const n = Number(timeout.value);
      store.setStepParam(step, "timeout_s", timeout.value === "" || !Number.isFinite(n) ? undefined : n, "Change the timeout");
      this.#host.refresh();
    });
    body.append(row("Give up after (s)", timeout));
    body.append(row("Store the result in", textInput(typeof step.out === "string" ? step.out : "", "(no variable)", (v) => {
      store.setStepParam(step, "out", v.trim() === "" ? undefined : v.trim(), "Change where the result goes");
      this.#host.refresh();
    })));
    const enabled = h("input", { type: "checkbox" });
    enabled.checked = step.enabled !== false;
    enabled.addEventListener("change", () => {
      if (node.path) store.setStepEnabled(node.path, enabled.checked);
      this.#host.refresh();
    });
    body.append(row("Turned on", enabled));
    body.append(h("div", { class: "row" }, h("span", { class: "stats", text: `Step id ${String(step.id ?? "(none)")}` })));
    this.#appendFindings(body, node.path, undefined, typeof step.id === "string" ? step.id : undefined);
    this.#body.replaceChildren(body);
  }

  #renderContainer(node: TreeNode): void {
    const body = h("div");
    body.append(h("p", { class: "prose", text: containerSentence(node) }));
    body.append(h("p", { class: "prose muted", text: `${node.children.length} ${node.children.length === 1 ? "item" : "items"} in this level. Use the plus on the row to add one.` }));
    this.#body.replaceChildren(body);
  }

  // ---- map objects --------------------------------------------------------

  #renderPoint(name: string): void {
    const store = this.#host.store;
    const site: Site | undefined = store.points[name];
    if (!site) {
      this.#title.textContent = "Nothing selected";
      this.#body.replaceChildren(h("p", { class: "prose", text: "That point is no longer on this map." }));
      return;
    }
    this.#title.textContent = name;
    const body = h("div");
    body.append(h("div", { class: "props-type" }, icon("mapPin"), h("span", { text: "Point" }), h("span", { class: "props-typename", text: store.mapName })));
    body.append(row("Name", textInput(name, "Conveyor1", (v) => {
      const next = store.renamePoint(name, v);
      if (next === name && v.trim() !== name) this.#host.toast(`There is already a point called ${v.trim()}.`);
      this.#host.refresh();
    })));
    body.append(row("Kind", selectInput(SITE_KINDS, site.kind ?? "waypoint", false, (v) => {
      store.setPointKind(name, v as (typeof SITE_KINDS)[number]);
      this.#host.refresh();
    })));
    const x = numberInput(site.x, (v) => {
      store.edit("Move point", () => store.movePoint(name, v, site.y));
      this.#host.refresh();
    });
    const y = numberInput(site.y, (v) => {
      store.edit("Move point", () => store.movePoint(name, site.x, v));
      this.#host.refresh();
    });
    body.append(row("X (m)", x), row("Y (m)", y));
    const yaw = h("input", { type: "number", step: 1, value: site.yaw_deg === undefined ? "" : String(site.yaw_deg), placeholder: "(no heading)" });
    yaw.addEventListener("change", () => {
      const n = Number(yaw.value);
      store.edit("Set heading", () => store.setPointYaw(name, yaw.value === "" || !Number.isFinite(n) ? null : n));
      this.#host.refresh();
    });
    body.append(row("Heading (deg)", yaw));

    const lanes = store.lanes.map((lane, index) => ({ lane, index })).filter(({ lane }) => lane.from === name || lane.to === name);
    body.append(h("div", { class: "sub-title", text: "Lanes here" }));
    if (lanes.length === 0) body.append(h("p", { class: "prose", text: "No lane reaches this point yet, so nothing can drive to it along the route graph." }));
    for (const { lane, index } of lanes) {
      const btn = h("button", { class: "list-row" }, icon("route"), h("span", { text: laneName(lane) }));
      btn.addEventListener("click", () => {
        store.select({ kind: "lane", index });
        this.#host.refresh();
      });
      body.append(btn);
    }

    const focus = h("button", {}, icon("locate"), "Show it on the map");
    focus.addEventListener("click", () => this.#host.focusPoint(name));
    const del = h("button", { class: "danger" }, icon("trash"), "Delete this point");
    del.addEventListener("click", () => {
      const refs = store.referencesTo(name);
      if (refs.length > 0 && !confirm(`${name} is used by ${refs.join(", ")}. Delete it anyway?`)) return;
      store.deletePoint(name);
      this.#host.refresh();
    });
    body.append(h("div", { class: "row buttons" }, focus, del));
    this.#body.replaceChildren(body);
  }

  /** Lane configuration: direction, blocked, speed cap and cost. */
  #renderLane(index: number): void {
    const store = this.#host.store;
    const lane: Edge | undefined = store.lanes[index];
    if (!lane) {
      this.#title.textContent = "Nothing selected";
      this.#body.replaceChildren(h("p", { class: "prose", text: "That lane is no longer on this map." }));
      return;
    }
    this.#title.textContent = laneName(lane);
    const body = h("div");
    body.append(h("div", { class: "props-type" }, icon("route"), h("span", { text: "Lane" }), h("span", { class: "props-typename", text: store.mapName })));

    const oneWay = lane.bidirectional === false;
    const direction = oneWay ? `one-${lane.from}` : "both";
    const options = ["both", `one-${lane.from}`, `one-${lane.to}`];
    const labels = new Map<string, string>([
      ["both", "Both ways"],
      [`one-${lane.from}`, `One way, ${lane.from} to ${lane.to}`],
      [`one-${lane.to}`, `One way, ${lane.to} to ${lane.from}`],
    ]);
    const sel = h("select");
    for (const o of options) sel.appendChild(h("option", { value: o, text: labels.get(o) ?? o }));
    sel.value = direction;
    sel.addEventListener("change", () => {
      const v = sel.value;
      if (v === "both") store.updateLane(index, { bidirectional: undefined }, "Make the lane two-way");
      else if (v === `one-${lane.from}`) store.updateLane(index, { bidirectional: false }, "Make the lane one-way");
      else {
        // "one way the other way" is the same lane with its ends swapped.
        store.edit("Reverse the lane", () => {
          const from = lane.from;
          lane.from = lane.to;
          lane.to = from;
          lane.bidirectional = false;
        });
      }
      this.#host.refresh();
    });
    body.append(row("Direction", sel));
    body.append(h("p", { class: "prose muted", text: oneWay ? `The robot may only drive from ${lane.from} to ${lane.to} on this lane.` : "The robot may drive this lane in either direction." }));

    const blocked = h("input", { type: "checkbox" });
    blocked.checked = lane.blocked === true;
    blocked.addEventListener("change", () => {
      store.updateLane(index, { blocked: blocked.checked ? true : undefined }, blocked.checked ? "Block the lane" : "Unblock the lane");
      this.#host.refresh();
    });
    body.append(row("Blocked", blocked));
    body.append(h("p", { class: "prose muted", text: "A blocked lane is closed temporarily. The planner routes around it and it is drawn as a dashed red line." }));

    const speed = h("input", { type: "number", min: 0, step: 0.05, value: lane.speed_mps === undefined ? "" : String(lane.speed_mps), placeholder: "(no cap)" });
    speed.addEventListener("change", () => {
      const n = Number(speed.value);
      store.updateLane(index, { speed_mps: speed.value === "" || !Number.isFinite(n) || n <= 0 ? undefined : n }, "Change the speed limit");
      this.#host.refresh();
    });
    body.append(row("Speed limit (m/s)", speed));

    const cost = h("input", { type: "number", min: 0.1, step: 0.1, value: lane.cost === undefined ? "" : String(lane.cost), placeholder: "1" });
    cost.addEventListener("change", () => {
      const n = Number(cost.value);
      store.updateLane(index, { cost: cost.value === "" || !Number.isFinite(n) || n === 1 ? undefined : n }, "Change the cost");
      this.#host.refresh();
    });
    body.append(row("Cost", cost));
    body.append(h("p", { class: "prose muted", text: "Cost multiplies the lane's length when a route is chosen. 1 is neutral; 2 makes the robot treat it as twice as long and prefer another way round." }));

    const notes = textInput(lane.notes ?? "", "(no note)", (v) => {
      store.updateLane(index, { notes: v.trim() === "" ? undefined : v }, "Change the note");
      this.#host.refresh();
    });
    body.append(row("Note", notes));

    const flip = h("button", {}, icon("rotate"), "Swap the ends");
    flip.addEventListener("click", () => {
      store.flipLane(index);
      this.#host.refresh();
    });
    const del = h("button", { class: "danger" }, icon("trash"), "Delete this lane");
    del.addEventListener("click", () => {
      store.deleteLane(index);
      this.#host.refresh();
    });
    body.append(h("div", { class: "row buttons" }, flip, del));
    this.#body.replaceChildren(body);
  }

  // ---- findings -----------------------------------------------------------

  #appendFindings(body: HTMLElement, prefix: readonly (string | number)[], mission?: Mission, stepId?: string): void {
    const all = this.#host.findings();
    const own = all.filter((f) => {
      if (stepId && f.stepId === stepId) return true;
      if (mission && f.path.length <= 1) return true;
      if (prefix.length === 0) return false;
      return f.path.length >= prefix.length && prefix.every((seg, i) => f.path[i] === seg);
    });
    if (own.length === 0) return;
    body.append(h("div", { class: "sub-title", text: "Problems" }));
    for (const f of own) {
      body.append(
        h("div", { class: `finding ${f.level}` }, h("div", { text: `${f.message.charAt(0).toUpperCase()}${f.message.slice(1)}.` }), h("div", { class: "where", text: pathToString(f.path) })),
      );
    }
  }
}

// ---- helpers ----------------------------------------------------------------

function numberInput(value: number, onChange: (v: number) => void): HTMLInputElement {
  const inp = h("input", { type: "number", step: 0.01, value: String(value) });
  inp.addEventListener("change", () => {
    const n = Number(inp.value);
    if (Number.isFinite(n)) onChange(n);
  });
  return inp;
}

export function laneName(lane: Edge): string {
  return `${lane.from} ${lane.bidirectional === false ? "→" : "↔"} ${lane.to}`;
}

function containerSentence(node: TreeNode): string {
  switch (node.kind) {
    case "triggers":
      return "The events that start this mission on their own. Without one, it only runs when somebody asks for it.";
    case "interrupts":
      return "Armed only while this mission runs. When one fires it starts another mission, and this one is suspended or preempted.";
    case "flow":
      return "The steps the robot performs, in order. The first one that fails ends the run unless it is told to carry on.";
    case "onabort":
      return "The steps that run when the mission fails or is canceled. This is where the robot is put back in a safe state.";
    case "onfail":
      return "The steps that run before this step is tried again.";
    case "branch":
      return "The steps of this branch, in order.";
    default:
      return "";
  }
}

function policySentence(policy: string): string {
  switch (policy) {
    case "preempt":
      return "If something else is running and this mission has at least the same priority, that run is canceled and this one starts.";
    case "preempt_latest":
      return "Like preempt, and queued runs of this same mission are dropped, so the newest request wins.";
    case "reject_if_busy":
      return "The request is dropped whenever anything is running or queued.";
    case "interrupt_and_resume":
      return "The current run is suspended, this mission runs, and then the suspended run carries on from the step it was in.";
    default:
      return "The request joins the queue, which is ordered by priority and then by arrival.";
  }
}

function cleanOnFail(value: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return Object.keys(out).length === 0 ? undefined : out;
}

function uniqueKey(record: Record<string, unknown>, base: string): string {
  if (!(base in record)) return base;
  for (let i = 2; ; i++) if (!(`${base}${i}` in record)) return `${base}${i}`;
}

function parseLoose(text: string): unknown {
  const t = text.trim();
  if (t === "") return "";
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  try {
    return JSON.parse(t);
  } catch {
    return text;
  }
}
