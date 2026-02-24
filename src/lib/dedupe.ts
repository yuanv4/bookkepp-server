import crypto from "crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import type { TransactionDirection } from "@/lib/types";

const DUPLICATE_REASON = "跨来源同日/金额/方向/对方一致";
const PRIMARY_SOURCE = "alipay";

interface DedupeCandidate {
  occurredAt: Date;
  amount: number;
  direction: TransactionDirection;
  counterparty: string | null;
}

function normalizeAmount(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function normalizeCounterparty(counterparty: string | null): string | null {
  if (!counterparty) return null;
  const trimmed = counterparty.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function getUtcDayRange(date: Date): { start: Date; end: Date; dayKey: string } {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth();
  const day = date.getUTCDate();
  const start = new Date(Date.UTC(year, month, day, 0, 0, 0, 0));
  const end = new Date(Date.UTC(year, month, day + 1, 0, 0, 0, 0));
  const pad = (value: number) => String(value).padStart(2, "0");
  const dayKey = `${year}-${pad(month + 1)}-${pad(day)}`;
  return { start, end, dayKey };
}

function buildGroupKey(candidate: DedupeCandidate): string | null {
  const normalizedCounterparty = normalizeCounterparty(candidate.counterparty);
  if (!normalizedCounterparty) return null;
  const { dayKey } = getUtcDayRange(candidate.occurredAt);
  const normalizedAmount = normalizeAmount(candidate.amount);
  return `${dayKey}|${normalizedAmount.toFixed(2)}|${candidate.direction}|${normalizedCounterparty}`;
}

function buildGroupId(groupKey: string): string {
  const hash = crypto.createHash("sha1").update(groupKey).digest("hex");
  return `dup_${hash.slice(0, 16)}`;
}

export async function applyCrossSourceDeduplication(
  prisma: PrismaClient,
  candidates: DedupeCandidate[]
): Promise<number> {
  const groupSamples = new Map<string, DedupeCandidate>();

  for (const candidate of candidates) {
    const key = buildGroupKey(candidate);
    if (!key || groupSamples.has(key)) continue;
    groupSamples.set(key, candidate);
  }

  let processedGroups = 0;

  for (const [groupKey, sample] of groupSamples.entries()) {
    const normalizedCounterparty = normalizeCounterparty(sample.counterparty);
    if (!normalizedCounterparty) continue;

    const { start, end } = getUtcDayRange(sample.occurredAt);
    const normalizedAmount = normalizeAmount(sample.amount);
    const amountLowerBound = normalizedAmount - 0.005;
    const amountUpperBound = normalizedAmount + 0.005;

    const groupTransactions = await prisma.transaction.findMany({
      where: {
        occurredAt: { gte: start, lt: end },
        amount: { gte: amountLowerBound, lt: amountUpperBound },
        direction: sample.direction,
        counterparty: normalizedCounterparty,
      },
      select: {
        id: true,
        source: true,
        occurredAt: true,
      },
    });

    const sourceSet = new Set(groupTransactions.map((t) => t.source));
    if (sourceSet.size < 2) continue;

    const sorted = groupTransactions.slice().sort((a, b) => {
      const timeDiff = a.occurredAt.getTime() - b.occurredAt.getTime();
      if (timeDiff !== 0) return timeDiff;
      return a.id.localeCompare(b.id);
    });

    const primary = sorted.find((t) => t.source === PRIMARY_SOURCE) ?? sorted[0];
    if (!primary) continue;

    const duplicateGroupId = buildGroupId(groupKey);
    const secondaryIds = sorted
      .filter((t) => t.id !== primary.id)
      .map((t) => t.id);

    const updates = [
      prisma.transaction.update({
        where: { id: primary.id },
        data: {
          isDuplicate: false,
          primaryTransactionId: null,
          duplicateGroupId,
          duplicateReason: DUPLICATE_REASON,
        },
      }),
    ];

    if (secondaryIds.length > 0) {
      updates.push(
        prisma.transaction.updateMany({
          where: { id: { in: secondaryIds } },
          data: {
            isDuplicate: true,
            primaryTransactionId: primary.id,
            duplicateGroupId,
            duplicateReason: DUPLICATE_REASON,
          },
        })
      );
    }

    await prisma.$transaction(updates);

    processedGroups += 1;
  }

  return processedGroups;
}
