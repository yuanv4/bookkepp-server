import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import { registerImportRoutes } from "@/server/routes/import";
import { registerLedgerRoutes } from "@/server/routes/ledger";
import { registerAnalysisRoutes } from "@/server/routes/analysis";
import { registerMaintenanceRoutes } from "@/server/routes/maintenance";
import type { ApiResponse } from "@/lib/types";

export function buildApp() {
  const app = Fastify({
    logger: false,
    bodyLimit: 20 * 1024 * 1024,
  });

  app.register(multipart, {
    limits: {
      fileSize: 10 * 1024 * 1024,
      files: 1,
    },
  });

  app.get("/", async () => ({ success: true }));
  app.get("/health", async () => ({ success: true }));

  app.register(registerImportRoutes, { prefix: "/api/import" });
  app.register(registerLedgerRoutes, { prefix: "/api/ledger" });
  app.register(registerAnalysisRoutes, { prefix: "/api/analysis" });
  app.register(registerMaintenanceRoutes, { prefix: "/api/maintenance" });

  app.setErrorHandler((error, _request: FastifyRequest, reply: FastifyReply) => {
    if (reply.sent) return;
    console.error("请求处理失败:", error);
    reply.status(500).send({
      success: false,
      error: error instanceof Error ? error.message : "服务异常",
    } satisfies ApiResponse<never>);
  });

  return app;
}
