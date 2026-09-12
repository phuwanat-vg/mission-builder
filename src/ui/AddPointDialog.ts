/**
 * Add point by coordinates: name, x, y, heading and kind, typed in instead of
 * clicked. Robot pose fills x, y and heading from where the robot is when one
 * is connected. Coordinates are the map frame in metres; the heading is in
 * degrees, 0 along +x and counter-clockwise positive.
 */

import { h } from "./dom";
import { icon } from "./icons";
import { field, openModal } from "./modal";
import type { RouteStore } from "../mission/RouteStore";
import { SITE_KINDS } from "../mission/types";
import type { SiteKind } from "../mission/types";
import { normalizeYaw, uniqueSiteName } from "../mission/geometry";

export interface AddPointHost {
  store: RouteStore;
  /** Why the robot's pose cannot be read, or "" when it can. */
  robotPoseUnavailable(): string;
  robotPose(): Promise<{ x: number; y: number; yaw_deg: number } | null>;
  /** The point was added and selected. */
  added(name: string): void;
}

export function openAddPointDialog(host: AddPointHost): void {
  const store = host.store;
  const name = h("input", { type: "text", value: uniqueSiteName(store.points, "P"), placeholder: "Conveyor1" });
  const x = h("input", { type: "number", step: 0.1, placeholder: "0.0" });
  const y = h("input", { type: "number", step: 0.1, placeholder: "0.0" });
  const yaw = h("input", { type: "number", step: 5, placeholder: "(no heading)" });
  const kind = h("select");
  for (const k of SITE_KINDS) kind.appendChild(h("option", { value: k, text: k }));
  kind.value = "station";

  const reason = host.robotPoseUnavailable();
  const fromRobot = h("button", { title: reason || "Fill x, y and heading from where the robot is now." }, icon("locate"), "Robot pose");
  fromRobot.disabled = reason !== "";

  const dialog = openModal({
    title: "Add point",
    content: [
      h("p", { class: "prose muted", text: `In the frame of the map named ${store.mapName}, in metres. Heading is in degrees, 0 along +x, counter-clockwise positive.` }),
      field("Name", name),
      h("div", { class: "field-row" }, field("X (m)", x), field("Y (m)", y)),
      h("div", { class: "field-row" }, field("Heading (deg)", yaw), field("Kind", kind)),
      h("div", { class: "row" }, fromRobot, h("span", { class: "stats", text: reason })),
    ],
    buttons: [
      { label: "Cancel" },
      {
        label: "Add point",
        icon: "plus",
        kind: "primary",
        run: () => {
          const text = name.value.trim();
          if (!store.mapNames.includes(store.mapName)) return fail("There is no map to put the point on. Register a map in the Maps tab first.");
          if (text === "") return fail("Give the point a name.");
          if (store.points[text]) return fail(`There is already a point called ${text} on this map.`);
          const xv = Number(x.value);
          const yv = Number(y.value);
          if (x.value.trim() === "" || !Number.isFinite(xv)) return fail("Type the X coordinate in metres, for example 2.5.");
          if (y.value.trim() === "" || !Number.isFinite(yv)) return fail("Type the Y coordinate in metres, for example -1.25.");
          const yawText = yaw.value.trim();
          const yawValue = yawText === "" ? null : Number(yawText);
          if (yawValue !== null && !Number.isFinite(yawValue)) return fail("The heading has to be a number of degrees, or empty.");
          if (!store.addNamedPoint(text, xv, yv, yawValue === null ? null : normalizeYaw(yawValue), kind.value as SiteKind)) return fail(`${text} could not be added.`);
          host.added(text);
          return true;
        },
      },
    ],
  });

  function fail(sentence: string): false {
    dialog.setError(sentence);
    return false;
  }

  fromRobot.addEventListener("click", () => {
    fromRobot.disabled = true;
    void host
      .robotPose()
      .then((pose) => {
        if (!pose) {
          dialog.setError("The robot has not said where it is yet.");
          return;
        }
        x.value = String(Math.round(pose.x * 1000) / 1000);
        y.value = String(Math.round(pose.y * 1000) / 1000);
        yaw.value = String(Math.round(normalizeYaw(pose.yaw_deg) * 10) / 10);
        dialog.setError("");
      })
      .catch((err: unknown) => dialog.setError(`The robot's pose could not be read: ${err instanceof Error ? err.message : String(err)}`))
      .finally(() => {
        fromRobot.disabled = host.robotPoseUnavailable() !== "";
      });
  });
}
