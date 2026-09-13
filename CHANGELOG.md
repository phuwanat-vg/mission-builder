# Changelog

## Unreleased

- **Deploy**: "Replace missions on the robot" is ticked by default, and the
  dialog lists right away what that deletes on the robot.
- **Top bar** is black in every theme, with white text, brighter secondary text
  and filled Run / Stop buttons that keep white labels.
- Copyright **© 2026 phuwanat@SUT IRISH LAB** under the name in the top bar,
  and as publisher and copyright of the installer.

## 0.2.0

Points, routes, requests and project files, as set out in
`Mission/docs/mission-builder-v2.md`. Everything is edited in a project that
opens and saves with no robot connected.

- **Robot startup** (⋯ menu, when connected; `Mission/docs/robot-startup.md`):
  the systemd user services that start the robot at boot, through
  mission_runner's `/api/autostart`. A list with each service's state
  ("Running since 08:02", "Failed, restarted 3 times", "Stopped"), what it
  launches and what it starts after, and **Start**, **Stop**, **Restart**,
  **Log** (the last 200 journal lines, with Refresh), **Edit** and **Remove**.
  **Add service…** takes a name, description, the launch file (with
  **Browse…**, a file browser on the robot: places, breadcrumbs, folders first,
  launch files selectable and other files greyed out, and a path you can type)
  or a package and file, launch arguments as `name := value` rows, workspaces
  filled from the chosen file's folders, ROS_DOMAIN_ID, RMW, the services to
  start after and Start now; settings the robot refuses are listed in the
  dialog. **Add the mission layer** fills in `mission_runner bringup.launch.py`
  after the first service, with the `project` argument last used on that robot.
  A banner asks for `sudo loginctl enable-linger <user>` when linger is off,
  with **Try now** and **Copy command**; another says why when the robot cannot
  manage services. Stopping, restarting or removing the service Mission
  Builder is connected through says first that the connection will drop. A
  runner without the endpoint says "Update mission_runner on the robot". The
  list refreshes after each change, on `autostart.changed`, and every 5
  seconds while open. The dev build answers these endpoints from memory with
  `?fake-robot=1` (left out of release builds).

- **Project files** (`project/1`, `.mproj`): a File menu with New project,
  Open…, Open recent, Save, Save as…, Close and Project settings, on Ctrl+N,
  Ctrl+O, Ctrl+S and Ctrl+Shift+S. The title bar and the top bar show the
  project name with a dot while there are unsaved changes, and New, Open, Close
  and closing the window ask first. The last project reopens on start, an
  autosave is written next to it every 30 seconds while there are unsaved
  changes, and it is offered back after a crash. The desktop app uses the Tauri
  dialog and file-system plugins, limited to `.mproj` and `.mproj.autosave`
  files; the browser dev build opens through a file input and saves as a
  download.
- **The project is the source of truth**: connecting to a robot no longer
  replaces what is being edited. **Import from robot** fills the project with
  the robot's maps and missions (replace or merge, asked, and undoable), and
  **Deploy project to robot** sends every map and mission with
  `PUT /api/project`, validating first, with an optional **Replace missions on
  the robot** that lists what it would delete. A robot whose mission_runner has
  no `/api/project` yet is told apart in a sentence: import reads its sites and
  missions one by one, and deploy sends them one at a time (Replace needs the
  newer runner).
- **Points by coordinates**: an **Add point** button in the map's tool strip
  opens a form for name, x, y, heading and kind, with **Robot pose** to fill
  them from where the robot is. A selected point's x, y and heading fields move
  it live as they are typed, with the same undo as a drag.
- **Connect in order**: Ctrl-click several points on the map and connect them
  with two-way lanes in the order they were picked.
- **Lane direction** is three large choices, `A ⇄ B`, `A → B` and `B → A`, and a
  point's lane list reads `⇄ B`, `→ Rack3`, `← Charger`.
- **Follow route is the default drive**: first in *Drive somewhere*, with plain
  go-to-pose renamed *Direct (ignores the route)*. It gains a **Pass through**
  list (`through`), an ordered list of points. The planned chain is computed
  with the runner's rules (Dijkstra over lane length × cost, one-way and
  blocked lanes honoured), shown in the task's properties and as a band on the
  map, and a task the lanes cannot drive is marked red with a sentence saying
  why, for example that the lanes between two points are one-way the other way.
- **Actions at a point**: a selected point lists, per mission, the tasks that
  follow each Follow route to it, with **Add action here**.
- **Ask for an answer** (`ros.request`): publishes a JSON request on a
  `std_msgs/String` topic and waits for the answer with the same id on another,
  the exchange iViz's Dashboard answers. Its form has the question, the answers
  as a list, a default picked from them or typed, the timeout and what happens
  then, the station (defaulting to the last Follow route's point), the topics
  as optional overrides, extra data as key and value rows that may use
  expressions, and a preview of the request exactly as it is published.
- **Request and answer topics per station**: a point can carry its own
  `request_topic` and `answer_topic` (*Questions at this point* in its
  properties, with **Use /station/<name>/request and /answer** to fill a
  suggested pair), so each station's screen or node only receives its own
  questions. Point that station's iViz Dashboard (Settings → Requests/Answers
  topics) or your node at them. A request picks each topic in turn from the
  step, then the point it asks at (its station, or the last Follow route's
  destination), then the project settings. New steps no longer copy the
  project's topics (steps that already carry them keep them); the form shows the
  topic in effect and where it comes from, the tree and a point's actions show a
  request's topic when it is not the project's, and the Python export resolves
  them the same way. A point's topics are checked (they start with `/` and
  differ from each other; a lone one is a warning that the other falls back to
  the project default) and kept through save, import, deploy and `sites.json`.
- **Python export** emits working `follow_route` (planned on the exported
  lanes) and `ros_request` (publish, then spin until the answer or the timeout)
  instead of a to-do comment.
- The guide card over an empty map no longer blocks clicks on the floor under
  it.

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
