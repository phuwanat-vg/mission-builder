# Changelog

## 0.1.0 — unreleased

First version. Builds and runs Nav2 missions over one `foxglove_bridge`
connection, without writing code.

- **The mission tree**: the whole `mission/1` document as a collapsible tree —
  triggers, interrupts, settings, tasks with their nested branches and on-fail
  levels, and the mission's clean-up steps. Add from a picker grouped by what
  the robot should do, drag to reorder within and between levels, duplicate,
  delete, turn off, with keyboard equivalents. Live run glyphs and validation
  badges that explain themselves in a sentence.
- **The map**: the robot's occupancy grid, the route graph and the live robot,
  with the Select, Point, Lane and Fit tools of iViz's Route mode.
- **Lane configuration**: direction (both ways, or one way in either
  direction), blocked, speed limit and cost.
- **Maps**: list, switch, register, rename and delete the maps the robot knows.
- **Deploy**: validates, then writes the mission and the map data in one action.
- **Run, Pause, Stop** and an Activity bar with the live event stream, the
  pending `ask_user` prompt and the run history.
- **Export** a mission as a `nav2_simple_commander` Python script or as Nav2
  behavior-tree XML.
- **Two themes**: Drafting, a light drawing surface, is the default; Dark is the
  original palette. Chosen from the `⋯` menu and remembered. Every colour is a
  CSS variable, and the three.js scene reads the same variables, so a switch
  takes effect without a reload.
- Degrades cleanly and says why when the bridge, `/mission/api` or the runner is
  missing; missions can still be edited and exported offline.
- NSIS installer with in-app updates through `tauri-plugin-updater`.
