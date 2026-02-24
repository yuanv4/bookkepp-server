import { describe, expect, test, vi } from "vitest";
import { applyCrossSourceDeduplication } from "../lib/dedupe";

type GroupTransaction = {
  id: string;
  source: string;
  occurredAt: Date;
};

describe("applyCrossSourceDeduplication", () => {
  test("金额存在浮点偏差时也能识别跨来源重复", async () => {
    const groupTransactions: GroupTransaction[] = [
      {
        id: "alipay-1",
        source: "alipay",
        occurredAt: new Date("2025-01-02T10:00:00.000Z"),
      },
      {
        id: "ccb-1",
        source: "ccb",
        occurredAt: new Date("2025-01-02T10:02:00.000Z"),
      },
    ];

    const findMany = vi.fn().mockResolvedValue(groupTransactions);
    const update = vi.fn().mockImplementation((args) => ({ type: "update", args }));
    const updateMany = vi
      .fn()
      .mockImplementation((args) => ({ type: "updateMany", args }));
    const $transaction = vi.fn().mockResolvedValue([]);

    const prisma = {
      transaction: {
        findMany,
        update,
        updateMany,
      },
      $transaction,
    };

    const processedGroups = await applyCrossSourceDeduplication(prisma as never, [
      {
        occurredAt: new Date("2025-01-02T09:59:00.000Z"),
        amount: 12.3000000001,
        direction: "out",
        counterparty: "某商户",
      },
    ]);

    expect(processedGroups).toBe(1);
    expect(findMany).toHaveBeenCalledTimes(1);
    const findManyArgs = findMany.mock.calls[0]?.[0];
    expect(findManyArgs?.where?.amount?.gte).toBeCloseTo(12.295, 6);
    expect(findManyArgs?.where?.amount?.lt).toBeCloseTo(12.305, 6);
    expect(update).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect($transaction).toHaveBeenCalledTimes(1);
  });
});
