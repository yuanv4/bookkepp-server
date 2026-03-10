import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import prisma from "@/lib/db";
import { applyUtcDateRangeFilter } from "@/lib/date-range";
import type { ApiResponse, PaginatedResult } from "@/lib/types";

const QueryParamsSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  accountName: z.string().optional(),
  direction: z.enum(["in", "out"]).optional(),
  keyword: z.string().optional(),
  page: z.coerce.number().min(1).default(1),
  pageSize: z.coerce.number().min(1).max(100).default(20),
});

const ExportQueryParamsSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  accountName: z.string().optional(),
  direction: z.enum(["in", "out"]).optional(),
  keyword: z.string().optional(),
});

interface TransactionWithBatch {
  id: string;
  occurredAt: Date;
  amount: number;
  direction: string;
  currency: string;
  counterparty: string | null;
  description: string | null;
  category: string | null;
  accountName: string | null;
  source: string;
  sourceRowId: string;
  createdAt: Date;
  importBatch: {
    fileName: string;
  };
}

interface Stats {
  totalCount: number;
  totalExpense: number;
  totalIncome: number;
  netIncome: number;
}

function sendError(reply: FastifyReply, statusCode: number, error: string) {
  return reply.status(statusCode).send({ success: false, error } satisfies ApiResponse<never>);
}

function applyKeywordFilters(where: Record<string, unknown>, keyword?: string) {
  if (!keyword) return;

  const orConditions: Record<string, unknown>[] = [
    { counterparty: { contains: keyword } },
    { description: { contains: keyword } },
    { category: { contains: keyword } },
    { accountName: { contains: keyword } },
    { source: { contains: keyword } },
  ];

  const amountValue = Number.parseFloat(keyword.replace(/[,，\s]/g, ""));
  if (!Number.isNaN(amountValue)) {
    orConditions.push({ amount: amountValue });
  }

  if (keyword.includes("支付宝") || keyword.toLowerCase().includes("alipay")) {
    orConditions.push({ source: "alipay" });
  }
  if (keyword.includes("建设银行") || keyword.includes("建行") || keyword.toLowerCase().includes("ccb")) {
    orConditions.push({ source: "ccb" });
  }
  if (keyword.includes("招商银行") || keyword.includes("招行") || keyword.toLowerCase().includes("cmb")) {
    orConditions.push({ source: "cmb" });
  }
  if (
    keyword.includes("浦发银行") ||
    keyword.includes("浦东发展银行") ||
    keyword.toLowerCase().includes("spdb")
  ) {
    orConditions.push({ source: "spdb" });
  }

  where.OR = orConditions;
}

function escapeCsvValue(value: string | number | null): string {
  if (value == null) return "";
  const raw = String(value);
  if (/[",\n\r]/.test(raw)) {
    return `"${raw.replace(/"/g, '""')}"`;
  }
  return raw;
}

function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hour = String(date.getUTCHours()).padStart(2, "0");
  const minute = String(date.getUTCMinutes()).padStart(2, "0");
  const second = String(date.getUTCSeconds()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}

function buildFileName(): string {
  const ts = formatDate(new Date()).replace(/[-:\s]/g, "");
  return `ledger-export-${ts}.csv`;
}

export async function registerLedgerRoutes(app: FastifyInstance) {
  app.get("/accounts", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const records = await prisma.transaction.findMany({
        where: {
          isDuplicate: false,
          accountName: { not: null },
        },
        select: { accountName: true },
        distinct: ["accountName"],
      });

      const accounts = Array.from(
        new Set(
          records
            .map((record) => record.accountName?.trim() || "")
            .filter((name) => name.length > 0)
        )
      ).sort((a, b) => a.localeCompare(b, "zh-CN"));

      return reply.send({
        success: true,
        data: accounts,
      } satisfies ApiResponse<string[]>);
    } catch (error) {
      console.error("获取帐号列表失败:", error);
      return sendError(reply, 500, error instanceof Error ? error.message : "查询失败");
    }
  });

  app.get("/query", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = QueryParamsSchema.parse(request.query ?? {});
      const { startDate, endDate, accountName, direction, keyword, page, pageSize } = params;

      const where: Record<string, unknown> = {
        isDuplicate: false,
      };

      applyUtcDateRangeFilter(where, startDate, endDate);

      if (accountName) {
        where.accountName = accountName;
      }

      if (direction) {
        where.direction = direction;
      }

      applyKeywordFilters(where, keyword);

      const total = await prisma.transaction.count({ where });

      const transactions = await prisma.transaction.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          importBatch: {
            select: {
              fileName: true,
            },
          },
        },
      });

      return reply.send({
        success: true,
        data: {
          data: transactions,
          total,
          page,
          pageSize,
          totalPages: Math.ceil(total / pageSize),
        },
      } satisfies ApiResponse<PaginatedResult<TransactionWithBatch>>);
    } catch (error) {
      console.error("查询交易记录失败:", error);
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, `参数格式错误: ${error.errors[0]?.message}`);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "查询失败");
    }
  });

  app.get("/stats", async (_request: FastifyRequest, reply: FastifyReply) => {
    try {
      const totalCount = await prisma.transaction.count({
        where: { isDuplicate: false },
      });

      const expenseResult = await prisma.transaction.aggregate({
        where: { direction: "out", isDuplicate: false },
        _sum: { amount: true },
      });

      const incomeResult = await prisma.transaction.aggregate({
        where: { direction: "in", isDuplicate: false },
        _sum: { amount: true },
      });

      const totalExpense = expenseResult._sum.amount || 0;
      const totalIncome = incomeResult._sum.amount || 0;

      return reply.send({
        success: true,
        data: {
          totalCount,
          totalExpense,
          totalIncome,
          netIncome: totalIncome - totalExpense,
        },
      } satisfies ApiResponse<Stats>);
    } catch (error) {
      console.error("统计失败:", error);
      return sendError(reply, 500, error instanceof Error ? error.message : "统计失败");
    }
  });

  app.get("/export", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = ExportQueryParamsSchema.parse(request.query ?? {});
      const { startDate, endDate, accountName, direction, keyword } = params;

      const where: Record<string, unknown> = {
        isDuplicate: false,
      };

      applyUtcDateRangeFilter(where, startDate, endDate);

      if (accountName) {
        where.accountName = accountName;
      }

      if (direction) {
        where.direction = direction;
      }

      applyKeywordFilters(where, keyword);

      const transactions = await prisma.transaction.findMany({
        where,
        orderBy: { occurredAt: "desc" },
        select: {
          occurredAt: true,
          amount: true,
          direction: true,
          currency: true,
          counterparty: true,
          description: true,
          category: true,
          accountName: true,
          source: true,
          balance: true,
          status: true,
          counterpartyAccount: true,
          transactionId: true,
          merchantOrderId: true,
          memo: true,
          cashRemit: true,
          sourceRowId: true,
        },
      });

      const headers = [
        "occurredAt",
        "amount",
        "direction",
        "currency",
        "counterparty",
        "description",
        "category",
        "accountName",
        "source",
        "balance",
        "status",
        "counterpartyAccount",
        "transactionId",
        "merchantOrderId",
        "memo",
        "cashRemit",
        "sourceRowId",
      ];

      const lines: string[] = [];
      lines.push(headers.join(","));

      for (const tx of transactions) {
        const row = [
          formatDate(tx.occurredAt),
          tx.amount,
          tx.direction,
          tx.currency,
          tx.counterparty,
          tx.description,
          tx.category,
          tx.accountName,
          tx.source,
          tx.balance,
          tx.status,
          tx.counterpartyAccount,
          tx.transactionId,
          tx.merchantOrderId,
          tx.memo,
          tx.cashRemit,
          tx.sourceRowId,
        ].map(escapeCsvValue);
        lines.push(row.join(","));
      }

      const csvContent = lines.join("\n");
      const fileName = buildFileName();

      reply.header("Content-Type", "text/csv; charset=utf-8");
      reply.header("Content-Disposition", `attachment; filename="${fileName}"`);
      return reply.send(csvContent);
    } catch (error) {
      console.error("导出 CSV 失败:", error);
      return sendError(reply, 500, error instanceof Error ? error.message : "导出失败");
    }
  });
}
