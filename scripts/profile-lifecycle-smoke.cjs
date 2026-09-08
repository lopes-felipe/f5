// Real backend isolation checks. Run after building the server; no provider accounts required.
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn, execFileSync } = require("node:child_process");
const { once } = require("node:events");
const { createRequire } = require("node:module");
const WebSocket = createRequire(path.join(process.cwd(), "apps/server/package.json"))("ws");
(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "f5-real-profiles-"));
  const state = path.join(root, "state");
  const children = [];
  const sockets = [];
  const env = {
    ...process.env,
    F5_HOME: root,
    HOME: root,
    USERPROFILE: root,
    CODEX_HOME: path.join(root, ".codex"),
  };
  for (const key of Object.keys(env))
    if (/TOKEN|API_KEY|AUTH_TOKEN|F5_PROFILE|T3CODE_PORT|F5_STATE_DIR|T3CODE_STATE_DIR/i.test(key))
      delete env[key];
  async function freePort() {
    const s = net.createServer();
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
    const p = s.address().port;
    await new Promise((r) => s.close(r));
    return p;
  }
  function launch(args) {
    const child = spawn(
      process.execPath,
      [
        path.resolve("apps/server/dist/index.mjs"),
        "--state-dir",
        state,
        "--host",
        "127.0.0.1",
        "--no-browser",
        ...args,
      ],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    child.output = "";
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (d) => (child.output = (child.output + d).slice(-10000)));
    children.push(child);
    return child;
  }
  async function stop(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const done = once(child, "exit");
    child.kill("SIGTERM");
    await Promise.race([
      done,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("Backend did not stop")), 15000).unref(),
      ),
    ]);
  }
  async function connect(port, child) {
    for (let i = 0; i < 150; i++) {
      if (child.exitCode !== null)
        throw Error("Backend exited " + child.exitCode + " " + child.output);
      try {
        return await new Promise((resolve, reject) => {
          const ws = new WebSocket("ws://127.0.0.1:" + port);
          const timeout = setTimeout(() => {
            ws.terminate();
            reject(Error("welcome timeout"));
          }, 1000);
          ws.on("error", () => {
            clearTimeout(timeout);
            reject(Error("not ready"));
          });
          ws.on("message", (raw) => {
            const msg = JSON.parse(raw);
            if (msg.channel === "server.welcome") {
              clearTimeout(timeout);
              sockets.push(ws);
              resolve({ ws, welcome: msg.data });
            }
          });
        });
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    throw Error("Startup timeout " + child.output);
  }
  let requestId = 0;
  async function rpc(ws, method, body = {}) {
    const id = String(++requestId);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error("RPC timeout " + method)), 15000);
      const listener = (raw) => {
        const value = JSON.parse(raw);
        if (value.id === id) {
          clearTimeout(timer);
          ws.off("message", listener);
          resolve(value);
        }
      };
      ws.on("message", listener);
      ws.send(JSON.stringify({ id, body: { _tag: method, ...body } }));
    });
  }
  function check(value, detail) {
    if (!value) throw Error(detail);
  }
  try {
    const port = await freePort();
    const parent = launch(["--port", String(port)]);
    const first = await connect(port, parent);
    check(first.welcome.profile.isDefault, "Default welcome");
    const created = await rpc(first.ws, "profiles.create", { name: "Work" });
    check(!created.error, JSON.stringify(created));
    const work = created.result;
    check(work && /^[a-f0-9]{32}$/.test(work.id), "created profile id " + JSON.stringify(created));
    const occupied = net.createServer();
    occupied.listen(work.port, "127.0.0.1");
    await once(occupied, "listening");
    const conflict = launch(["--profile", "work"]);
    const [conflictExit] = await once(conflict, "exit");
    check(conflictExit === 78, "Occupied port must exit 78");
    await new Promise((r) => occupied.close(r));
    const secondChild = launch(["--profile", "work"]);
    const second = await connect(work.port, secondChild);
    check(second.welcome.profile.id === work.id, "Work welcome identity");
    check(second.welcome.profile.stateDir !== state, "isolated state");
    const repo = path.join(root, "repo");
    await fs.mkdir(repo);
    execFileSync("git", ["init", repo], { env, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Repository Identity"], { cwd: repo, env });
    execFileSync("git", ["config", "user.email", "repository@example.com"], { cwd: repo, env });
    execFileSync("git", ["commit", "--allow-empty", "-m", "Seed"], {
      cwd: repo,
      env,
      stdio: "ignore",
    });
    await fs.writeFile(path.join(repo, "change.txt"), "Work profile change");
    const identity = await rpc(second.ws, "server.updateSettings", {
      gitAuthorName: "Work Profile",
      gitAuthorEmail: "work@example.com",
    });
    check(!identity.error, "Git identity save " + JSON.stringify(identity));
    const commit = await rpc(second.ws, "git.runStackedAction", {
      cwd: repo,
      action: "commit",
      commitMessage: "Profile author check",
      filePaths: ["change.txt"],
    });
    check(!commit.error, "Managed commit " + JSON.stringify(commit));
    const author = execFileSync("git", ["log", "-1", "--format=%an <%ae>"], {
      cwd: repo,
      env,
      encoding: "utf8",
    }).trim();
    check(author === "Work Profile <work@example.com>", "Managed Git author: " + author);
    const duplicate = launch(["--profile", "work"]);
    const [exit] = await once(duplicate, "exit");
    check(exit === 78, "duplicate exit " + exit + " " + duplicate.output);
    const busy = await rpc(first.ws, "profiles.delete", { profileId: work.id });
    check(!!busy.error, "Live deletion must fail");
    second.ws.close();
    await stop(secondChild);
    const removed = await rpc(first.ws, "profiles.delete", { profileId: work.id });
    check(!removed.error, "Removal " + JSON.stringify(removed));
    const trash = await fs.readdir(path.join(state + "-profiles", ".trash"));
    check(
      trash.some((name) => name.startsWith(work.id)),
      "Trash preserves state",
    );
    first.ws.close();
    await stop(parent);
    const registryFile = path.join(state + "-profiles", "profiles.json");
    await fs.writeFile(registryFile, "{");
    const corrupt = launch(["--profile", "work"]);
    const [corruptExit] = await once(corrupt, "exit");
    check(corruptExit === 78, "Explicit corrupt selection must fail");
    const fallbackChild = launch(["--port", String(port)]);
    const fallback = await connect(port, fallbackChild);
    check(
      fallback.welcome.profileDiagnostic?.code === "malformed",
      "Default must carry diagnostic",
    );
    const refused = await rpc(fallback.ws, "profiles.create", { name: "Blocked" });
    check(!!refused.error, "Corrupt registry mutations must fail");
    check(
      (await fs.readFile(registryFile, "utf8")) === "{",
      "Corrupt registry must not be rewritten",
    );
    console.log(
      "PASS: configured author through real managed Git RPC, simultaneous isolated backends, occupied-port exit 78 without scan, duplicate-instance exit 78, live-delete exclusion, trash removal, explicit corrupt selection failure, Default diagnostic fallback, mutation refusal with byte-identical corrupt registry",
    );
  } finally {
    for (const ws of sockets) ws.terminate();
    for (const child of children) await stop(child).catch(() => child.kill("SIGKILL"));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
