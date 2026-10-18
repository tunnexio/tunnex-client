import { test } from "node:test";
import assert from "node:assert/strict";
import { windowChrome, WINDOW_BG, WINDOW_CONTROL_HEIGHT } from "../src/main/windowchrome";

test("Windows blends native controls into the shared dark surface", () => {
  const chrome = windowChrome("win32");
  assert.equal(chrome.titleBarStyle, "hidden");
  assert.deepEqual(chrome.titleBarOverlay, {
    color: WINDOW_BG, symbolColor: "#c7c9bf", height: WINDOW_CONTROL_HEIGHT,
  });
  assert.equal(chrome.title, "Tunnex");
});

test("macOS retains native traffic lights over the same dark surface", () => {
  const chrome = windowChrome("darwin");
  assert.equal(chrome.titleBarStyle, "hiddenInset");
  assert.equal(chrome.titleBarOverlay, undefined);
  assert.equal(chrome.title, "");
});

test("Linux retains working system controls", () => {
  assert.equal(windowChrome("linux").titleBarStyle, undefined);
  assert.equal(windowChrome("linux").title, "Tunnex");
});

test("every platform uses the renderer background before first paint", () => {
  for (const platform of ["darwin", "win32", "linux"] as const) {
    assert.equal(windowChrome(platform).backgroundColor, WINDOW_BG);
  }
});
