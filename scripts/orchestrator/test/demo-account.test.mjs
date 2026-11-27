import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, demoAccountWalk, RequestClassifier } from "../safety.mjs";

test("off by default: writes are held and risky names recorded", () => {
  const w = demoAccountWalk({}, {});
  assert.equal(w.demo, false);
  assert.equal(w.risky, "record");
  assert.deepEqual(w.allowPost, []);
});

test("--demo-account fires every write and probes risky names", () => {
  const w = demoAccountWalk({ demo: true }, {});
  assert.equal(w.demo, true);
  assert.equal(w.risky, "probe");
  const c = new RequestClassifier({ allowPost: w.allowPost });
  assert.equal(c.classify({ method: "DELETE", url: "https://app.example.com/api/timecards/7", postData: "" }).verdict, "read");
  assert.equal(c.classify({ method: "POST", url: "https://app.example.com/api/approve", postData: '{"id":1}' }).verdict, "read");
});

test("SEEMLY_DEMO_ACCOUNT=1 turns it on, and an existing catch-all is not doubled", () => {
  const w = demoAccountWalk({ allowPost: [/.*/] }, { SEEMLY_DEMO_ACCOUNT: "1" });
  assert.equal(w.demo, true);
  assert.equal(w.allowPost.length, 1);
});

test("sign-out and account-closing names stay held in demo mode", () => {
  assert.equal(classify({ name: "Sign out" }, null).verdict, "never");
  assert.equal(classify({ name: "Delete my account" }, null).verdict, "never");
});
