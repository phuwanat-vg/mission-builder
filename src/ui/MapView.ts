/**
 * The map column: a thin tool strip along the top edge, the drawing filling
 * everything below it, and a status strip along the bottom edge.
 *
 * Nothing floats over the drawing except a toast and the inline name box, and
 * the guide card while the map still has nothing on it. The tool's one-line
 * hint, the cursor's world position and the map being edited all live in the
 * bottom strip rather than in a card over the floor plan.
 *
 * The scene, the layers and the tool mechanism are iViz's, unchanged; what is
 * here is the wiring — subscribing the robot's map and TF, drawing the route
 * graph from the store, and handing the theme's colours to the scene.
 */

import { Viewer } from "../viz/Viewer";
import type { ToolName } from "../viz/Viewer";
import { TfLayer, createLayer, isSupportedSchema } from "../viz/layers";
import type { Layer } from "../viz/layers";
import { RouteLayer } from "../viz/layers/RouteLayer";
import { RouteTools, TOOL_LINK, TOOL_POINT, TOOL_SELECT } from "./RouteTools";
import { TfTree } from "../ros/TfTree";
import { normalizeSchemaName } from "../ros/types";
import type { TFMessage } from "../ros/types";
import type { FoxgloveConnection } from "../net/FoxgloveConnection";
import type { RouteStore } from "../mission/RouteStore";
import { boundsOf } from "../mission/geometry";
import { h } from "./dom";
import { icon } from "./icons";
import type { IconName } from "./icons";
import { onThemeChange, themeColors } from "./theme";
import type { ThemeColors } from "./theme";
import type { Channel } from "@foxglove/ws-protocol";
import { Vector3 } from "three";

export interface MapViewHost {
  conn: FoxgloveConnection;
  store: RouteStore;
  /** Redraw the tree and the properties column after an edit on the map. */
  refresh(): void;
}

interface ToolButton {
  name: string;
  label: string;
  key: string;
  icon: IconName;
  button: HTMLButtonElement;
}

const _ground = new Vector3();

export class MapView {
  readonly element: HTMLElement;
  readonly viewer: Viewer;
  readonly tf = new TfTree();
  readonly routeLayer: RouteLayer;

  #host: MapViewHost;
  #viewEl: HTMLElement;
  #canvasEl: HTMLElement;
  #tools: RouteTools;
  #toolButtons: ToolButton[] = [];
  #hintEl: HTMLElement;
  #coordsEl: HTMLElement;
  #whereEl: HTMLElement;
  #guideEl: HTMLElement;
  #tfLayer: TfLayer;
  #gridLayers = new Map<string, { layer: Layer; unsubscribe: () => void }>();
  #unsubTf: (() => void)[] = [];
  #unsubTheme: () => void;
  #tfVersionSeen = -1;
  #tickTimer: ReturnType<typeof setInterval>;

  constructor(host: MapViewHost) {
    this.#host = host;
    this.#viewEl = h("div", { class: "view" });
    this.#canvasEl = h("div", { class: "map-canvas" });
    this.#hintEl = h("div", { class: "tool-hint" });
    this.#coordsEl = h("div", { class: "map-coords", text: "" });
    this.#whereEl = h("div", { class: "map-where", text: "" });
    this.#guideEl = h("div", { class: "guide-card" });
    this.#guideEl.hidden = true;

    this.viewer = new Viewer(this.#canvasEl, this.tf);
    this.viewer.setMode("2d");
    this.viewer.onToolChange = (tool) => this.#syncTools(tool);

    this.#tfLayer = new TfLayer({});
    this.#tfLayer.visible = true;
    this.viewer.addLayer(this.#tfLayer);

    this.routeLayer = new RouteLayer(this.viewer, host.store);
    this.viewer.addLayer(this.routeLayer);

    this.#tools = new RouteTools({
      viewer: this.viewer,
      store: host.store,
      layer: this.routeLayer,
      promptName: (name, x, y) => this.#promptName(name, x, y),
      refresh: () => {
        this.#host.refresh();
        this.renderGuide();
      },
      onDragHint: (text) => this.#setDragHint(text),
    });

    this.#canvasEl.append(this.#guideEl);
    this.#viewEl.append(this.#buildToolbar(), this.#canvasEl, this.#buildStatusStrip());
    this.element = this.#viewEl;

    this.#canvasEl.addEventListener("pointermove", (ev) => this.#showCursor(ev));
    this.#canvasEl.addEventListener("pointerleave", () => (this.#coordsEl.textContent = ""));

    this.#unsubTf.push(host.conn.subscribe("/tf", (msg, _c, now) => this.tf.applyMessage(msg as TFMessage, false, now)));
    this.#unsubTf.push(host.conn.subscribe("/tf_static", (msg, _c, now) => this.tf.applyMessage(msg as TFMessage, true, now)));
    host.conn.onChannelsChange((channels) => this.onChannels(channels));

    // The scene cannot read CSS, so the theme is pushed into it, now and on
    // every switch. No reload: the layers rebuild themselves in place.
    this.#applyTheme(themeColors());
    this.#unsubTheme = onThemeChange((colors) => this.#applyTheme(colors));

    this.viewer.setTool(TOOL_SELECT);
    this.#tickTimer = setInterval(() => this.#tick(), 1000);
  }

  dispose(): void {
    clearInterval(this.#tickTimer);
    this.#unsubTheme();
    for (const u of this.#unsubTf) u();
    this.#tools.dispose();
    for (const g of this.#gridLayers.values()) g.unsubscribe();
    this.viewer.dispose();
  }

  // ---- theme --------------------------------------------------------------

  #applyTheme(colors: ThemeColors): void {
    this.viewer.setThemeColors(colors);
    this.routeLayer.setThemeColors(colors);
    this.#tfLayer.setThemeColors(colors);
  }

  // ---- tools --------------------------------------------------------------

  #buildToolbar(): HTMLElement {
    const defs: { name: string; label: string; key: string; icon: IconName; title: string }[] = [
      { name: TOOL_SELECT, label: "Select", key: "V", icon: "mousePointer", title: "Pick and move what is on the map" },
      { name: TOOL_POINT, label: "Point", key: "N", icon: "mapPin", title: "Add a point the robot can drive to" },
      { name: TOOL_LINK, label: "Lane", key: "L", icon: "route", title: "Draw a lane between two points" },
      { name: "fit", label: "Fit", key: "F", icon: "maximize", title: "Move the camera so everything is in view" },
    ];
    const bar = h("div", { class: "map-toolbar" });
    for (const def of defs) {
      if (def.name === "fit") bar.append(h("div", { class: "tool-sep" }));
      const button = h("button", { class: "tool", title: def.title }, icon(def.icon), h("span", { text: def.label }), h("kbd", { text: def.key }));
      button.addEventListener("click", () => this.setTool(def.name));
      bar.append(button);
      this.#toolButtons.push({ name: def.name, label: def.label, key: def.key, icon: def.icon, button });
    }
    return bar;
  }

  /** The bottom edge: what the tool does, where the cursor is, which map. */
  #buildStatusStrip(): HTMLElement {
    return h("div", { class: "map-status" }, this.#hintEl, this.#coordsEl, this.#whereEl);
  }

  /** `fit` is a command, not a mode: it frames what is drawn and returns. */
  setTool(name: string): void {
    if (name === "fit") {
      this.fit();
      return;
    }
    this.viewer.setTool(name);
    this.#syncTools(name);
  }

  #syncTools(tool: ToolName): void {
    for (const t of this.#toolButtons) t.button.classList.toggle("active", t.name === tool);
    this.#setHint(RouteTools.hintFor(String(tool)) || "Press V to select, N for a point, L for a lane, F to fit the view.");
  }

  /** The strip is one line, so the whole sentence is also the tooltip. */
  #setHint(text: string): void {
    this.#hintEl.textContent = text;
    this.#hintEl.title = text;
  }

  #setDragHint(text: string | null): void {
    if (text === null) this.#syncTools(this.viewer.tool);
    else this.#setHint(text);
  }

  /** Where the pointer is on the floor, in the map's own metres. */
  #showCursor(ev: PointerEvent): void {
    if (this.viewer.groundPointFromClient(ev.clientX, ev.clientY, _ground)) {
      this.#coordsEl.textContent = `x ${_ground.x.toFixed(2)}  y ${_ground.y.toFixed(2)} m`;
    } else {
      this.#coordsEl.textContent = "";
    }
  }

  /** Frame the route graph, or the whole grid when the map has nothing on it. */
  fit(): void {
    const points = Object.values(this.#host.store.points);
    const bounds = boundsOf(points);
    if (bounds) this.viewer.frameBounds(bounds.minX, bounds.minY, bounds.maxX, bounds.maxY, 2);
    else this.viewer.resetView();
  }

  focusPoint(name: string): void {
    const site = this.#host.store.points[name];
    if (!site) return;
    this.viewer.frameBounds(site.x - 3, site.y - 3, site.x + 3, site.y + 3, 0.5);
  }

  /** Keyboard shortcuts that belong to the map. Returns true when handled. */
  handleKey(ev: KeyboardEvent): boolean {
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return false;
    switch (ev.key) {
      case "v":
      case "V":
        this.setTool(TOOL_SELECT);
        return true;
      case "n":
      case "N":
        this.setTool(TOOL_POINT);
        return true;
      case "l":
      case "L":
        this.setTool(TOOL_LINK);
        return true;
      case "f":
      case "F":
        this.fit();
        return true;
      case "Escape":
        this.setTool(TOOL_SELECT);
        return true;
      default:
        return false;
    }
  }

  // ---- naming a new point -------------------------------------------------

  #promptName(name: string, x: number, y: number): void {
    const screen = this.viewer.worldToScreenPoint(x, y);
    const input = h("input", { class: "inline-name", type: "text", value: name, style: `left:${screen.x}px;top:${screen.y}px` });
    // Removing the input fires `blur`, which would run this a second time.
    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;
      const value = input.value;
      input.remove();
      if (commit && value.trim() !== "" && value.trim() !== name) this.#host.store.renamePoint(name, value);
      this.#host.refresh();
      this.renderGuide();
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") finish(true);
      else if (ev.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    this.#canvasEl.appendChild(input);
    input.focus();
    input.select();
  }

  // ---- the robot's map ----------------------------------------------------

  /** Subscribe the robot's occupancy grid the first time it is advertised. */
  onChannels(channels: readonly Channel[]): void {
    const grids = channels.filter((c) => normalizeSchemaName(c.schemaName) === "nav_msgs/OccupancyGrid" && !c.topic.includes("costmap"));
    const preferred = grids.find((c) => c.topic === "/map") ?? grids[0];
    if (!preferred || this.#gridLayers.has(preferred.topic)) return;
    if (!isSupportedSchema(preferred.schemaName)) return;
    const layer = createLayer(preferred.topic, preferred.schemaName);
    if (!layer) return;
    const unsubscribe = this.#host.conn.subscribe(preferred.topic, (msg, _c, now) => layer.onMessage(msg, now));
    this.viewer.addLayer(layer);
    this.#gridLayers.set(preferred.topic, { layer, unsubscribe });
  }

  get hasGrid(): boolean {
    return this.#gridLayers.size > 0;
  }

  // ---- the guided empty state --------------------------------------------

  /**
   * What to do next, when the map has nothing on it. Three numbered steps,
   * each with its key and a button that arms the matching tool.
   */
  renderGuide(): void {
    const store = this.#host.store;
    const points = Object.keys(store.points).length;
    const lanes = store.lanes.length;
    if (points > 0 && lanes > 0) {
      this.#guideEl.hidden = true;
      return;
    }
    const steps: { title: string; text: string; key: string; tool: string; done: boolean }[] = [
      { title: "Draw the places the robot should visit", text: "Pick the Point tool and click the floor. Drag before you let go to say which way the robot faces there.", key: "N", tool: TOOL_POINT, done: points > 0 },
      { title: "Connect them into lanes", text: "Pick the Lane tool and drag from one point to another. Hold Shift while you drag for a one-way lane.", key: "L", tool: TOOL_LINK, done: lanes > 0 },
      { title: "Put the tasks in order in the tree", text: "Use the plus on Tasks in the left column to add what happens, and Deploy to send it to the robot.", key: "", tool: "", done: false },
    ];
    const card = h("div", { class: "panel-card" }, h("div", { class: "card-title" }, icon("route"), h("span", { text: "Start with the map" })));
    for (let i = 0; i < steps.length; i++) {
      const s = steps[i]!;
      const step = h("div", { class: `guide-step${s.done ? " done" : ""}` });
      step.append(h("div", { class: "guide-head" }, h("span", { class: "guide-no", text: String(i + 1) }), h("span", { class: "guide-title", text: s.title })));
      step.append(h("p", { class: "prose", text: s.text }));
      if (s.tool !== "") {
        const btn = h("button", { class: "step-btn" }, h("span", { text: `Use the ${s.tool === TOOL_POINT ? "Point" : "Lane"} tool` }), h("kbd", { text: s.key }));
        btn.addEventListener("click", () => this.setTool(s.tool));
        step.append(btn);
      }
      card.append(step);
    }
    this.#guideEl.replaceChildren(card);
    this.#guideEl.hidden = false;
  }

  // ---- housekeeping -------------------------------------------------------

  #tick(): void {
    if (this.tf.version !== this.#tfVersionSeen) {
      this.#tfVersionSeen = this.tf.version;
      const wanted = this.#host.store.frame || this.tf.suggestFixedFrame() || "map";
      this.viewer.setFixedFrame(wanted);
    }
    const frames = this.tf.frames().length;
    this.#whereEl.textContent = this.#host.store.mapName || "no map";
    // The frame rate and the TF count are diagnostics, not chrome: they live
    // in the tooltip rather than on the drawing.
    this.#whereEl.title = `${this.viewer.fps.toFixed(0)} fps · ${frames} TF ${frames === 1 ? "frame" : "frames"}`;
  }
}
