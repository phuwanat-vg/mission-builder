/**
 * The Maps section: what the robot knows from `sites.json`.
 *
 * Each map owns its own points and lanes, so a mission written as "go to
 * Inbound" moves between buildings without being rewritten. From here a map is
 * switched, registered, renamed and deleted; the changes are part of the same
 * `PUT /api/sites` that Deploy sends.
 */

import { h, row } from "./dom";
import { icon } from "./icons";
import { textInput } from "./ActionForm";
import type { RouteStore } from "../mission/RouteStore";

export interface MapsHost {
  store: RouteStore;
  /** The map the runner has loaded right now, from `/mission/state`. */
  currentMap(): string | null;
  /** Switch the map being edited (and drawn). */
  showMap(name: string): void;
  /** Ask the runner to load a different map, if it can. */
  changeRobotMap(name: string): void;
  refresh(): void;
  toast(message: string, kind?: "error" | "info"): void;
}

export class MapsPanel {
  readonly element: HTMLElement;
  #host: MapsHost;
  #body: HTMLElement;

  constructor(host: MapsHost) {
    this.#host = host;
    this.#body = h("div", { class: "props-body maps-body" });
    this.element = this.#body;
  }

  render(): void {
    const store = this.#host.store;
    const sites = store.sites;
    const names = store.mapNames;
    const current = this.#host.currentMap();
    const body = h("div");

    if (names.length === 0) {
      body.append(
        h("p", { class: "prose", text: "The project has no maps yet. Register one by giving it a name and the path of its map.yaml on the robot, then draw the points and lanes on it." }),
      );
    }

    for (const name of names) {
      const map = sites.maps[name];
      if (!map) continue;
      const pointCount = Object.keys(map.sites ?? {}).length;
      const laneCount = (map.edges ?? []).length;
      const isShown = name === store.mapName;
      const isDefault = sites.default_map === name;
      const isLoaded = current === name;

      const card = h("div", { class: `map-card${isShown ? " shown" : ""}` });
      const title = h("div", { class: "map-title" }, icon("map"), h("span", { class: "map-name", text: name }));
      if (isLoaded) title.append(h("span", { class: "pill ok", text: "on the robot" }));
      else if (isDefault) title.append(h("span", { class: "pill", text: "default" }));
      card.append(title);
      card.append(
        h("div", { class: "map-detail", text: `${pointCount} ${pointCount === 1 ? "point" : "points"} · ${laneCount} ${laneCount === 1 ? "lane" : "lanes"}` }),
      );
      card.append(h("div", { class: "map-file", text: map.file ?? "No map file: the runner draws a plain room around the points instead." }));

      const buttons = h("div", { class: "row buttons" });
      if (!isShown) {
        const show = h("button", {}, icon("eye"), "Edit this map");
        show.addEventListener("click", () => this.#host.showMap(name));
        buttons.append(show);
      }
      if (!isLoaded) {
        const load = h("button", {}, icon("upload"), "Load on the robot");
        load.addEventListener("click", () => this.#host.changeRobotMap(name));
        buttons.append(load);
      }
      if (!isDefault) {
        const def = h("button", {}, icon("check"), "Make it the default");
        def.addEventListener("click", () => {
          this.#host.store.setDefaultMap(name);
          this.#host.refresh();
        });
        buttons.append(def);
      }
      const rename = h("button", { class: "icon-only", title: `Rename ${name}` }, icon("edit"));
      rename.addEventListener("click", () => this.#rename(name));
      const del = h("button", { class: "icon-only danger", title: `Delete ${name}` }, icon("trash"));
      del.addEventListener("click", () => {
        if (!confirm(`Delete the map ${name} and its ${pointCount} points and ${laneCount} lanes? Missions that drive to those points will stop working.`)) return;
        this.#host.store.deleteMap(name);
        this.#host.refresh();
      });
      buttons.append(rename, del);
      card.append(buttons);
      body.append(card);
    }

    body.append(h("div", { class: "sub-title", text: "Register a map" }));
    let newName = "";
    let newFile = "";
    body.append(row("Name", textInput("", "warehouse", (v) => (newName = v))));
    body.append(row("Path on the robot", textInput("", "/home/pi/maps/warehouse.yaml", (v) => (newFile = v))));
    const add = h("button", { class: "primary" }, icon("plus"), "Register");
    add.addEventListener("click", () => {
      if (newName.trim() === "") {
        this.#host.toast("Give the map a name first.");
        return;
      }
      if (!this.#host.store.addMap(newName, newFile)) {
        this.#host.toast(`There is already a map called ${newName.trim()}.`);
        return;
      }
      this.#host.toast(`${newName.trim()} is part of the project now. Deploy sends it to the robot.`, "info");
      this.#host.refresh();
    });
    body.append(h("div", { class: "row" }, add));
    body.append(h("p", { class: "prose muted", text: "The path is a ROS map.yaml on the robot, next to its .pgm or .png. When the file is missing the runner draws a plain room around the map's points instead, so there is always a floor to place things on." }));

    this.#body.replaceChildren(body);
  }

  #rename(name: string): void {
    const next = prompt(`Rename the map ${name} to:`, name);
    if (next === null) return;
    if (!this.#host.store.renameMap(name, next)) {
      this.#host.toast(`${next.trim()} is not a name this robot can use, or it is taken already.`);
      return;
    }
    this.#host.refresh();
  }
}
