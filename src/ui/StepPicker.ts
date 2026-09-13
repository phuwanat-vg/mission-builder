/**
 * The grouped picker that adds a step, and the one that adds a trigger.
 *
 * The groups are named for what the user wants the robot to do, not for the
 * step type underneath. Every step type in `mission.schema.json` appears in
 * exactly one group; a few entries are the same type with a preset, which is
 * how "wait for a Modbus coil" and "wait for an MQTT message" are one type.
 */

import { h } from "./dom";
import { icon } from "./icons";
import type { IconName } from "./icons";
import { blockDefOrUnknown, allTriggers, newStep, newTrigger } from "../mission/blocks";
import type { EventSource, Step, Trigger } from "../mission/types";

export interface StepChoice {
  label: string;
  type: string;
  /** Extra fields merged into the new step, e.g. which event a wait listens to. */
  preset?: Record<string, unknown>;
  /** Shown under the label when the choice has a consequence worth knowing. */
  note?: string;
  /** Listed but greyed out and not pickable. */
  disabled?: boolean;
}

export interface StepGroup {
  name: string;
  icon: IconName;
  items: StepChoice[];
  /** Every entry of the group is listed but greyed out. */
  disabled?: boolean;
}

function waitFor(source: EventSource): Record<string, unknown> {
  return { source };
}

export const STEP_GROUPS: readonly StepGroup[] = [
  {
    name: "Drive somewhere",
    icon: "navigation",
    items: [
      { label: "Follow route", type: "nav.follow_route", note: "Drives only along the lanes drawn on the map, honouring one-way and blocked lanes." },
      { label: "Direct (ignores the route)", type: "nav.go_to_pose", note: "Drives straight to a pose; the lanes on the map are not used." },
      { label: "Drive through poses", type: "nav.go_through_poses" },
      { label: "Follow waypoints", type: "nav.follow_waypoints" },
      { label: "Follow a path", type: "nav.follow_path" },
      { label: "Work out a path", type: "nav.compute_path" },
      { label: "Work out a path through poses", type: "nav.compute_path_through_poses" },
      { label: "Smooth a path", type: "nav.smooth_path" },
    ],
  },
  {
    name: "Send a signal",
    icon: "send",
    items: [
      { label: "MQTT message", type: "mqtt.publish", disabled: true },
      { label: "Modbus coil or register", type: "modbus.write", disabled: true },
      { label: "GPIO output", type: "gpio.write", disabled: true },
      { label: "ROS topic", type: "ros.publish" },
    ],
  },
  {
    name: "Wait for something",
    icon: "hourglass",
    disabled: true,
    items: [
      { label: "A delay", type: "wait" },
      { label: "An MQTT message", type: "wait_event", preset: waitFor({ type: "mqtt.subscribe", connector: "", topic: "" }) },
      { label: "A Modbus coil", type: "wait_event", preset: waitFor({ type: "modbus.poll", connector: "", kind: "coil", address: 0, when: "payload.value", edge: "rising" }) },
      { label: "A GPIO input", type: "wait_event", preset: waitFor({ type: "gpio.input", pin: 17, gpio_edge: "falling" }) },
      { label: "A ROS message", type: "wait_event", preset: waitFor({ type: "ros.topic", topic: "" }) },
      { label: "A web call", type: "wait_event", preset: waitFor({ type: "http.webhook", path: "" }) },
      { label: "Nav2 to be ready", type: "nav.wait_active" },
    ],
  },
  {
    name: "Ask for an answer",
    icon: "message",
    items: [
      { label: "Ask on the request topics", type: "ros.request", note: "Publishes a request and waits for its answer. iViz's Dashboard answers it, and so can any node." },
      { label: "A question for the runner's prompt", type: "ask_user", note: "Asked through mission_runner's own prompt service." },
    ],
  },
  {
    name: "Robot behaviour",
    icon: "bot",
    disabled: true,
    items: [
      { label: "Spin", type: "nav.spin" },
      { label: "Back up", type: "nav.backup" },
      { label: "Drive on a heading", type: "nav.drive_on_heading" },
      { label: "Dock", type: "nav.dock" },
      { label: "Undock", type: "nav.undock" },
      { label: "Clear the costmaps", type: "nav.clear_costmap" },
      { label: "Change map", type: "nav.change_map" },
      { label: "Set where the robot thinks it is", type: "nav.set_initial_pose" },
      { label: "Start or stop Nav2", type: "nav.lifecycle" },
      { label: "Cancel what Nav2 is doing", type: "nav.cancel" },
    ],
  },
  {
    name: "Call another system",
    icon: "globe",
    disabled: true,
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
      { label: "If", type: "if", note: "Adds a then and an else level under this step." },
      { label: "Loop", type: "loop", note: "Adds a level that runs again each time round." },
      { label: "Break out of the loop", type: "break" },
      { label: "Set a value", type: "set" },
      { label: "Write to the log", type: "log" },
      { label: "Run another mission", type: "run_mission" },
      { label: "End the mission", type: "end" },
    ],
  },
];

/** Build the step a picker entry stands for, with a fresh id. */
export function stepForChoice(choice: StepChoice, id: string): Step {
  const step = newStep(choice.type, id);
  if (choice.preset) for (const [k, v] of Object.entries(choice.preset)) step[k] = JSON.parse(JSON.stringify(v)) as unknown;
  if (choice.type === "if") {
    step.then = [];
    step.else = [];
  }
  if (choice.type === "loop") step.body = [];
  return step;
}

/**
 * A pop-over picker anchored near `anchor`. It closes on Escape, on a click
 * outside, and after a choice. `title` says where the step will land.
 */
export function openStepPicker(anchor: HTMLElement, title: string, onPick: (choice: StepChoice) => void): void {
  const search = h("input", { type: "text", placeholder: "Search steps", class: "picker-search" });
  const list = h("div", { class: "picker-list" });
  const pop = h("div", { class: "popover picker-pop" }, h("div", { class: "popover-title", text: title }), search, list);

  const render = (query: string): void => {
    const q = query.trim().toLowerCase();
    const rows: HTMLElement[] = [];
    for (const group of STEP_GROUPS) {
      const items = group.items.filter((i) => q === "" || i.label.toLowerCase().includes(q) || i.type.includes(q));
      if (items.length === 0) continue;
      rows.push(h("div", { class: `picker-group${group.disabled ? " disabled" : ""}` }, icon(group.icon), h("span", { text: group.name })));
      for (const item of items) {
        const def = blockDefOrUnknown(item.type);
        const off = group.disabled === true || item.disabled === true;
        const btn = h(
          "button",
          { class: "picker-row", title: off ? "Not available in this version" : (item.note ?? def.help) },
          icon(def.icon),
          h("span", { class: "picker-label", text: item.label }),
          h("span", { class: "picker-type", text: item.type }),
        );
        btn.disabled = off;
        btn.addEventListener("click", () => {
          if (off) return;
          close();
          onPick(item);
        });
        rows.push(btn);
      }
    }
    if (rows.length === 0) rows.push(h("div", { class: "empty", text: "No step matches that." }));
    list.replaceChildren(...rows);
  };

  const close = (): void => {
    pop.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const outside = (ev: PointerEvent): void => {
    if (!pop.contains(ev.target as Node)) close();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
    }
  };

  search.addEventListener("input", () => render(search.value));
  render("");
  document.body.appendChild(pop);
  placeNear(pop, anchor);
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", onKey, true);
  search.focus();
}

/** The same pop-over, listing the event sources a trigger can use. */
export function openTriggerPicker(anchor: HTMLElement, title: string, onPick: (type: string) => void): void {
  const list = h("div", { class: "picker-list" });
  const pop = h("div", { class: "popover picker-pop" }, h("div", { class: "popover-title", text: title }), list);
  const rows: HTMLElement[] = [];
  for (const def of allTriggers()) {
    const btn = h("button", { class: "picker-row", title: def.help }, icon(def.icon), h("span", { class: "picker-label", text: def.label }), h("span", { class: "picker-type", text: def.type }));
    btn.addEventListener("click", () => {
      close();
      onPick(def.type);
    });
    rows.push(btn);
  }
  list.replaceChildren(...rows);
  const close = (): void => {
    pop.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const outside = (ev: PointerEvent): void => {
    if (!pop.contains(ev.target as Node)) close();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
    }
  };
  document.body.appendChild(pop);
  placeNear(pop, anchor);
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", onKey, true);
}

/** A new trigger of `type`, with its required parameters filled in. */
export function triggerForType(type: string, id: string): Trigger {
  return newTrigger(type, id);
}

export function placeNear(pop: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const width = pop.offsetWidth || 300;
  const height = pop.offsetHeight || 320;
  const left = Math.min(Math.max(8, rect.left), window.innerWidth - width - 8);
  const below = rect.bottom + 4;
  const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below;
  pop.style.left = `${left}px`;
  pop.style.top = `${top}px`;
}

/**
 * A small menu of plain actions at a screen position (the tree's context
 * menu). Entries with `danger` are drawn in the error colour.
 */
export interface MenuItem {
  label: string;
  icon?: IconName;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  run: () => void;
}

export function openMenu(x: number, y: number, items: MenuItem[]): void {
  const pop = h("div", { class: "popover menu-pop" });
  for (const item of items) {
    if (item.label === "-") {
      pop.appendChild(h("div", { class: "menu-sep" }));
      continue;
    }
    const btn = h("button", { class: `menu-row${item.danger ? " danger" : ""}` }, item.icon ? icon(item.icon) : h("span", { class: "menu-gap" }), h("span", { class: "menu-label", text: item.label }), h("kbd", { text: item.hint ?? "" }));
    btn.disabled = item.disabled === true;
    btn.addEventListener("click", () => {
      close();
      item.run();
    });
    pop.appendChild(btn);
  }
  const close = (): void => {
    pop.remove();
    document.removeEventListener("pointerdown", outside, true);
    document.removeEventListener("keydown", onKey, true);
  };
  const outside = (ev: PointerEvent): void => {
    if (!pop.contains(ev.target as Node)) close();
  };
  const onKey = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape") {
      ev.stopPropagation();
      close();
    }
  };
  document.body.appendChild(pop);
  const width = pop.offsetWidth || 220;
  const height = pop.offsetHeight || 200;
  pop.style.left = `${Math.min(x, window.innerWidth - width - 8)}px`;
  pop.style.top = `${Math.min(y, window.innerHeight - height - 8)}px`;
  document.addEventListener("pointerdown", outside, true);
  document.addEventListener("keydown", onKey, true);
}
