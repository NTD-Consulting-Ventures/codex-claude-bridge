// NON-LIVE: JobManager with scripted runners; no Codex process is spawned here.

import assert from "node:assert/strict";
import { test } from "node:test";
import { JobManager } from "../src/jobs.js";
import { TaskError } from "../src/session.js";

function gate(): { entered: Promise<void>; release: () => void; hold: () => Promise<void> } {
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((r) => (enter = r));
  const released = new Promise<void>((r) => (release = r));
  return { entered, release, hold: async () => (enter(), await released) };
}

async function settled(jobs: JobManager, id: string): Promise<NonNullable<ReturnType<JobManager["get"]>>> {
  for (let i = 0; i < 200; i++) {
    const v = jobs.get(id);
    if (v && v.state !== "running") return v;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("job did not settle");
}

for (const mode of ["failed", "cancelled"] as const) {
  test(`${mode} runner is not released before owned cleanup settles; late cancel refused`, { timeout: 5_000 }, async () => {
    const jobs = new JobManager(60_000);
    const g = gate();
    let cleaned = false;
    const view = jobs.start("image", async (signal, _t, _id, own) => {
      own(async () => {
        await g.hold();
        cleaned = true;
      });
      if (mode === "failed") throw new TaskError("PROTOCOL_ERROR");
      await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true }));
      throw new TaskError("CANCELLED");
    });
    assert.ok(view);
    if (mode === "cancelled") assert.equal(jobs.cancel(view.job_id), true);
    try {
      await g.entered;
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(jobs.active, view.job_id, "still active while cleanup is outstanding");
      assert.equal(jobs.get(view.job_id)?.state, "running");
      assert.equal(jobs.start("task", async () => "x"), null, "BUSY");
      assert.equal(jobs.cancel(view.job_id), false, "late cancel refused once the runner settled");
      assert.equal(cleaned, false);
    } finally {
      g.release();
    }
    const done = await settled(jobs, view.job_id);
    assert.equal(cleaned, true);
    assert.equal(done.state, mode);
    assert.equal(done.error?.code, mode === "failed" ? "PROTOCOL_ERROR" : "CANCELLED");
    assert.equal(jobs.active, undefined);
  });
}

test("a rejecting cleanup is best effort: error withheld, job still released with its root cause", async () => {
  const jobs = new JobManager(60_000);
  const view = jobs.start("image", async (_s, _t, _id, own) => {
    own(async () => {
      throw new Error("EACCES: permission denied, rm '/Users/someone/out/x'");
    });
    throw new TaskError("IMAGE_VERIFICATION_FAILED");
  });
  assert.ok(view);
  const done = await settled(jobs, view.job_id);
  assert.equal(done.state, "failed");
  assert.deepEqual(done.error, { code: "IMAGE_VERIFICATION_FAILED", retryable: false, likely_cause: "local" });
  assert.deepEqual(done.partial_files, []);
  assert.equal(done.result, null);
  assert.ok(!JSON.stringify(done).includes("EACCES"));
  assert.equal(jobs.active, undefined);
});
