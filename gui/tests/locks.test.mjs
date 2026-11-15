import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { nodeSys, tempDir } from "./helpers.mjs";

const pythonCanLock = (path) => {
  const code = "import fcntl,sys\nf=open(sys.argv[1],'a+')\ntry:\n fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)\n print('free')\nexcept BlockingIOError:\n print('held')";
  return execFileSync("python3", ["-I", "-c", code, path], { encoding: "utf8" }).trim() === "free";
};

test("held against Python's flock, free right after release; the lock file is kept", async (t) => {
  const dir = tempDir(t);
  const path = join(dir, "note.lock");
  const sys = nodeSys();
  const lock = await sys.holdLock(path, { waitSeconds: 0 });
  assert.ok(lock && !lock.unlocked);
  assert.equal(pythonCanLock(path), false);
  assert.equal(await sys.holdLock(path, { waitSeconds: 0 }), null, "a second holder is refused");
  await lock.release();
  assert.equal(pythonCanLock(path), true);
  assert.ok(existsSync(path), "lockf -k keeps the file like the Python plugin");
});

test("a deleted pipe or the time limit ends the helper by itself", async (t) => {
  const dir = tempDir(t);
  const sys = nodeSys();
  const started = Date.now();
  const lock = await sys.holdLock(join(dir, "a.lock"), { waitSeconds: 0 });
  for (const name of (await sys.readdir(dir)).filter((n) => n.includes(".gui-"))) rmSync(join(dir, name));
  await lock.ended;
  assert.ok(Date.now() - started < 8000, "noticed the missing pipe within one 5 s wake-up");
  assert.equal(pythonCanLock(join(dir, "a.lock")), true);

  const short = await sys.holdLock(join(dir, "b.lock"), { waitSeconds: 0, maxSeconds: 5 });
  await short.ended;
  assert.equal(pythonCanLock(join(dir, "b.lock")), true);
});

test("waits for a lock up to waitSeconds", async (t) => {
  const dir = tempDir(t);
  const sys = nodeSys();
  const path = join(dir, "c.lock");
  writeFileSync(path, "");
  const first = await sys.holdLock(path, { waitSeconds: 0 });
  const waiting = sys.holdLock(path, { waitSeconds: 5 });
  await new Promise((resolve) => setTimeout(resolve, 500));
  await first.release();
  const second = await waiting;
  assert.ok(second && !second.unlocked, "acquired once the first let go");
  await second.release();
});
