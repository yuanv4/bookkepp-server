import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import prisma from "@/lib/db";
import { applyCrossSourceDeduplication } from "@/lib/dedupe";
import { applyUtcDateRangeFilter } from "@/lib/date-range";
import type { ApiResponse } from "@/lib/types";

const DedupeRequestSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
});

interface ClearResult {
  deletedTransactions: number;
  deletedBatches: number;
}

interface DedupeResult {
  candidateCount: number;
  processedGroups: number;
}

function sendError(reply: FastifyReply, statusCode: number, error: string) {
  return reply.status(statusCode).send({ success: false, error } satisfies ApiResponse<never>);
}

export async function registerMaintenanceRoutes(app: FastifyInstance) {
  app.post("/clear", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const [transactions, batches] = await prisma.$transaction([
        prisma.transaction.deleteMany(),
        prisma.importBatch.deleteMany(),
      ]);

      return reply.send({
        success: true,
        data: {
          deletedTransactions: transactions.count,
          deletedBatches: batches.count,
        },
      } satisfies ApiResponse<ClearResult>);
    } catch (error) {
      console.error("清空数据失败:", error);
      return sendError(reply, 500, error instanceof Error ? error.message : "清空失败");
    }
  });

  app.post("/dedupe", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const body = (request.body as Record<string, unknown> | undefined) ?? {};
      const { startDate, endDate } = DedupeRequestSchema.parse(body);

      const where: Record<string, unknown> = {};
      applyUtcDateRangeFilter(where, startDate, endDate);

      const candidates = await prisma.transaction.findMany({
        where,
        select: {
          occurredAt: true,
          amount: true,
          direction: true,
          counterparty: true,
        },
      });

      const MAX_CANDIDATES = 100_000;
      if (candidates.length > MAX_CANDIDATES) {
        return sendError(reply, 400, "候选数据量过大，请缩小日期范围");
      }

      const processedGroups = await applyCrossSourceDeduplication(prisma, candidates);

      return reply.send({
        success: true,
        data: {
          candidateCount: candidates.length,
          processedGroups,
        },
      } satisfies ApiResponse<DedupeResult>);
    } catch (error) {
      console.error("重复检测失败:", error);
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, `参数格式错误: ${error.errors[0]?.message}`);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "重复检测失败");
    }
  });
}
