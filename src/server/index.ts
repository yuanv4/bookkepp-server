import { buildApp } from "@/server/app";

function resolvePort(): number {
  const fromEnv = Number(process.env.PORT);
  if (!Number.isNaN(fromEnv) && fromEnv > 0) return fromEnv;

  const args = process.argv;
  const portIndex = args.findIndex((arg) => arg === "--port" || arg === "-p");
  if (portIndex >= 0) {
    const parsed = Number(args[portIndex + 1]);
    if (!Number.isNaN(parsed) && parsed > 0) return parsed;
  }

  return 3000;
}

async function start() {
  const app = buildApp();
  const port = resolvePort();

  try {
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`Server is running on http://localhost:${port}`);
  } catch (error) {
    console.error("启动服务失败:", error);
    process.exit(1);
  }
}

start();
