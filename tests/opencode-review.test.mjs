import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { collectOpenCodeReviewContext } from "../plugins/codex/scripts/lib/opencode-review.mjs";
import { initGitRepo, makeTempDir, run } from "./helpers.mjs";

function createRepo() {
  const cwd = makeTempDir("opencode-review-");
  initGitRepo(cwd);
  fs.writeFileSync(path.join(cwd, "app.js"), "original\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "base"], { cwd });
  return cwd;
}

test("OpenCode review includes staged, unstaged, and untracked evidence", () => {
  const cwd = createRepo();
  fs.writeFileSync(path.join(cwd, "app.js"), "staged\n");
  run("git", ["add", "app.js"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "unstaged\n");
  fs.writeFileSync(path.join(cwd, "new.js"), "untracked evidence\n");
  const context = collectOpenCodeReviewContext(cwd, { mode: "working-tree" });
  assert.match(context.content, /-original\n\+staged/);
  assert.match(context.content, /-staged\n\+unstaged/);
  assert.match(context.content, /untracked evidence/);
  assert.doesNotMatch(context.collectionGuidance, /Inspect the target diff yourself/);
});

test("OpenCode branch review uses merge-base evidence and excludes working-tree changes", () => {
  const cwd = createRepo();
  run("git", ["checkout", "-b", "feature"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "committed change\n");
  run("git", ["add", "."], { cwd });
  run("git", ["commit", "-m", "feature"], { cwd });
  fs.writeFileSync(path.join(cwd, "app.js"), "local-only change\n");
  const context = collectOpenCodeReviewContext(cwd, { mode: "branch", baseRef: "main" });
  assert.match(context.content, /-original\n\+committed change/);
  assert.doesNotMatch(context.content, /local-only change/);
});

test("OpenCode refuses oversized review context instead of silently omitting the diff", () => {
  const cwd = createRepo();
  fs.writeFileSync(path.join(cwd, "app.js"), "x".repeat(600 * 1024));
  assert.throws(() => collectOpenCodeReviewContext(cwd, { mode: "working-tree" }), /exceeds the 512 KiB inline limit/);
});
