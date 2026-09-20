// build-info.js — the game's version number. One line, one job.
//
// BUMP THIS ON EVERY PATCH. It is the only place the version is written: the HUD
// and the browser tab title both read it from here, so changing this number is
// all it takes for the version to move everywhere it appears.
//
// It exists because the HUD used to show a hand-edited "v0.6.1" that had gone
// unchanged for many releases. That made a device serving hours-old cached
// JavaScript look exactly like a device serving the newest build, which cost a
// real afternoon: a load bar, a sprint control and a connection fix all appeared
// "not deployed" when they were deployed and the phone was simply holding stale
// code. A version that actually moves turns that into a glance.
//
// So: after deploying, look at the top-left on the device. If it does not show
// the version you just shipped, that device is on cached JS — hard-refresh
// rather than debugging the feature.
export const VERSION = '0.16.0';
