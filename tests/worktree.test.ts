import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import test from "node:test";
import { createWorktree as createWorktreeLive, removeWorktree } from "../src/worktree.js";

test("createWorktree no-ops (not isolated) outside a git repo", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-nogit-"));
  try {
    const wt = await createWorktreeLive(dir, "run-1-0-task");
    assert.equal(wt.isolated, false);
    assert.equal(wt.cwd, dir);
    assert.match(wt.reason ?? "", /not a git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createWorktree isolates in a git repo, then removeWorktree cleans up", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-9-0-edit");
    assert.equal(wt.isolated, true);
    assert.ok(wt.cwd !== repo && existsSync(wt.cwd), "worktree dir exists");
    assert.ok(existsSync(join(wt.cwd, "file.txt")), "worktree has a checkout");

    // Editing inside the worktree must not touch the base tree.
    writeFileSync(join(wt.cwd, "file.txt"), "changed in worktree\n");
    assert.equal(readFileSync(join(repo, "file.txt"), "utf8"), "base\n");

    await removeWorktree(wt);
    assert.ok(!existsSync(wt.cwd), "worktree dir removed");
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", wt.branch ?? ""], { encoding: "utf8" });
    assert.equal(branches.trim(), "", "branch deleted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree falls back when git fails (non-git directory)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-wt-noexec-"));
  try {
    const wt = await createWorktreeLive(dir, "run-1-0-task");

    assert.equal(wt.isolated, false);
    assert.equal(wt.cwd, dir);
    assert.ok(wt.reason, "should provide a fallback reason when git fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("removeWorktree does not throw when worktree directory is already missing", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-missing-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-missing-dir");
    assert.equal(wt.isolated, true);

    // Remove the worktree directory so git worktree remove --force fails
    rmSync(wt.cwd, { recursive: true, force: true });
    assert.ok(!existsSync(wt.cwd), "worktree dir removed manually before removeWorktree");

    // removeWorktree must not throw despite git commands failing
    await assert.doesNotReject(removeWorktree(wt));
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree gives repeated long names independent retained worktrees", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-retained-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    // These names intentionally share the complete 32-character slug prefix.
    const name = "same-run-id-with-a-very-long-label-that-would-previously-collide";
    const first = await createWorktreeLive(repo, name);
    assert.equal(first.isolated, true);
    writeFileSync(join(first.cwd, "retained.txt"), "first execution\n");

    const second = await createWorktreeLive(repo, name);
    assert.equal(second.isolated, true);
    assert.notEqual(second.cwd, first.cwd, "a later execution must not reuse a retained worktree");
    assert.notEqual(second.branch, first.branch, "a later execution owns a distinct branch");
    assert.equal(readFileSync(join(first.cwd, "retained.txt"), "utf8"), "first execution\n");
    assert.equal(
      existsSync(join(second.cwd, "retained.txt")),
      false,
      "later worktree starts from base, not retained edits",
    );
    assert.equal(existsSync(join(repo, "retained.txt")), false, "retained edits never reach the base checkout");

    await removeWorktree(second);
    await removeWorktree(first);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree checks out a deep tree that fits the main checkout without core.longpaths", async () => {
  // Without core.longpaths (Git for Windows' default) git cannot create a
  // directory path of 248 characters or more, so every character the worktree
  // location adds to the repository root is taken from the tracked paths.
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-deep-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  const segments: string[] = [];
  while (join(repo, ...segments).length < 200) segments.push("segment-12");
  const deepDir = join(...segments);
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("config", "core.longpaths", "false");
    mkdirSync(join(repo, deepDir), { recursive: true });
    writeFileSync(join(repo, deepDir, "f.txt"), "deep\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-1700000000000-abcdef-12-implement-the-feature");
    assert.equal(wt.isolated, true, wt.reason);
    assert.ok(wt.cwd.length - repo.length <= 24, `worktree path adds ${wt.cwd.length - repo.length} characters`);
    assert.ok(existsSync(join(wt.cwd, deepDir, "f.txt")), "the deep file is checked out");
    await removeWorktree(wt);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("createWorktree skips an id whose directory or branch is still taken", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-taken-")));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: "pipe" });
  // Feed createWorktree known ids through node:crypto, which it imports.
  const crypto = createRequire(import.meta.url)("node:crypto") as { randomBytes: (size: number) => Buffer };
  const randomBytes = crypto.randomBytes;
  const ids = ["aaaaaaaa", "bbbbbbbb", "cccccccc"];
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");
    // A retained branch whose tree was deleted by hand, and a retained tree.
    git("branch", "pi/wf/run-taken-aaaaaaaa");
    const retained = join(repo, ".pi", "worktrees", "bbbbbbbb");
    mkdirSync(retained, { recursive: true });
    writeFileSync(join(retained, "keep.txt"), "retained\n");

    crypto.randomBytes = (size) => (ids.length ? Buffer.from(ids.shift() ?? "", "hex") : randomBytes(size));
    syncBuiltinESMExports();
    const wt = await createWorktreeLive(repo, "run-taken").finally(() => {
      crypto.randomBytes = randomBytes;
      syncBuiltinESMExports();
    });

    assert.equal(wt.isolated, true, wt.reason);
    assert.equal(wt.cwd, join(repo, ".pi", "worktrees", "cccccccc"));
    assert.equal(wt.branch, "pi/wf/run-taken-cccccccc");
    assert.equal(existsSync(join(repo, ".pi", "worktrees", "aaaaaaaa")), false, "a skipped id releases its directory");
    assert.equal(readFileSync(join(retained, "keep.txt"), "utf8"), "retained\n");
    await removeWorktree(wt);
    assert.notEqual(git("branch", "--list", "pi/wf/run-taken-aaaaaaaa").trim(), "", "the retained branch survives");
  } finally {
    crypto.randomBytes = randomBytes;
    syncBuiltinESMExports();
    rmSync(repo, { recursive: true, force: true });
  }
});

test("removeWorktree preserves the branch when a locked worktree cannot be removed", async () => {
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-failrm-"));
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    writeFileSync(join(repo, "file.txt"), "base\n");
    git("add", ".");
    git("commit", "-q", "-m", "init");

    const wt = await createWorktreeLive(repo, "run-fail-rm");
    assert.equal(wt.isolated, true);

    git("worktree", "lock", "--reason", "test lock", wt.cwd);
    await assert.doesNotReject(removeWorktree(wt));
    assert.ok(existsSync(wt.cwd), "a locked worktree remains inspectable after failed cleanup");
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", wt.branch ?? ""], { encoding: "utf8" });
    assert.notEqual(branches.trim(), "", "failed worktree removal must not delete its branch");

    git("worktree", "unlock", wt.cwd);
    await removeWorktree(wt);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("a hung git is bounded by the exec timeout (audit2 #21)", {
  // execFile resolves only .exe/.com files on Windows PATH, so the shell-script
  // shim below would never run there: the real git would fail fast instead.
  skip: process.platform === "win32" && "a shell-script git shim on PATH is never executed on Windows",
}, async () => {
  // A fake `git` that sleeps forever, so even the first git call hangs:
  // createWorktree must fail fast instead of blocking agent spawn indefinitely.
  const shimDir = mkdtempSync(join(tmpdir(), "pi-wt-shim-"));
  writeFileSync(join(shimDir, "git"), "#!/bin/sh\nsleep 600\n", { mode: 0o755 });
  const repo = mkdtempSync(join(tmpdir(), "pi-wt-hang-"));
  const originalPath = process.env.PATH;
  process.env.PATH = `${shimDir}${delimiter}${originalPath}`;
  try {
    const started = Date.now();
    const wt = await createWorktreeLive(repo, "run-hang-0-task", { timeoutMs: 150 });
    const elapsed = Date.now() - started;
    assert.equal(wt.isolated, false, "the timed-out git fails the worktree (falls back to base cwd)");
    assert.match(wt.reason ?? "", /timed out/, "the hang, not a missing repository, ended the attempt");
    assert.ok(elapsed < 10_000, `bounded (took ${elapsed}ms, not the default 30s or forever)`);
  } finally {
    process.env.PATH = originalPath;
    rmSync(shimDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

/** Quote a value as one POSIX shell word. */
const shellWord = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** Paths of the worktrees in `git worktree list --porcelain` output, in native form (git prints "/" on Windows). */
const listedWorktrees = (porcelain: string) =>
  porcelain
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => resolve(line.slice("worktree ".length)));

test("a timed-out worktree add cleans up only its half-created branch, tree, and registration (audit2 #21 r1)", async () => {
  // A post-checkout hook runs after `worktree add` has created the branch,
  // checked out the tree and registered it, so hanging there leaves REAL
  // residue when the timeout kills git (r2: a pure-sleep fake made the cleanup
  // assertions vacuous). Git runs hooks through its own shell on every
  // platform, so this needs no PATH shim and uses the real git end to end.
  // Before hanging, the hook also creates an unrelated missing worktree
  // registration AFTER the target add; this proves cleanup does not use
  // global `git worktree prune`. GIT_TRACE logs every git command run.
  const fixtureDir = mkdtempSync(join(tmpdir(), "pi-wt-add-hang-fixture-"));
  const hooksDir = join(fixtureDir, "hooks");
  const commandLog = join(fixtureDir, "git-trace.log");
  const fixtureReady = join(fixtureDir, "fixture-ready");
  const fixtureRegistrations = join(fixtureDir, "fixture-registrations");
  const fixtureBranches = join(fixtureDir, "fixture-branches");
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-add-hang-")));
  const worktreesDir = join(repo, ".pi", "worktrees");
  const staleWorktree = join(repo, "unrelated-missing-worktree");
  mkdirSync(hooksDir);
  writeFileSync(
    join(hooksDir, "post-checkout"),
    [
      "#!/bin/sh",
      // --no-checkout: the fixture worktree must not re-trigger this hook.
      `git -C ${shellWord(repo)} worktree add --quiet --no-checkout -b unrelated-stale ${shellWord(staleWorktree)} HEAD`,
      `rm -rf ${shellWord(staleWorktree)}`,
      `git -C ${shellWord(repo)} worktree list --porcelain > ${shellWord(fixtureRegistrations)}`,
      `git -C ${shellWord(repo)} branch --list unrelated-stale > ${shellWord(fixtureBranches)}`,
      `echo ready > ${shellWord(fixtureReady)}`,
      // Far beyond the timeout below, yet finite should the hook survive it.
      "sleep 60",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    // Absolute and repo-local, so no inherited hook configuration can bypass the fixture.
    git("config", "core.hooksPath", hooksDir);
    writeFileSync(join(repo, "f.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "init");

    process.env.GIT_TRACE = commandLog;
    const started = Date.now();
    // 2s is comfortably above the tiny repo's real `worktree add` plus the
    // hook's fixture commands (r3: 200ms raced it — under load the add was
    // killed before registering, making the cleanup assertions vacuous again).
    const wt = await createWorktreeLive(repo, "run-addhang-0-task", { timeoutMs: 2_000 }).finally(() => {
      delete process.env.GIT_TRACE;
    });
    const elapsed = Date.now() - started;

    assert.equal(wt.isolated, false);
    assert.match(wt.reason ?? "", /timed out/, "an honest timeout reason, not 'not a git repository'");
    assert.ok(elapsed < 15_000, `bounded (took ${elapsed}ms)`);
    assert.equal(
      readFileSync(fixtureReady, "utf8"),
      "ready\n",
      "the hook created its unrelated stale fixture before timeout cleanup",
    );
    assert.ok(
      listedWorktrees(readFileSync(fixtureRegistrations, "utf8")).includes(staleWorktree),
      "the unrelated missing registration existed before target cleanup",
    );
    assert.notEqual(
      readFileSync(fixtureBranches, "utf8").trim(),
      "",
      "the unrelated stale branch existed before target cleanup",
    );
    // One "trace: built-in: git <args>" line per git process; arguments with
    // special characters (e.g. Windows backslashes) are single-quoted.
    const commands = readFileSync(commandLog, "utf8")
      .split("\n")
      .flatMap((line) => /trace: built-in: git (.*)$/.exec(line)?.[1] ?? []);
    assert.ok(
      !commands.some((command) => command.startsWith("worktree prune")),
      "cleanup never runs global worktree prune",
    );
    const removal = "worktree remove --force ";
    const cleanupPaths = commands
      .filter((command) => command.startsWith(removal))
      .map((command) => command.slice(removal.length).replace(/^'(.*)'$/, "$1"));
    assert.equal(cleanupPaths.length, 2, "cleanup retries removal only for its known path after rm");
    assert.equal(new Set(cleanupPaths).size, 1, "both cleanup removals target the same generated worktree");
    assert.equal(dirname(cleanupPaths[0]), worktreesDir, "cleanup never targets the unrelated registration");
    const branches = git("branch", "--list", "pi/wf/*");
    assert.equal(branches.trim(), "", "the half-created branch was cleaned up");
    assert.ok(!existsSync(worktreesDir) || readdirSync(worktreesDir).length === 0, "no partial checkout left behind");
    const registrations = listedWorktrees(git("worktree", "list", "--porcelain"));
    assert.equal(registrations.includes(cleanupPaths[0]), false, "no target worktree registration remains");
    assert.ok(registrations.includes(staleWorktree), "unrelated missing registration survives target cleanup");
    assert.notEqual(git("branch", "--list", "unrelated-stale").trim(), "", "unrelated stale branch survives too");
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
});

/** Whether `pid` ends within `withinMs` (an exiting process may linger briefly). */
async function processEnds(pid: number, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs;
  for (;;) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    if (Date.now() > deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
}

test("a timed-out worktree add ends the hook processes git started, so cleanup is prompt and complete", async () => {
  // A hook that starts a native process in the new tree (a dependency install,
  // an LFS fetch) outlives a timeout that kills only git. On Windows that
  // process keeps the tree busy, so cleanup retried for seconds and could
  // still leave the directory behind.
  const fixtureDir = mkdtempSync(join(tmpdir(), "pi-wt-hook-tree-fixture-"));
  const hooksDir = join(fixtureDir, "hooks");
  const pidFile = join(fixtureDir, "holder.pid");
  const repo = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-hook-tree-")));
  const worktreesDir = join(repo, ".pi", "worktrees");
  const holder = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000)`;
  mkdirSync(hooksDir);
  writeFileSync(
    join(hooksDir, "post-checkout"),
    `#!/bin/sh\n${shellWord(process.execPath.replaceAll("\\", "/"))} -e ${shellWord(holder)}\n`,
    { mode: 0o755 },
  );
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let holderPid = 0;
  try {
    git("init", "-q");
    git("config", "user.email", "t@t.t");
    git("config", "user.name", "t");
    git("config", "core.hooksPath", hooksDir);
    writeFileSync(join(repo, "f.txt"), "base\n");
    git("add", ".");
    git("commit", "-qm", "init");

    const timeoutMs = 2_000;
    const started = Date.now();
    const wt = await createWorktreeLive(repo, "run-hooktree-0-task", { timeoutMs });
    const elapsed = Date.now() - started;

    assert.equal(wt.isolated, false);
    assert.match(wt.reason ?? "", /timed out/);
    assert.ok(existsSync(pidFile), "the hook started its process before the timeout");
    holderPid = Number(readFileSync(pidFile, "utf8"));
    assert.ok(await processEnds(holderPid, 2_000), "the hook's process ended with the timed-out git");
    assert.ok(elapsed < timeoutMs + 5_000, `cleanup did not wait on the hook (took ${elapsed}ms)`);
    assert.equal(git("branch", "--list", "pi/wf/*").trim(), "", "the half-created branch was cleaned up");
    assert.ok(!existsSync(worktreesDir) || readdirSync(worktreesDir).length === 0, "no directory left behind");
  } finally {
    if (holderPid && !(await processEnds(holderPid, 0))) process.kill(holderPid);
    rmSync(fixtureDir, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
