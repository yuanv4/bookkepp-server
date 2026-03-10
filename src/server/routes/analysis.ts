import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import prisma from "@/lib/db";
import { applyUtcDateRangeFilter } from "@/lib/date-range";
import type { ApiResponse } from "@/lib/types";

const QueryParamsSchema = z.object({
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  accountName: z.string().optional(),
  source: z.enum(["alipay", "ccb", "cmb", "spdb"]).optional(),
});

type Summary = {
  totalCount: number;
  totalExpense: number;
  totalIncome: number;
  netIncome: number;
};

type TrendPoint = {
  period: string;
  income: number;
  expense: number;
  net: number;
  totalCount: number;
};

type CategoryPoint = {
  category: string;
  amount: number;
};

type AccountPoint = {
  accountName: string;
  income: number;
  expense: number;
};

type SourcePoint = {
  source: string;
  income: number;
  expense: number;
};

type CounterpartyPoint = {
  counterparty: string;
  amount: number;
};

type AlipayAnalysis = {
  summary: Summary;
  monthly: TrendPoint[];
  categories: CategoryPoint[];
  counterparties: CounterpartyPoint[];
  accounts: AccountPoint[];
};

type AnalysisPayload = {
  summary: Summary;
  monthly: TrendPoint[];
  yearly: TrendPoint[];
  trend: TrendPoint[];
  categories: CategoryPoint[];
  accounts: AccountPoint[];
  sources: SourcePoint[];
  counterparties: CounterpartyPoint[];
  alipay: AlipayAnalysis;
  dateRange: {
    start: string;
    end: string;
  } | null;
};

function sendError(reply: FastifyReply, statusCode: number, error: string) {
  return reply.status(statusCode).send({ success: false, error } satisfies ApiResponse<never>);
}

function formatDateOutput(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function getMonthKey(date: Date): string {
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${date.getUTCFullYear()}-${month}`;
}

function getYearKey(date: Date): string {
  return String(date.getUTCFullYear());
}

function upsertTrendPoint(map: Map<string, TrendPoint>, period: string, isIncome: boolean, amount: number): void {
  const point = map.get(period) ?? {
    period,
    income: 0,
    expense: 0,
    net: 0,
    totalCount: 0,
  };

  if (isIncome) {
    point.income += amount;
  } else {
    point.expense += amount;
  }
  point.totalCount += 1;
  point.net = point.income - point.expense;
  map.set(period, point);
}

export async function registerAnalysisRoutes(app: FastifyInstance) {
  app.get("/summary", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const params = QueryParamsSchema.parse(request.query ?? {});
      const { startDate, endDate, accountName, source } = params;

      const baseWhere: Record<string, unknown> = {
        isDuplicate: false,
      };

      if (accountName) {
        baseWhere.accountName = accountName;
      }

      if (source) {
        baseWhere.source = source;
      }

      let appliedStart = startDate;
      let appliedEnd = endDate;

      if (!startDate || !endDate) {
        const rangeResult = await prisma.transaction.aggregate({
          where: baseWhere,
          _min: { occurredAt: true },
          _max: { occurredAt: true },
        });
        const minDate = rangeResult._min.occurredAt ?? null;
        const maxDate = rangeResult._max.occurredAt ?? null;
        if (minDate && maxDate) {
          appliedStart = appliedStart ?? formatDateOutput(minDate);
          appliedEnd = appliedEnd ?? formatDateOutput(maxDate);
        }
      }

      const where: Record<string, unknown> = { ...baseWhere };
      applyUtcDateRangeFilter(where, appliedStart, appliedEnd);

      const transactions = await prisma.transaction.findMany({
        where,
        select: {
          occurredAt: true,
          amount: true,
          direction: true,
          category: true,
          accountName: true,
          source: true,
          counterparty: true,
        },
      });

      const summary: Summary = {
        totalCount: 0,
        totalExpense: 0,
        totalIncome: 0,
        netIncome: 0,
      };

      const monthlyMap = new Map<string, TrendPoint>();
      const yearlyMap = new Map<string, TrendPoint>();
      const categoryMap = new Map<string, number>();
      const accountMap = new Map<string, { income: number; expense: number }>();
      const sourceMap = new Map<string, { income: number; expense: number }>();
      const counterpartyMap = new Map<string, number>();
      const alipaySummary: Summary = {
        totalCount: 0,
        totalExpense: 0,
        totalIncome: 0,
        netIncome: 0,
      };
      const alipayMonthlyMap = new Map<string, TrendPoint>();
      const alipayCategoryMap = new Map<string, number>();
      const alipayCounterpartyMap = new Map<string, number>();
      const alipayAccountMap = new Map<string, { income: number; expense: number }>();

      for (const transaction of transactions) {
        summary.totalCount += 1;

        const isIncome = transaction.direction === "in";
        if (isIncome) {
          summary.totalIncome += transaction.amount;
        } else {
          summary.totalExpense += transaction.amount;
        }

        upsertTrendPoint(monthlyMap, getMonthKey(transaction.occurredAt), isIncome, transaction.amount);
        upsertTrendPoint(yearlyMap, getYearKey(transaction.occurredAt), isIncome, transaction.amount);

        const accountKey = transaction.accountName?.trim() || "未知帐号";
        const accountBucket = accountMap.get(accountKey) ?? { income: 0, expense: 0 };
        if (isIncome) {
          accountBucket.income += transaction.amount;
        } else {
          accountBucket.expense += transaction.amount;
        }
        accountMap.set(accountKey, accountBucket);

        const sourceKey = transaction.source;
        const sourceBucket = sourceMap.get(sourceKey) ?? { income: 0, expense: 0 };
        if (isIncome) {
          sourceBucket.income += transaction.amount;
        } else {
          sourceBucket.expense += transaction.amount;
        }
        sourceMap.set(sourceKey, sourceBucket);

        if (!isIncome) {
          const categoryKey = transaction.category?.trim() || "未分类";
          categoryMap.set(categoryKey, (categoryMap.get(categoryKey) ?? 0) + transaction.amount);

          const counterpartyKey = transaction.counterparty?.trim() || "未指定";
          counterpartyMap.set(counterpartyKey, (counterpartyMap.get(counterpartyKey) ?? 0) + transaction.amount);
        }

        if (transaction.source === "alipay") {
          alipaySummary.totalCount += 1;
          if (isIncome) {
            alipaySummary.totalIncome += transaction.amount;
          } else {
            alipaySummary.totalExpense += transaction.amount;
          }

          upsertTrendPoint(alipayMonthlyMap, getMonthKey(transaction.occurredAt), isIncome, transaction.amount);

          const alipayAccountKey = transaction.accountName?.trim() || "未知帐号";
          const alipayAccountBucket = alipayAccountMap.get(alipayAccountKey) ?? { income: 0, expense: 0 };
          if (isIncome) {
            alipayAccountBucket.income += transaction.amount;
          } else {
            alipayAccountBucket.expense += transaction.amount;
            const alipayCategoryKey = transaction.category?.trim() || "未分类";
            alipayCategoryMap.set(alipayCategoryKey, (alipayCategoryMap.get(alipayCategoryKey) ?? 0) + transaction.amount);

            const alipayCounterpartyKey = transaction.counterparty?.trim() || "未指定";
            alipayCounterpartyMap.set(
              alipayCounterpartyKey,
              (alipayCounterpartyMap.get(alipayCounterpartyKey) ?? 0) + transaction.amount
            );
          }
          alipayAccountMap.set(alipayAccountKey, alipayAccountBucket);
        }
      }

      summary.netIncome = summary.totalIncome - summary.totalExpense;
      alipaySummary.netIncome = alipaySummary.totalIncome - alipaySummary.totalExpense;

      const monthly = Array.from(monthlyMap.values()).sort((a, b) => a.period.localeCompare(b.period));
      const yearly = Array.from(yearlyMap.values()).sort((a, b) => a.period.localeCompare(b.period));

      const categories = Array.from(categoryMap.entries())
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10);

      const accounts = Array.from(accountMap.entries())
        .map(([accountName, values]) => ({ accountName, ...values }))
        .sort((a, b) => b.expense + b.income - (a.expense + a.income));

      const sources = Array.from(sourceMap.entries())
        .map(([sourceName, values]) => ({ source: sourceName, ...values }))
        .sort((a, b) => b.expense + b.income - (a.expense + a.income));

      const counterparties = Array.from(counterpartyMap.entries())
        .map(([counterparty, amount]) => ({ counterparty, amount }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10);

      const alipayMonthly = Array.from(alipayMonthlyMap.values()).sort((a, b) => a.period.localeCompare(b.period));

      const alipayCategories = Array.from(alipayCategoryMap.entries())
        .map(([category, amount]) => ({ category, amount }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10);

      const alipayCounterparties = Array.from(alipayCounterpartyMap.entries())
        .map(([counterparty, amount]) => ({ counterparty, amount }))
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 10);

      const alipayAccounts = Array.from(alipayAccountMap.entries())
        .map(([accountName, values]) => ({ accountName, ...values }))
        .sort((a, b) => b.expense + b.income - (a.expense + a.income));

      return reply.send({
        success: true,
        data: {
          summary,
          monthly,
          yearly,
          trend: monthly,
          categories,
          accounts,
          sources,
          counterparties,
          alipay: {
            summary: alipaySummary,
            monthly: alipayMonthly,
            categories: alipayCategories,
            counterparties: alipayCounterparties,
            accounts: alipayAccounts,
          },
          dateRange: appliedStart && appliedEnd ? { start: appliedStart, end: appliedEnd } : null,
        },
      } satisfies ApiResponse<AnalysisPayload>);
    } catch (error) {
      console.error("分析统计失败:", error);
      if (error instanceof z.ZodError) {
        return sendError(reply, 400, `参数格式错误: ${error.issues[0]?.message}`);
      }
      return sendError(reply, 500, error instanceof Error ? error.message : "统计失败");
    }
  });
}
