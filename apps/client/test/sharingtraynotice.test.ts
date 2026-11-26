import { test } from "node:test";
import assert from "node:assert/strict";
import { keepSharingNotice, noticeOnWindowHidden } from "../src/main/sharingtraynotice";

// LS-CLIENT-1: closing the window keeps shares running in the tray. The first time that
// happens, say so once, without blocking, and remember it in the local settings.
test("keep-sharing notice pluralizes and says how to stop", () => {
  assert.deepEqual(keepSharingNotice(1), {title:"Local Sharing is still on", body:"Tunnex is still sharing 1 app. Quit Tunnex to stop sharing."});
  assert.equal(keepSharingNotice(3).body, "Tunnex is still sharing 3 apps. Quit Tunnex to stop sharing.");
});

test("notice shows once, only with active shares, and is remembered", () => {
  let remembered = false;
  const shown: string[] = [];
  const store = {shown: () => remembered, markShown: () => { remembered = true; }};
  const show = (notice: {body: string}) => { shown.push(notice.body); return true; };
  assert.equal(noticeOnWindowHidden(0, store, show), false);
  assert.equal(remembered, false);
  assert.equal(noticeOnWindowHidden(2, store, show), true);
  assert.equal(noticeOnWindowHidden(2, store, show), false);
  assert.deepEqual(shown, ["Tunnex is still sharing 2 apps. Quit Tunnex to stop sharing."]);
  assert.equal(remembered, true);
});

test("an unsupported or failing notification is not remembered and never throws", () => {
  let remembered = false;
  const store = {shown: () => remembered, markShown: () => { remembered = true; }};
  assert.equal(noticeOnWindowHidden(1, store, () => false), false);
  assert.equal(remembered, false);
  assert.equal(noticeOnWindowHidden(1, store, () => { throw new Error("no notification center"); }), false);
  assert.equal(remembered, false);
  const broken = {shown: () => { throw new Error("store unreadable"); }, markShown: () => {}};
  assert.equal(noticeOnWindowHidden(1, broken, () => true), false);
});
