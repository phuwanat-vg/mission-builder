import { App } from "./ui/App";

const root = document.getElementById("app");
if (!root) throw new Error("#app not found");
const app = new App(root);

// Handy from the dev-tools console while developing (never in a release build).
if (import.meta.env.DEV) (window as unknown as { app: App }).app = app;

// `?fake-robot=1`: answer Robot startup's /api/autostart from memory, so the
// dialog can be driven without a robot. The whole branch, and the module it
// loads, is dropped from production builds.
if (import.meta.env.DEV && new URLSearchParams(location.search).has("fake-robot")) {
  void import("./dev/fakeAutostart").then((m) => m.installFakeAutostart(app.api, new URLSearchParams(location.search)));
}

// During `vite dev`, tear down the old instance (WebSocket, render loop, timers)
// before the module is re-evaluated, so nothing is left running twice.
if (import.meta.hot) {
  import.meta.hot.dispose(() => app.dispose());
}
