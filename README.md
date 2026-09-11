# Mission Builder

A Windows desktop application for building and running Nav2 missions without
writing code. It is a **separate program from iViz**: iViz is the viewer,
Mission Builder is the authoring tool. Both talk to the robot the same way,
over one `foxglove_bridge` WebSocket.

Nothing on the robot changes. `mission_runner` already executes missions
headless as a systemd service, armed and running whether or not this
application is open. Mission Builder is a window onto it.

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

The contract this implements is
`D:\WaspIndustry\Mission\docs\mission-builder-app.md`; the mission format is
`docs/mission-format.md` and the runner's API is `docs/runner-api.md` in the
same repository.

## Download

Grab the latest `Mission.Builder_*_x64-setup.exe` (or the `.msi`) from
[Releases](https://github.com/phuwanat-vg/mission-builder/releases). Installed copies
check for new versions themselves, so this is a one-time download.

## The window

```
┌ top bar ────────────────────────────────────────────────────────────────────┐
│ Mission Builder  ws://robot:8765 [Connect] ● connected  idle                 │
│                              … spacer …   ▶ Run  ‖ Pause  ■ Stop  ⬆ Deploy   │
├ tree 320px ─────────────┬ map (fills) ──────────────┬ properties 340px ──────┤
│ ▾ Missions              │        ①──────②           │ Selected │ Maps        │
│   ▸ patrol              │        │      │  ③        │                        │
│   ▾ pickup_job          │      Home    B ───┘       │ the selected node,     │
│     ▾ Starts when       │        │                  │ point or lane          │
│     ▾ While running     │        ④ Charger          │                        │
│       Settings          │                           │                        │
│     ▾ Tasks             │ [Select][Point][Lane][Fit]│                        │
│     ▸ When it fails     │                           │                        │
├ Activity ───────────────────────────────────────────────────────────────────┤
│ ˄ Activity   patrol finished after 13 s                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

**The tree** is the primary editor. It is a view over the ordinary `mission/1`
JSON: expand and collapse (remembered per mission), select, add with the `+` on
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

**Themes.** *Drafting*, a light drawing surface, is the default; *Dark* is the
original palette. Pick one from the `⋯` menu; it is remembered. Every colour in
the application is a CSS variable selected by `data-theme` on the root element,
and the three.js layers read those same variables, so a switch takes effect
immediately without a reload.

**Maps** lists what the robot knows from `sites.json`: name, file, how many
points and lanes, and which one is loaded. From there a map is switched,
registered, renamed and deleted. Each map owns its own points and lanes, so a
mission written as "go to Inbound" moves between buildings unchanged.

**Deploy** validates, then writes the mission (`PUT /api/missions/{name}`) and
the map data (`PUT /api/sites`) in one action; the button says what it is about
to save. **Run**, **Pause** and **Stop** drive the runner. The **Activity** bar
shows the live event stream and the run history.

**Export** a mission as a standalone `nav2_simple_commander` Python script or as
Nav2 behavior-tree XML, from the mission's right-click menu or the `…` menu.

## Keyboard

| Key | What |
|---|---|
| `V` `N` `L` `F` | Select, Point, Lane, Fit — the map tools. `Esc` returns to Select |
| `↑` `↓` `←` `→` | Move, collapse and expand in the tree |
| `Alt+↑` / `Alt+↓` | Move the selected step one place within its level |
| `Ins` | Add to the selected container |
| `Ctrl+D` | Duplicate the selected step |
| `Ctrl+E` | Turn the selected step or trigger off, or back on |
| `Del` | Delete the selection |
| `Ctrl+Z` / `Ctrl+Y` | Undo and redo — every map and tree edit, one drag being one step |
| `Ctrl+S` | Deploy |

## When something is missing

Each piece degrades on its own and says so in one sentence, and the mission can
still be edited and exported:

- **no bridge** — "Not connected to a bridge."
- **a bridge without services, or without `/mission/api`** — "The bridge does not
  advertise /mission/api. Start mission_runner (with mission_msgs built) on the
  robot."
- **the runner offline** — the Activity bar says nothing can be reached and Run,
  Pause, Stop and Deploy are disabled with the reason in their tooltips.

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

# a mock foxglove_bridge whose /mission/api forwards to that runner (from D:\WaspIndustry\DViz)
npm run mock -- 8766
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
`src/ui/App.ts`.

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
