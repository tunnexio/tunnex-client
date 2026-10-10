import { test } from "node:test";
import assert from "node:assert/strict";
import { NotificationInbox, notificationScope, type StoredNotice } from "../src/main/notificationinbox";

test("notice inbox persists read state, deduplicates events and scopes security alerts",()=>{
  let saved:StoredNotice[] = [], scope:string|null = notificationScope("https://cp.example","first-token");
  const persistence = {read:()=>saved,write:(entries:StoredNotice[])=>{saved=entries;}};
  const inbox = new NotificationInbox(persistence,()=>scope);
  inbox.record("device_revoked","device-one","Device revoked","Contact your administrator.");
  inbox.record("device_revoked","device-one","Device revoked","Contact your administrator.");
  inbox.record("access_revoked","app-one:episode-one","App access revoked","You no longer have access to Checkout.");
  assert.equal(inbox.list().length,2);
  assert.doesNotMatch(JSON.stringify(saved),/first-token|cp.example/);
  assert.doesNotMatch(JSON.stringify(inbox.list()),/scope|read/);
  const notice = inbox.list()[0]; inbox.markRead(notice.id);
  inbox.record("access_revoked","app-one:episode-one","App access revoked","Repeated verdict.");
  assert.equal(new NotificationInbox(persistence,()=>scope).list().length,1);
  const firstScope=scope; scope=notificationScope("https://other.example","second-token");
  assert.equal(inbox.list().length,0);
  inbox.markRead(inbox.list()[0]?.id ?? notice.id); // another scope cannot alter this entry
  scope=firstScope;assert.equal(inbox.list().length,1);
  scope=null;assert.equal(inbox.list().length,0);
});
test("updates use a global deduplicated notice and only definitive release changes replace it",()=>{
  let saved:StoredNotice[]=[];
  const inbox=new NotificationInbox({read:()=>saved,write:entries=>{saved=entries;}},()=>null);
  inbox.release({kind:"available",version:"0.1.8"});
  assert.equal(inbox.list()[0].kind,"update_available");
  inbox.release({kind:"unavailable",reason:"network error"});assert.equal(inbox.list().length,1);
  inbox.markRead(inbox.list()[0].id);
  inbox.release({kind:"available",version:"0.1.8"});assert.equal(inbox.list().length,0);
  inbox.release({kind:"available",version:"0.1.9"});assert.equal(inbox.list().length,1);
  inbox.release({kind:"current",version:"0.1.9"});assert.equal(inbox.list().length,0);
});
test("inbox persistence failure cannot interrupt revocation and records are bounded",()=>{
  const inbox=new NotificationInbox({read:()=>{throw Error("read error");},write:()=>{throw Error("disk full");}},()=>"account");
  for(let i=0;i<110;i++) inbox.record("device_revoked",String(i),"Device revoked","Contact administrator.");
  assert.equal(inbox.list().length,100);
  assert.throws(()=>inbox.markRead("../../credential.bin"),/notification_invalid/);
});
