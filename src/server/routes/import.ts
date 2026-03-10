import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { parseFile } from "@/lib/parsers";
import prisma from "@/lib/db";
import { applyCrossSourceDeduplication } from "@/lib/dedupe";
import type { Prisma } from "@/generated/prisma/client";
import type { ApiResponse, BillSource, ParseResult } from "@/lib/types";

const MAX_FILE_SIZE = 10 * 1024 * 1024;
const MAX_ROWS = 5000;
const ALLOWED_TYPES = [
  "text/csv",
  "application/vnd.ms-excel",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/pdf",
];
const ALLOWED_EXTENSIONS = [".csv", ".xls", ".xlsx", ".pdf"];

function isAllowedFile(fileName: string, mimeType: string): boolean {
  const lowerName = fileName.toLowerCase();
  return ALLOWED_TYPES.includes(mimeType) || ALLOWED_EXTENSIONS.some((ext) => lowerName.endsWith(ext));
}

const TransactionDraftSchema = z.object({
  occurredAt: z.string().transform((s) => {
    const date = new Date(s);
    if (isNaN(date.getTime())) throw new Error("无效日期");
    return date;
  }),
  amount: z.number().positive("金额必须为正数").max(100_000_000, "金额超出合理范围"),
  direction: z.enum(["in", "out"]),
  currency: z.string().max(10).default("CNY"),
  counterparty: z.string().max(200).nullable(),
  description: z.string().max(500).nullable(),
  category: z.string().max(100).nullable(),
  accountName: z.string().max(100).nullable(),
  source: z.enum(["alipay", "ccb", "cmb", "spdb"]),
  sourceRaw: z.string().max(5000),
  sourceRowId: z.string().max(200),
  balance: z.number().min(-100_000_000).max(100_000_000).nullable(),
  status: z.string().max(100).nullable(),
  counterpartyAccount: z.string().max(200).nullable(),
  transactionId: z.string().max(200).nullable(),
  merchantOrderId: z.string().max(200).nullable(),
  memo: z.string().max(500).nullable(),
  cashRemit: z.string().max(20).nullable(),
});

type TransactionDraft = z.infer<typeof TransactionDraftSchema>;

const CommitRequestSchema = z.object({
  fileName: z.string().max(255),
  fileSize: z.number().int().positive().max(MAX_FILE_SIZE),
  source: z.enum(["alipay", "ccb", "cmb", "spdb"]),
  sourceType: z.enum(["csv", "xls", "pdf"]),
  drafts: z.array(TransactionDraftSchema).max(MAX_ROWS),
  warningCount: z.number().int().min(0).default(0),
});

interface CommitResult {
  batchId: string;
  rowCount: number;
  skippedCount: number;
}

const BATCH_SIZE = 100;

function buildTransactionData(draft: TransactionDraft, batchId: string): Prisma.TransactionCreateManyInput {
  return {
    occurredAt: draft.occurredAt,
    amount: draft.amount,
    direction: draft.direction,
    currency: draft.currency,
    counterparty: draft.counterparty,
    description: draft.description,
    category: draft.category,
    accountName: draft.accountName,
    source: draft.source,
    sourceRaw: draft.sourceRaw,
    sourceRowId: draft.sourceRowId,
    importBatchId: batchId,
    balance: draft.balance,
    status: draft.status,
    counterpartyAccount: draft.counterpartyAccount,
    transactionId: draft.transactionId,
    merchantOrderId: draft.merchantOrderId,
    memo: draft.memo,
    cashRemit: draft.cashRemit,
  };
}

function sendError(reply: FastifyReply, statusCode: number, error: string) {
  return reply.status(statusCode).send({ success: false, error } satisfies ApiResponse<never>);
}

export async function registerImportRoutes(app: FastifyInstance) {
  app.post("/parse", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const filePart = await request.file();
      if (!filePart) {
        return sendError(reply, 400, "请上传文件");
      }

      const sourceTypeRaw = filePart.fields.sourceType?.value;
      const sourceRaw = filePart.fields.source?.value;
      const sourceType = sourceTypeRaw === "csv" || sourceTypeRaw === "xls" || sourceTypeRaw === "pdf" ? sourceTypeRaw : null;
      const source = sourceRaw === "alipay" || sourceRaw === "ccb" || sourceRaw === "cmb" || sourceRaw === "spdb" ? sourceRaw : null;

      if (!isAllowedFile(filePart.filename, filePart.mimetype)) {
        return sendError(reply, 400, "不支持的文件类型，请上传 CSV、XLS 或 PDF 文件");
      }

      const buffer = await filePart.toBuffer();
      if (buffer.byteLength > MAX_FILE_SIZE) {
        return sendError(reply, 400, `文件大小超过限制（最大 ${MAX_FILE_SIZE / 1024 / 1024}MB）`);
      }

      const result = await parseFile(
        buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength),
        filePart.filename,
        sourceType || undefined,
        (source as BillSource | null) || undefined
      );

      if (result.drafts.length > MAX_ROWS) {
        return sendError(reply, 400, `解析行数超过限制（最大 ${MAX_ROWS} 行）`);
      }

      return reply.send({
        success: true,
        data: result,
      } satisfies ApiResponse<ParseResult>);
    } catch (error) {
      console.error("解析文件失败:", error);
      return sendError(reply, 500, error instanceof Error ? error.message : "解析文件失败");
    }
  });

  app.post("/commit", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const validatedData = CommitRequestSchema.parse(request.body);
      const { fileName, fileSize, source, sourceType, drafts, warningCount } = validatedData;

      const inconsistentSource = drafts.find((d) => d.source !== source);
      if (inconsistentSource) {
        return sendError(reply, 400, "交易来源与文件来源不一致");
      }

      const batch = await prisma.importBatch.create({
        data: {
          fileName,
          fileSize,
          source,
          sourceType,
          rowCount: 0,
          warningCount,
        },
      });

      const existingSet = new Set<string>();
      const sourceRowIds = drafts.map((d) => d.sourceRowId);
      for (let i = 0; i < sourceRowIds.length; i += BATCH_SIZE) {
        const batchIds = sourceRowIds.slice(i, i + BATCH_SIZE);
        const existingRecords = await prisma.transaction.findMany({
          where: {
            source,
            sourceRowId: { in: batchIds },
          },
          select: { sourceRowId: true },
        });
        existingRecords.forEach((r) => existingSet.add(r.sourceRowId));
      }

      const newDrafts = drafts.filter((d) => !existingSet.has(d.sourceRowId));
      const skippedCount = drafts.length - newDrafts.length;
      let insertedCount = 0;

      for (let i = 0; i < newDrafts.length; i += BATCH_SIZE) {
        const batchDrafts = newDrafts.slice(i, i + BATCH_SIZE);

        try {
          const result = await prisma.transaction.createMany({
            data: batchDrafts.map((draft) => buildTransactionData(draft, batch.id)),
          });
          insertedCount += result.count;
        } catch (batchError) {
          console.error(`批次 ${i / BATCH_SIZE + 1} 插入失败:`, batchError);
          for (const draft of batchDrafts) {
            try {
              await prisma.transaction.create({
                data: buildTransactionData(draft, batch.id),
              });
              insertedCount += 1;
            } catch {
              // ignore duplicate insert failure
            }
          }
        }
      }

      await prisma.importBatch.update({
        where: { id: batch.id },
        data: { rowCount: insertedCount },
      });

      if (insertedCount === 0) {
        await prisma.importBatch.delete({ where: { id: batch.id } });
        return reply.send({
          success: true,
          data: {
            batchId: "",
            rowCount: 0,
            skippedCount: drafts.length,
          },
        } satisfies ApiResponse<CommitResult>);
      }

      const insertedTransactions = await prisma.transaction.findMany({
        where: { importBatchId: batch.id },
        select: {
          occurredAt: true,
          amount: true,
          direction: true,
          counterparty: true,
        },
      });

      await applyCrossSourceDeduplication(prisma, insertedTransactions);

      return reply.send({
        success: true,
        data: {
          batchId: batch.id,
          rowCount: insertedCount,
          skippedCount,
        },
      } satisfies ApiResponse<CommitResult>);
    } catch (error) {
      console.error("导入数据失败:", error);
      if (error instanceof z.ZodError) {
        const firstError = error.errors[0];
        return sendError(reply, 400, `数据格式错误: ${firstError?.path.join(".")} - ${firstError?.message}`);
      }

      return sendError(reply, 500, error instanceof Error ? error.message : "导入数据失败");
    }
  });
}
