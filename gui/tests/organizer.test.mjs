import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  flatBullets, parseResponse, buildRequest, workerResult, runWorker, organizeText, extractReply, OrganizeError,
} from "../lib/organizer.js";
import { nodeSys, oracle, outcome, tempDir } from "./helpers.mjs";

function response(text, { status = "completed", type = "output_text" } = {}) {
  return { status, output: [{ type: "message", role: "assistant", content: [{ type, text }] }] };
}

test("flat_bullets validation matches the Python plugin", async () => {
  const cases = ["- one\n- two", "- one\n\n  \n- two  ", "* star", "- ", "-no space", "- a\n  - nested",
    "- tab\there", "- cr\rhere", "", "  - indented", "- ok\u2028- separator", "- emoji 📝\n- 日本"];
  const python = oracle(cases.map((text) => ({ fn: "flat_bullets", args: { text } })));
  for (const [i, text] of cases.entries()) {
    assert.deepEqual(await outcome(() => flatBullets(text)), python[i], JSON.stringify(text));
  }
});

test("parse_response matches the Python plugin", async () => {
  const cases = [
    [response("- a\n- b"), false],
    [response("- a", { status: "incomplete" }), false],
    [response("no", { type: "refusal" }), false],
    [{ status: "completed", output: [{ type: "reasoning" }, ...response("- kept").output] }, false],
    [{ status: "completed", output: [] }, true],
    [{ status: "completed", output: [] }, false],
    [response("   "), true],
    [{ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text" }] }] }, false],
    [[], false],
  ];
  const python = oracle(cases.map(([r, importing]) => ({ fn: "parse_response", args: { response: r, importing } })));
  for (const [i, [r, importing]] of cases.entries()) {
    const mine = await outcome(() => parseResponse(r, { importing }));
    // Python raises KeyError for a missing text; both become "invalid result" at the worker boundary.
    if (python[i].error === "KeyError") assert.equal(mine.error, "TypeError");
    else assert.deepEqual(mine, python[i], JSON.stringify(r));
  }
});

test("request bodies and input checks match the Python worker", async () => {
  const payloads = [
    { note: "my note" },
    { note: "my note", organization_prompt: "  group by owner  " },
    { note: "my note", organization_prompt: "   " },
    { note: "agent reply", extraction_prompt: "only the TODOs" },
    { note: "agent reply", extraction_prompt: "" },
    { note: "   " },
    { note: 5 },
    { note: "x", extraction_prompt: 7 },
    { note: "x", organization_prompt: ["bad"] },
    { note: "x", extraction_prompt: "a", organization_prompt: "b" },
    { note: "unicode café 日本 📝 \"quotes\"", organization_prompt: "naïve" },
  ];
  const python = oracle(payloads.map((payload) => ({ fn: "worker", args: { payload } })));
  for (const [i, payload] of payloads.entries()) {
    const expected = python[i].ok;
    let mine;
    try {
      mine = { request: buildRequest(payload).body };
    } catch (error) {
      assert.ok(error instanceof OrganizeError, String(error));
      mine = { error: error.message };
    }
    assert.deepEqual(mine, expected, JSON.stringify(payload));
  }
});

test("HTTP and worker exit codes map to the Python messages", () => {
  const ok = JSON.stringify(response("- done"));
  assert.equal(workerResult({ code: 0, stdout: ok + "\n200" }, false), "- done");
  const cases = [
    [{ code: 3, stdout: "" }, "OPENAI_API_KEY is missing; export it in ~/.zprofile."],
    [{ code: 0, stdout: "{}\n401" }, "OpenAI rejected the API key; original kept."],
    [{ code: 0, stdout: "{}\n403" }, "This API key cannot use the model; original kept."],
    [{ code: 0, stdout: "{}\n404" }, "GPT-5.6 Luna is unavailable to this API key; original kept."],
    [{ code: 0, stdout: "{}\n429" }, "OpenAI quota or rate limit reached; try again later."],
    [{ code: 0, stdout: "{}\n500" }, "OpenAI request failed (HTTP 500); original kept."],
    [{ code: 0, stdout: "moved\n302" }, "OpenAI request failed (HTTP 302); original kept."],
    [{ code: 0, stdout: "not json\n200" }, "OpenAI returned an invalid result; original kept."],
    [{ code: 6, stdout: "" }, "Could not reach OpenAI; original kept."],
    [{ code: 28, stdout: "" }, "Could not reach OpenAI; original kept."],
    [{ code: 63, stdout: "" }, "OpenAI returned too much text; original kept."],
    [{ code: 0, stdout: "x".repeat(2_000_001) + "\n200" }, "OpenAI returned too much text; original kept."],
  ];
  for (const [result, message] of cases) {
    assert.throws(() => workerResult(result, false), (e) => e instanceof OrganizeError && e.message === message);
  }
});

/** A fake `curl` (a zsh function in the login profile, or a script on PATH) recording what it got. */
function fakeCurl(dir, reply) {
  writeFileSync(join(dir, "reply.json"), JSON.stringify(reply));
  return [
    "curl() {",
    `  printf '%s\\n' "$@" > '${dir}/args'`,
    `  cat > '${dir}/stdin'`,
    '  for a in "$@"; do case "$a" in @*) cp "${a#@}" ' + `'${dir}/body.json'` + ";; esac; done",
    `  cat '${dir}/reply.json'; printf '\\n200'`,
    "}",
  ].join("\n");
}

test("login-zsh worker: profile key, rotation, inherited fallback; key never in arguments", async (t) => {
  if (!existsSync("/bin/zsh")) return t.skip("no zsh");
  const dir = tempDir(t);
  const scratch = join(dir, "requests");
  await nodeSys().exec("/bin/mkdir", ["-m", "700", scratch]);
  const saved = { ZDOTDIR: process.env.ZDOTDIR, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
  process.env.ZDOTDIR = dir;
  const sys = nodeSys();
  const profile = (key) => writeFileSync(join(dir, ".zprofile"),
    (key ? `export OPENAI_API_KEY=${key}\n` : "") + fakeCurl(dir, response("- organized")) + "\n");

  for (const [inherited, configured, expected] of [
    ["test-inherited-key", null, "test-inherited-key"],
    [null, "test-profile-key", "test-profile-key"],
    ["test-inherited-key", "test-profile-key", "test-profile-key"],
  ]) {
    if (inherited) process.env.OPENAI_API_KEY = inherited;
    else delete process.env.OPENAI_API_KEY;
    profile(configured);
    assert.equal(await organizeText(sys, scratch, "first note\nsecond line", "group it"), "- organized");
    assert.equal(readFileSync(join(dir, "stdin"), "utf8"), `Authorization: Bearer ${expected}\n`);
    const args = readFileSync(join(dir, "args"), "utf8");
    assert.ok(!args.includes("test-") && args.includes("--max-redirs\n0") && args.includes("--proto\n=https"));
    const body = JSON.parse(readFileSync(join(dir, "body.json"), "utf8"));
    assert.equal(body.model, "gpt-5.6-luna");
    assert.deepEqual(JSON.parse(body.input), { organization_request: "group it", notes: "first note\nsecond line" });
    assert.deepEqual(readdirSync(scratch), [], "the request file is removed");
    if (configured) {
      profile("test-rotated-key");
      await extractReply(sys, scratch, "reply text", "");
      assert.equal(readFileSync(join(dir, "stdin"), "utf8"), "Authorization: Bearer test-rotated-key\n");
    }
  }
  delete process.env.OPENAI_API_KEY;
  profile(null);
  await assert.rejects(organizeText(sys, scratch, "note"), (e) => e.message === "OPENAI_API_KEY is missing; export it in ~/.zprofile.");
});

test("without zsh the worker uses the inherited environment directly", async (t) => {
  const dir = tempDir(t);
  const scratch = join(dir, "requests");
  await nodeSys().exec("/bin/mkdir", ["-m", "700", scratch]);
  writeFileSync(join(dir, "curl"), "#!/bin/sh\n" + fakeCurl(dir, response("- direct")) + '\ncurl "$@"\n', { mode: 0o755 });
  const saved = { PATH: process.env.PATH, OPENAI_API_KEY: process.env.OPENAI_API_KEY };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
  process.env.PATH = `${dir}:${process.env.PATH}`;
  process.env.OPENAI_API_KEY = "test-direct-key";
  const sys = { ...nodeSys(), exists: async (p) => p !== "/bin/zsh" && existsSync(p) };
  assert.equal(await runWorker(sys, scratch, { note: "x" }), "- direct");
  assert.equal(readFileSync(join(dir, "stdin"), "utf8"), "Authorization: Bearer test-direct-key\n");
  assert.ok(!readFileSync(join(dir, "args"), "utf8").includes("test-direct-key"));
});
