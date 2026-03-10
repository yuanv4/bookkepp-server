const http = require("http");
const https = require("https");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { setTimeout: delay } = require("timers/promises");
const { fileURLToPath } = require("url");

const DEFAULT_PORT = 3000;
const BASE_HOST = process.env.TEST_HOST || "http://localhost";
const CHECK_PATH = process.env.HEALTH_PATH || "/health";
const WAIT_TIMEOUT_MS = Number(process.env.SERVER_WAIT_TIMEOUT_MS || 60_000);
const POLL_INTERVAL_MS = 500;
const REQUEST_TIMEOUT_MS = Number(process.env.SERVER_CHECK_TIMEOUT_MS || 2_000);
const DEFAULT_TEST_DB = "dev-test.db";

function parseArgs(argv) {
  const options = {
    mode: "dev",
    build: false,
    resetDb: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    switch (arg) {
      case "--mode":
        options.mode = argv[i + 1] || "dev";
        i += 1;
        break;
      case "--build":
        options.build = true;
        break;
      case "--skip-db-reset":
        options.resetDb = false;
        break;
      default:
        break;
    }
  }

  return options;
}

async function canListenOnPort(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });
}

async function getFreePort(preferredPort) {
  const v4Ok = await canListenOnPort(preferredPort, "127.0.0.1");
  const v6Ok = await canListenOnPort(preferredPort, "::");

  if (v4Ok && v6Ok) return preferredPort;

  const server = net.createServer();
  const port = await new Promise((resolve) => {
    server.once("error", () => resolve(null));
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
  });

  if (!port) {
    throw new Error("无法分配可用端口");
  }

  return port;
}

function requestOnce(url) {
  const client = url.startsWith("https") ? https : http;
  return new Promise((resolve) => {
    const req = client.request(url, { method: "GET" }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on("error", () => resolve(null));
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error("请求超时"));
      resolve(null);
    });
    req.end();
  });
}

async function waitForServerReady(baseUrl) {
  const target = new URL(CHECK_PATH, baseUrl).toString();
  const start = Date.now();
  while (Date.now() - start < WAIT_TIMEOUT_MS) {
    const status = await requestOnce(target);
    if (status) return true;
    await delay(POLL_INTERVAL_MS);
  }
  return false;
}

async function isServerReadyOnce(baseUrl) {
  const target = new URL(CHECK_PATH, baseUrl).toString();
  const status = await requestOnce(target);
  return Boolean(status);
}

function startServer(port, mode, env) {
  const script = mode === "start" ? "start" : "dev";
  console.log(`未检测到可用服务，启动 ${script} 服务器（端口 ${port}）...`);
  const child = spawn("npm", ["run", script, "--", "--port", String(port)], {
    stdio: "inherit",
    shell: true,
    env,
  });
  return child;
}

async function stopDevServer(child) {
  if (!child || child.exitCode !== null) return;
  console.log("测试结束，关闭服务器...");

  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        shell: true,
      });
      killer.on("close", resolve);
      killer.on("error", resolve);
    });
    return;
  }

  child.kill("SIGTERM");
}

function normalizeFileUrl(rawUrl) {
  if (!rawUrl.startsWith("file:")) {
    return rawUrl;
  }

  const pathPart = rawUrl.slice(5);
  if (pathPart.startsWith("./") || pathPart.startsWith("../")) {
    return rawUrl;
  }

  if (/^\/[A-Za-z]:\//.test(pathPart)) {
    return `file:${pathPart.slice(1)}`;
  }

  return rawUrl;
}

function fileUrlToPathSafe(fileUrl, cwd) {
  if (!fileUrl.startsWith("file:")) {
    return null;
  }

  try {
    if (fileUrl.startsWith("file://")) {
      return fileURLToPath(fileUrl);
    }
  } catch {
    return null;
  }

  const pathPart = fileUrl.slice(5);
  if (/^\/[A-Za-z]:\//.test(pathPart)) {
    return path.normalize(pathPart.slice(1));
  }

  if (path.isAbsolute(pathPart)) {
    return path.normalize(pathPart);
  }

  return path.resolve(cwd, pathPart);
}

function resolveTestDatabaseUrl() {
  const envUrl = process.env.DATABASE_URL;
  const url = envUrl || `file:./${DEFAULT_TEST_DB}`;
  return normalizeFileUrl(url);
}

function ensureSafeDbPath(dbPath, cwd) {
  if (!dbPath) return;
  const relative = path.relative(cwd, dbPath);
  const isInsideRepo = relative && !relative.startsWith("..") && !path.isAbsolute(relative);
  const endsWithDefault = path.basename(dbPath) === DEFAULT_TEST_DB;

  if (!isInsideRepo || !endsWithDefault) {
    throw new Error(
      `拒绝重置数据库文件：${dbPath}。请将 DATABASE_URL 指向仓库内的 ${DEFAULT_TEST_DB}，或使用 --skip-db-reset。`
    );
  }
}

async function runCommand(command, args, env) {
  const child = spawn(command, args, {
    stdio: "inherit",
    shell: true,
    env,
  });

  const exitCode = await new Promise((resolve) => {
    child.on("close", resolve);
    child.on("error", () => resolve(1));
  });

  if (exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} 执行失败，退出码：${exitCode}`);
  }
}

async function prepareTestDatabase(dbUrl, resetDb) {
  const cwd = process.cwd();
  const dbPath = fileUrlToPathSafe(dbUrl, cwd);

  if (resetDb && dbPath) {
    ensureSafeDbPath(dbPath, cwd);
    fs.rmSync(dbPath, { force: true });
  }

  await runCommand(
    "npx",
    ["prisma", "db", "push", "--url", dbUrl],
    {
      ...process.env,
      // Windows + Prisma occasionally fails with "Schema engine error" at lower log levels.
      // Force debug log level for stable db push in this repo.
      RUST_LOG: "debug",
    }
  );
}

async function run() {
  let devServer = null;
  let startedByScript = false;

  process.env.RUST_LOG = "debug";

  const options = parseArgs(process.argv.slice(2));
  const serverMode = options.mode === "start" ? "start" : "dev";
  const testDbUrl = resolveTestDatabaseUrl();

  const port = await getFreePort(DEFAULT_PORT);
  const baseUrl = `${BASE_HOST}:${port}`;

  console.log(`准备使用服务地址：${baseUrl}`);

  if (options.build && serverMode === "start") {
    console.log("开始构建应用（tsc --noEmit）...");
    await runCommand("npm", ["run", "build"], process.env);
  }

  console.log(`准备测试数据库：${testDbUrl}`);
  await prepareTestDatabase(testDbUrl, options.resetDb);

  const isReady = await isServerReadyOnce(baseUrl);
  if (!isReady) {
    devServer = startServer(port, serverMode, {
      ...process.env,
      DATABASE_URL: testDbUrl,
    });
    startedByScript = true;

    console.log("等待服务器就绪...");
    const ready = await waitForServerReady(baseUrl);
    if (!ready) {
      await stopDevServer(devServer);
      console.error("等待本地服务就绪超时，请检查启动日志。");
      process.exit(1);
    }
  } else {
    console.log(`检测到服务已就绪，使用 ${baseUrl}`);
  }

  const testProcess = spawn("npm", ["run", "test:inner"], {
    stdio: "inherit",
    shell: true,
    env: {
      ...process.env,
      BASE_URL: baseUrl,
      DATABASE_URL: testDbUrl,
    },
  });

  const exitCode = await new Promise((resolve) => {
    testProcess.on("close", resolve);
    testProcess.on("error", () => resolve(1));
  });

  if (startedByScript) {
    await stopDevServer(devServer);
  }

  process.exit(exitCode ?? 1);
}

run().catch((error) => {
  console.error("运行测试脚本失败：", error);
  process.exit(1);
});
