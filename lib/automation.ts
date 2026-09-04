import { and, eq, sql } from "drizzle-orm";
import { getDb } from "../db";
import { automationRuns, automationSteps } from "../db/schema";

export type AutomationRunRow = typeof automationRuns.$inferSelect;

export async function ensureAutomationRun(input: {
  xianyuOrderId: string;
  orderId: number;
  productId: number | null;
  ruleId: number | null;
}) {
  const db = getDb();
  const triggerKey = `order-paid:${input.xianyuOrderId}`;
  await db
    .insert(automationRuns)
    .values({
      triggerKey,
      orderId: input.orderId,
      productId: input.productId,
      ruleId: input.ruleId,
      status: "pending",
    })
    .onConflictDoNothing({ target: automationRuns.triggerKey });
  const [run] = await db
    .select()
    .from(automationRuns)
    .where(eq(automationRuns.triggerKey, triggerKey))
    .limit(1);
  if (!run) throw new Error("无法创建订单自动化记录");
  if (run.productId !== input.productId || run.ruleId !== input.ruleId) {
    const [updated] = await db
      .update(automationRuns)
      .set({
        productId: input.productId,
        ruleId: input.ruleId,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(automationRuns.id, run.id))
      .returning();
    return updated;
  }
  return run;
}

export async function runAutomationStep<T>(input: {
  run: AutomationRunRow;
  stepKey: string;
  actionType: string;
  output?: (value: T) => string;
  execute: () => Promise<T>;
}) {
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(automationSteps)
    .values({
      runId: input.run.id,
      stepKey: input.stepKey,
      actionType: input.actionType,
    })
    .onConflictDoNothing({
      target: [automationSteps.runId, automationSteps.stepKey],
    });
  const [existing] = await db
    .select()
    .from(automationSteps)
    .where(
      and(
        eq(automationSteps.runId, input.run.id),
        eq(automationSteps.stepKey, input.stepKey),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("无法创建自动化步骤记录");
  if (existing.status === "success") {
    return { skipped: true as const, value: undefined as T | undefined };
  }

  await Promise.all([
    db
      .update(automationRuns)
      .set({
        status: "running",
        currentStep: input.stepKey,
        lastError: null,
        finishedAt: null,
        updatedAt: now,
      })
      .where(eq(automationRuns.id, input.run.id)),
    db
      .update(automationSteps)
      .set({
        status: "running",
        attempts: sql`${automationSteps.attempts} + 1`,
        lastError: null,
        finishedAt: null,
        updatedAt: now,
      })
      .where(eq(automationSteps.id, existing.id)),
  ]);

  try {
    const value = await input.execute();
    const finishedAt = new Date().toISOString();
    await db
      .update(automationSteps)
      .set({
        status: "success",
        output: input.output?.(value) || "",
        lastError: null,
        finishedAt,
        updatedAt: finishedAt,
      })
      .where(eq(automationSteps.id, existing.id));
    return { skipped: false as const, value };
  } catch (error) {
    const message = errorMessage(error);
    const failedAt = new Date().toISOString();
    await Promise.all([
      db
        .update(automationSteps)
        .set({
          status: "failed",
          lastError: message,
          finishedAt: failedAt,
          updatedAt: failedAt,
        })
        .where(eq(automationSteps.id, existing.id)),
      db
        .update(automationRuns)
        .set({
          status: "needs_attention",
          currentStep: input.stepKey,
          lastError: message,
          finishedAt: failedAt,
          updatedAt: failedAt,
        })
        .where(eq(automationRuns.id, input.run.id)),
    ]);
    throw error;
  }
}

export async function finishAutomationRun(runId: number) {
  const now = new Date().toISOString();
  await getDb()
    .update(automationRuns)
    .set({
      status: "success",
      currentStep: "completed",
      lastError: null,
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(automationRuns.id, runId));
}

export async function markAutomationNeedsAttention(
  runId: number,
  stepKey: string,
  message: string,
) {
  const db = getDb();
  const now = new Date().toISOString();
  await db
    .insert(automationSteps)
    .values({
      runId,
      stepKey,
      actionType: stepKey,
      status: "needs_attention",
      attempts: 1,
      lastError: message,
      finishedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [automationSteps.runId, automationSteps.stepKey],
      set: {
        status: "needs_attention",
        lastError: message,
        finishedAt: now,
        updatedAt: now,
      },
    });
  await db
    .update(automationRuns)
    .set({
      status: "needs_attention",
      currentStep: stepKey,
      lastError: message,
      finishedAt: now,
      updatedAt: now,
    })
    .where(eq(automationRuns.id, runId));
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error || "步骤失败");
}
