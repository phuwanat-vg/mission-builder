# Mission Builder

A Windows desktop application for building and running Nav2 missions without
writing code. It is a **separate program from iViz**: iViz is the viewer,
Mission Builder is the authoring tool. Both talk to the robot the same way,
over one `foxglove_bridge` WebSocket.

Everything is set up in a **project file** (`.mproj`) that opens, edits,
validates, saves and exports with no robot connected. `mission_runner`
executes missions headless on the robot as a systemd service, armed and running
whether or not this application is open; Mission Builder deploys a project to
it, or imports what a robot already has.

```
Windows                                   Raspberry Pi 5
┌──────────────────────────┐   one WS     ┌──────────────────────────────────┐
│ Mission Builder          │ ───────────▶ │ foxglove_bridge                  │
│  tree · map · properties │              │   ├── /mission/api  (service)    │
└──────────────────────────┘              │   ├── /mission/state /event      │
┌──────────────────────────┐              │   ├── /map, /tf, sensors         │
│ iViz (viewer)            │ ───────────▶ │   └── Nav2                       │
└──────────────────────────┘              │ mission_runner (headless service)│
                                          └──────────────────────────────────┘
```

The contracts this implements are
`D:\WaspIndustry\Mission\docs\mission-builder-app.md` and
`docs/mission-builder-v2.md`; the mission format is `docs/mission-format.md`,
the project file is `runner/mission_runner/schema/project.schema.json` and the
runner's API is `docs/runner-api.md` in the same repository.

## Download

Grab the latest `Mission.Builder_*_x64-setup.exe` (or the `.msi`) from
[Releases](https://github.com/phuwanat-vg/mission-builder/releases). Installed copies
check for new versions themselves, so this is a one-time download.

## The window

```
┌ top bar ────────────────────────────────────────────────────────────────────┐
│ Mission Builder [File] Line 3 delivery ●  ws://robot:8765 [Connect] idle     │
│                              … spacer …   ▶ Run  ‖ Pause  ■ Stop  ⬆ Deploy   │
├ tree 320px ─────────────┬ map (fills) ──────────────┬ properties 340px ──────┤
│ ▾ Missions              │ [Select][Point][Lane]     │ Selected │ Maps        │
│   ▸ patrol              │ [Add point] [Fit]         │                        │
│   ▾ pickup_job          │        ①──────②           │ the selected node,     │
│     ▾ Starts when       │        │      │  ③        │ point, points or lane  │
│     ▾ While running     │      Home    B ───┘       │                        │
│       Settings          │        │                  │                        │
│     ▾ Tasks             │        ④ Charger          │                        │
│     ▸ When it fails     │                           │                        │
├ Activity ───────────────────────────────────────────────────────────────────┤
│ ˄ Activity   patrol finished after 13 s                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

**Project files.** A project is one JSON file (`project/1`, extension
`.mproj`) holding the maps with their points and lanes, every mission, and the
project settings: its name, the robot's address, and the request and answer
topics. The **File** menu has New project, Open…, Open recent, Save, Save as…,
Close and Project settings. The title bar shows the project name and a dot
while there are unsaved changes, and New, Open, Close and closing the window
ask before anything is lost. The last project reopens on start. While there
are unsaved changes an autosave is written every 30 seconds to a sibling
`.mproj.autosave` file, and it is offered back if Mission Builder did not close
cleanly. (The browser dev build has no file system: Open uses a file input,
Save downloads the file, and the autosave lives in the browser's storage.)

**The project is what is being edited**, robot or not. Connecting to a robot
never replaces it. **File → Import from robot** fills the project with the
robot's maps and missions, replacing the project or merging into it (asked;
merge adds what the project lacks and keeps its own version of the rest; both
undo with Ctrl+Z). **File → Deploy project to robot** (or the Deploy button)
checks every mission, then sends the whole project with `PUT /api/project`;
the robot validates everything and writes nothing if one mission is invalid.
**Replace missions on the robot** also removes robot missions the project does
not have, and lists them before you confirm.

**The tree** is the primary editor. It lists the project's missions; the open
one is a view over the ordinary `mission/1` JSON: expand and collapse (remembered per mission), select, add with the `+` on
any container row or from the right-click menu, drag to reorder within a level
and onto another container to move between levels, duplicate, delete, turn off.
While a run is live every step carries a status glyph — waiting, running, done,
failed — and the time it took. A step with a problem carries a warning or error
badge whose tooltip explains it in a sentence. Anything the tree cannot express
is left untouched in the document: step ids and unknown fields round-trip.

**The map** is drawn like an engineering drawing rather than a telemetry
display. A thin tool strip runs along its top edge and a status strip along the
bottom — the tool's one-line hint, the cursor's world position and the map being
edited — and nothing floats over the drawing but a toast. There are two line
weights and no others: a lane is a hairline, the open mission's route is the
emphasis weight. Colour carries meaning and nothing else: lanes muted, the route
the accent, blocked lanes dashed red, run status ok / warn / err. Points are
small open circles whose kind is a tiny outline glyph beside the name, headings
are a short tick, lane directions small open chevrons, and labels are plain text
with a halo instead of a chip. Under the floor plan is a faint 1 m grid.

**Points and routes.** Place a point with the Point tool (click, drag to set
the heading), or type it in with **Add point**: name, x and y in metres,
heading in degrees (0 along +x, counter-clockwise positive) and kind, with
**Robot pose** to fill them from where a connected robot is. A selected
point's x, y and heading fields move it as you type, with the same undo as a
drag. Join points with the Lane tool (Shift for one-way), or Ctrl-click several
and press **Connect in order**. A selected lane's direction is three choices:
`A ⇄ B`, `A → B`, `B → A`.

Every drive follows that graph. **Follow route** is the default way to drive
somewhere (*Direct (ignores the route)* remains for the rare case that needs
it), with an optional **Pass through** list of points visited in order. The
selected task's planned chain is shown in its properties and as a band on the
map, computed with the runner's rules: Dijkstra over lane length × cost, one-way
and blocked lanes honoured. A task the lanes cannot drive is marked red with a
sentence saying why.

**Actions at a point.** A mission is a sequence, so the actions at a point are
the tasks that follow a Follow route to it. A selected point lists them per
mission, with **Add action here**.

**Ask for an answer** (`ros.request`) publishes a JSON request on a
`std_msgs/String` topic and waits for the answer with the same id on another:

```json
{ "id": "a1b2c3d4", "text": "Is the part in place?", "options": ["OK", "Reject"],
  "default": "OK", "timeout_s": 120, "station": "Conveyor1", "source": "mission_runner",
  "mission": "pickup_job", "step_id": "check", "data": { "order": "42" } }
```

answered with `{"id": "a1b2c3d4", "answer": "OK", "by": "iviz"}`. That is the
exchange iViz's Dashboard answers on `/iviz/request` and `/iviz/answer`, so iViz
answers it unchanged, and so can any node, PLC adapter or button box that
echoes the id back. The form edits the question, the answers as a list, the
default (picked from them or typed), how long to wait and what happens then,
the station (by default the last Follow route's point), the topics and extra
data as key and value rows that may use expressions, and it shows the request
exactly as it is published. With *Store the result in* set to `check`, a later
If reads `check.value.answer == 'Reject'`.

**One pair of topics per station.** So that each station's screen or node only
receives its own questions, set the topics on the point: select it and fill
*Questions at this point*, or press **Use /station/conveyor1/request and
/answer** for the suggested pair. Then point that station's iViz Dashboard
(Settings → Requests/Answers topics) or your node at them. A request takes each
topic from the first of: the step's own topic fields (left empty they are only
a placeholder), the point it asks at (its station, or where the last Follow
route ends), and the project settings (`/iviz/request` and `/iviz/answer` by
default). The form says where each topic comes from, and the tree shows a
request's topic when it is not the project's.

**Themes.** *Drafting*, a light drawing surface, is the default; *Dark* is the
original palette. Pick one from the `⋯` menu; it is remembered. Every colour in
the application is a CSS variable selected by `data-theme` on the root element,
and the three.js layers read those same variables, so a switch takes effect
immediately without a reload.

**Maps** lists the project's maps: name, file, how many points and lanes, and
which one the robot has loaded. From there a map is switched, registered,
renamed and deleted. Each map owns its own points and lanes, so a mission
written as "go to Inbound" moves between buildings unchanged.

**Run**, **Pause** and **Stop** drive the runner; Run says so when the robot
does not have the latest version of the project. The **Activity** bar shows the
live event stream and the run history.

**Export** a mission as a standalone `nav2_simple_commander` Python script or as
Nav2 behavior-tree XML, from the mission's right-click menu or the `…` menu.
The script drives Follow routes along the exported lanes and asks
`ros.request`s on their topics, so it works without mission_runner.

## Offline

Nothing about execution needs this application. mission_runner starts at boot,
arms every trigger and runs missions on schedule, on topics, MQTT, PLC signals
and requests, with no GUI connected; a `ros.request` waits for whatever node
answers. A project reaches a robot three ways:

- **Deploy** over the bridge, from this application;
- copy the `.mproj` file by USB or `scp` and, on the robot,
  `mission_runner project import line3.mproj` (add `--replace` to remove
  missions the project does not have), then `sudo systemctl restart mission_runner`;
- `PUT /api/project` from any script.

`mission_runner project export <file>` writes a robot's sites and missions to a
project file, which opens here like any other.

## Keyboard

| Key | What |
|---|---|
| `Ctrl+N` / `Ctrl+O` | New project, open a project |
| `Ctrl+S` / `Ctrl+Shift+S` | Save, save as |
| `V` `N` `L` `F` | Select, Point, Lane, Fit — the map tools. `Esc` returns to Select |
| `Ctrl`+click | Pick several points on the map, for Connect in order |
| `↑` `↓` `←` `→` | Move, collapse and expand in the tree |
| `Alt+↑` / `Alt+↓` | Move the selected step one place within its level |
| `Ins` | Add to the selected container |
| `Ctrl+D` | Duplicate the selected step |
| `Ctrl+E` | Turn the selected step or trigger off, or back on |
| `Del` | Delete the selection |
| `Ctrl+Z` / `Ctrl+Y` | Undo and redo — every map, tree and project edit, one drag or one typed coordinate being one step |

## When something is missing

Each piece degrades on its own and says so in one sentence, and the project can
still be edited, saved and exported:

- **no bridge** — "Not connected to a bridge."
- **a bridge without services, or without `/mission/api`** — "The bridge does not
  advertise /mission/api. Start mission_runner (with mission_msgs built) on the
  robot."
- **the runner offline** — the Activity bar says nothing can be reached and Run,
  Pause, Stop and Deploy are disabled with the reason in their tooltips.
- **a mission_runner older than the project contract** (no `/api/project`) —
  Import reads its sites and missions one by one, and Deploy sends them one at a
  time and says so; Replace missions on the robot needs the newer runner.

## Developing

```
npm install
npm run dev              # http://localhost:1421
npm run build            # tsc --noEmit && vite build
npm run tauri dev        # the desktop shell
npm run tauri build      # the NSIS installer
```

Against a real robot, point the URL box at `ws://<robot>:8765`. Without a
robot, use the pieces the Mission repository already provides:

```
# a simulated runner
D:\WaspIndustry\Mission\.venv\Scripts\python.exe -m mission_runner run --sim \
  --home <path-to>/Mission/.dev-home --port 8080 --host 127.0.0.1

# a mock foxglove_bridge whose /mission/api forwards to that runner (from D:\WaspIndustry\DViz);
# --auto-answer answers requests on /iviz/request, standing in for iViz or a node of yours
npm run mock -- 8766 --auto-answer
```

then connect Mission Builder to `ws://127.0.0.1:8766`.

## What came from iViz

Most of this application is ported from `D:\WaspIndustry\DViz`, copied in
rather than cross-imported, because the two are separate npm packages:

| From iViz | Used for |
|---|---|
| `src/net/FoxgloveConnection.ts` | the bridge connection, subscriptions, publishing, service calls |
| `src/ros/*` | TF tree, message decoding, schemas |
| `src/viz/Viewer.ts`, `src/viz/PointsMaterial.ts`, `src/viz/layers/*` | the three.js scene, the occupancy grid, TF and pose layers, the tool mechanism |
| `src/viz/layers/RouteLayer.ts`, `src/ui/RouteTools.ts` | the route-graph drawing and the point and lane tools |
| `src/mission/{types,ids,expressions,blocks,geometry,validate,stops,MissionApi}.ts` | the mission model, the block registry and validation |
| `src/mission/RouteStore.ts` | the graph half of the store, with the mission half rewritten for the tree |
| `src/ui/{dom,icons,ActionForm}.ts`, `src/style.css` | the DOM helpers, the icons, the generated forms and the palette |
| `src/updater.ts`, `.github/workflows/release.yml`, `tools/set-version.mjs` | releases and in-app updates |
| `src-tauri/*` | the desktop shell |

From `D:\WaspIndustry\Mission\editor\src\codegen\`: `python.ts` and `bt.ts`, the
two exporters, unchanged apart from their import paths.

Written new here: `src/mission/tree.ts` (the tree model over the JSON),
`src/ui/MissionTree.ts`, `src/ui/Properties.ts` (including the lane
configuration), `src/ui/MapsPanel.ts`, `src/ui/Activity.ts`,
`src/ui/MapView.ts`, `src/ui/StepPicker.ts`, `src/ui/exports.ts` and
`src/ui/App.ts`; and for 0.2.0 `src/project/*` (the project document, file
access and the open-project session), `src/ui/AddPointDialog.ts`,
`src/ui/ProjectDialogs.ts`, `src/ui/RequestForm.ts` and `src/ui/modal.ts`.

## Releasing

Versions are set in one place:

```
npm run version:set 0.2.0
git commit -am "release v0.2.0"
git tag v0.2.0
git push && git push --tags
```

The tag runs `.github/workflows/release.yml`, which builds the NSIS installer,
signs the updater artifact and publishes a GitHub Release with `latest.json`.
Installed copies then update themselves through `tauri-plugin-updater`.

### Before the first release

The signing keypair for this application already exists at
`%USERPROFILE%\.tauri\missionbuilder.key` (and `.key.pub`), with an empty
password. Its public half is in `src-tauri/tauri.conf.json`. **The private key
is never committed and was never uploaded anywhere.** To publish:

1. Create the GitHub repository `phuwanat-vg/mission-builder` (that is the
   updater endpoint in `src-tauri/tauri.conf.json`; change it there if you use a
   different one) and push this directory to it.
2. Add two repository secrets under Settings → Secrets and variables → Actions:
   - `TAURI_SIGNING_PRIVATE_KEY` — the whole contents of
     `%USERPROFILE%\.tauri\missionbuilder.key`
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — an empty string
3. Push a tag: `git tag v0.1.0 && git push --tags`.

Keep the private key safe. Losing it means installed copies can no longer verify
an update and every user has to reinstall by hand.
