import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { requireSessionFromRequest } from "../lib/auth";
import { queryRows, withConnection, type DbConnection } from "../lib/db";
import { success } from "../lib/response";
import { applyMembershipByOrderName } from "../lib/membership";
import { recordPromotionCodeUse, validatePromotionCodeOrThrow } from "../lib/promotion";
import { executeBillingWithToss, issueBillingKeyWithToss } from "../lib/toss";

interface BillingCycleRow extends RowDataPacket {
  id: number;
  payment_id: number;
  user_id: string;
  customer_key: string;
  billing_key: string;
  cycle_type: "MONTHLY" | "YEARLY";
  billing_day: number;
  amount: number;
  currency: string | null;
  status: "ACTIVE" | "PAUSED" | "CANCELLED" | "EXPIRED";
  next_billing_date: Date | string | null;
  last_billing_date: Date | string | null;
  retry_count: number;
  max_retries: number;
  last_retry_date: Date | string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

interface CountRow extends RowDataPacket {
  count: number;
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function parseNextBillingDate(value: unknown): Date | undefined {
  if (typeof value !== "string" || !value.trim()) {
    return undefined;
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new HTTPException(400, { message: "Invalid nextBillingDate" });
  }

  return parsed;
}

function calculateNextBillingDate(
  cycleType: "MONTHLY" | "YEARLY",
  billingDay: number,
  fromDate: Date = new Date(),
): Date {
  if (cycleType === "MONTHLY") {
    const nextDate = new Date(fromDate);
    nextDate.setDate(billingDay);

    if (nextDate <= fromDate) {
      nextDate.setMonth(nextDate.getMonth() + 1);
      nextDate.setDate(billingDay);
    }

    if (nextDate.getDate() !== billingDay) {
      nextDate.setDate(0);
      nextDate.setMonth(nextDate.getMonth() + 1);
      nextDate.setDate(0);
    }

    return nextDate;
  }

  const currentYear = fromDate.getFullYear();
  const nextDate = new Date(currentYear, 0, billingDay);
  if (nextDate <= fromDate) {
    nextDate.setFullYear(currentYear + 1);
  }
  return nextDate;
}

async function getOwnedBillingCycle(
  connection: DbConnection,
  billingCycleId: number,
  userId: string,
) {
  const rows = await queryRows<BillingCycleRow>(
    connection,
    `SELECT *
     FROM billing_cycles
     WHERE id = ? AND user_id = ?
     LIMIT 1`,
    [billingCycleId, userId],
  );

  return rows[0] || null;
}

async function updateBillingCycle(
  connection: DbConnection,
  billingCycleId: number,
  updates: Partial<
    Pick<
      BillingCycleRow,
      "status" | "next_billing_date" | "last_billing_date" | "retry_count" | "last_retry_date"
    >
  >,
) {
  const fields: string[] = [];
  const values: Array<string | number | Date | null> = [];

  if (updates.status !== undefined) {
    fields.push("status = ?");
    values.push(updates.status);
  }

  if (updates.next_billing_date !== undefined) {
    fields.push("next_billing_date = ?");
    values.push(updates.next_billing_date as Date | string | null);
  }

  if (updates.last_billing_date !== undefined) {
    fields.push("last_billing_date = ?");
    values.push(updates.last_billing_date as Date | string | null);
  }

  if (updates.retry_count !== undefined) {
    fields.push("retry_count = ?");
    values.push(updates.retry_count);
  }

  if (updates.last_retry_date !== undefined) {
    fields.push("last_retry_date = ?");
    values.push(updates.last_retry_date as Date | string | null);
  }

  if (fields.length === 0) {
    throw new HTTPException(400, { message: "No billing cycle updates supplied" });
  }

  fields.push("updated_at = CURRENT_TIMESTAMP");
  values.push(billingCycleId);

  await queryRows(
    connection,
    `UPDATE billing_cycles
     SET ${fields.join(", ")}
     WHERE id = ?`,
    values,
  );
}

export const billingRoutes = new Hono<{ Bindings: Bindings }>();

billingRoutes.post("/billing/issue-key", async (c) => {
  await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = await c.req.json<{
    authKey?: string;
    customerKey?: string;
    customerName?: string;
    customerEmail?: string;
  }>();

  if (!body.authKey || !body.customerKey) {
    throw new HTTPException(400, { message: "authKey and customerKey are required" });
  }

  const issued = await issueBillingKeyWithToss(c.env, {
    authKey: body.authKey,
    customerKey: body.customerKey,
    customerName: body.customerName,
    customerEmail: body.customerEmail,
  });

  return c.json(
    success({
      billingKey: issued.billingKey,
      customerKey: issued.customerKey,
      card: issued.card,
      authenticatedAt: issued.authenticatedAt,
    }),
  );
});

billingRoutes.get("/billing/user/cycles", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const page = parsePositiveInt(c.req.query("page") || null, 1, 500);
  const limit = parsePositiveInt(c.req.query("limit") || null, 10, 100);
  const offset = (page - 1) * limit;
  const status = c.req.query("status");
  const cycleType = c.req.query("cycleType");

  const result = await withConnection(c.env, async (connection) => {
    const whereConditions = ["user_id = ?"];
    const whereValues: Array<string | number> = [session.user.id];

    if (status) {
      whereConditions.push("status = ?");
      whereValues.push(status);
    }

    if (cycleType) {
      whereConditions.push("cycle_type = ?");
      whereValues.push(cycleType);
    }

    const whereClause = `WHERE ${whereConditions.join(" AND ")}`;

    const countRows = await queryRows<CountRow>(
      connection,
      `SELECT COUNT(*) AS count
       FROM billing_cycles
       ${whereClause}`,
      whereValues,
    );
    const total = countRows[0]?.count || 0;

    const items = await queryRows<BillingCycleRow>(
      connection,
      `SELECT *
       FROM billing_cycles
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...whereValues, limit, offset],
    );

    return {
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  });

  return c.json(success(result));
});

billingRoutes.get("/billing/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const billingCycleId = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(billingCycleId) || billingCycleId <= 0) {
    throw new HTTPException(400, { message: "Invalid billing cycle ID" });
  }

  const cycle = await withConnection(c.env, (connection) =>
    getOwnedBillingCycle(connection, billingCycleId, session.user.id),
  );

  if (!cycle) {
    throw new HTTPException(404, { message: "Billing cycle not found" });
  }

  return c.json(success(cycle));
});

billingRoutes.put("/billing/:id/pause", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const billingCycleId = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(billingCycleId) || billingCycleId <= 0) {
    throw new HTTPException(400, { message: "Invalid billing cycle ID" });
  }

  const updated = await withConnection(c.env, async (connection) => {
    const cycle = await getOwnedBillingCycle(connection, billingCycleId, session.user.id);
    if (!cycle) {
      throw new HTTPException(404, { message: "Billing cycle not found" });
    }
    if (cycle.status !== "ACTIVE") {
      throw new HTTPException(400, {
        message: `Cannot pause billing cycle with status ${cycle.status}`,
      });
    }

    await updateBillingCycle(connection, billingCycleId, { status: "PAUSED" });
    const refreshed = await getOwnedBillingCycle(connection, billingCycleId, session.user.id);
    if (!refreshed) {
      throw new HTTPException(500, { message: "Failed to load updated billing cycle" });
    }
    return refreshed;
  });

  return c.json(success(updated, "Billing cycle paused"));
});

billingRoutes.put("/billing/:id/resume", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const billingCycleId = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(billingCycleId) || billingCycleId <= 0) {
    throw new HTTPException(400, { message: "Invalid billing cycle ID" });
  }

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch {
    body = {};
  }

  const updated = await withConnection(c.env, async (connection) => {
    const cycle = await getOwnedBillingCycle(connection, billingCycleId, session.user.id);
    if (!cycle) {
      throw new HTTPException(404, { message: "Billing cycle not found" });
    }
    if (cycle.status !== "PAUSED") {
      throw new HTTPException(400, {
        message: `Cannot resume billing cycle with status ${cycle.status}`,
      });
    }

    const nextBillingDate =
      parseNextBillingDate(body.nextBillingDate) ||
      calculateNextBillingDate(cycle.cycle_type, cycle.billing_day, new Date());

    await updateBillingCycle(connection, billingCycleId, {
      status: "ACTIVE",
      next_billing_date: nextBillingDate,
    });

    const refreshed = await getOwnedBillingCycle(connection, billingCycleId, session.user.id);
    if (!refreshed) {
      throw new HTTPException(500, { message: "Failed to load updated billing cycle" });
    }
    return refreshed;
  });

  return c.json(success(updated, "Billing cycle resumed"));
});

billingRoutes.delete("/billing/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const billingCycleId = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(billingCycleId) || billingCycleId <= 0) {
    throw new HTTPException(400, { message: "Invalid billing cycle ID" });
  }

  const updated = await withConnection(c.env, async (connection) => {
    const cycle = await getOwnedBillingCycle(connection, billingCycleId, session.user.id);
    if (!cycle) {
      throw new HTTPException(404, { message: "Billing cycle not found" });
    }
    if (cycle.status === "CANCELLED") {
      throw new HTTPException(400, { message: "Billing cycle is already cancelled" });
    }

    await updateBillingCycle(connection, billingCycleId, { status: "CANCELLED" });
    const refreshed = await getOwnedBillingCycle(connection, billingCycleId, session.user.id);
    if (!refreshed) {
      throw new HTTPException(500, { message: "Failed to load updated billing cycle" });
    }
    return refreshed;
  });

  return c.json(success(updated, "Billing cycle cancelled"));
});

billingRoutes.post("/billing/create", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = await c.req.json<{
    customerKey?: string;
    billingKey?: string;
    cycleType?: "MONTHLY" | "YEARLY";
    billingDay?: number;
    amount?: number;
    originalAmount?: number;
    orderName?: string;
    membershipTier?: string;
    membershipDuration?: number;
    nextBillingDate?: string;
    maxRetries?: number;
    executeFirstPayment?: boolean;
    promotionCode?: string;
  }>();

  if (!body.customerKey || !body.billingKey || !body.cycleType || !body.billingDay || !body.amount || !body.orderName) {
    throw new HTTPException(400, {
      message: "customerKey, billingKey, cycleType, billingDay, amount, orderName are required",
    });
  }

  const customerKey = body.customerKey;
  const billingKey = body.billingKey;
  const cycleType = body.cycleType;
  const billingDay = body.billingDay;
  const amount = body.amount;
  const orderName = body.orderName;

  const nextBillingDate =
    parseNextBillingDate(body.nextBillingDate) ||
    calculateNextBillingDate(cycleType, billingDay, new Date());

  const requestedOriginalAmount =
    typeof body.originalAmount === "number" && body.originalAmount > 0 ? body.originalAmount : amount;

  const billingCycleAmount =
    typeof body.originalAmount === "number" && body.originalAmount > amount
      ? body.originalAmount
      : amount;

  const result = await withConnection(c.env, async (connection) => {
    let promotion: Awaited<ReturnType<typeof validatePromotionCodeOrThrow>> | null = null;
    if (body.promotionCode) {
      promotion = await validatePromotionCodeOrThrow(
        connection,
        body.promotionCode,
        session.user.id,
        requestedOriginalAmount,
        body.membershipTier || orderName,
      );

      if (promotion.discount.finalAmount !== amount) {
        throw new HTTPException(400, { message: "Promotion-adjusted amount does not match request amount" });
      }
    }

    await queryRows(
      connection,
      `INSERT INTO payments
       (payment_key, order_id, order_name, user_id, customer_key, billing_key,
        amount, currency, method, status, toss_payment_data, is_billing,
        billing_cycle, next_billing_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'KRW', 'BILLING', 'READY', NULL, 1, ?, ?, ?)`,
      [
        `billing_${Date.now()}_${session.user.id}`,
        `billing_order_${Date.now()}`,
        orderName,
        session.user.id,
        customerKey,
        billingKey,
        amount,
        cycleType,
        nextBillingDate,
        session.user.id,
      ],
    );

    const paymentRows = await queryRows<RowDataPacket & { id: number }>(
      connection,
      `SELECT id
       FROM payments
       WHERE user_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [session.user.id],
    );
    const paymentId = paymentRows[0]?.id;
    if (!paymentId) {
      throw new HTTPException(500, { message: "Failed to create payment record" });
    }

    await queryRows(
      connection,
      `INSERT INTO billing_cycles
       (payment_id, user_id, customer_key, billing_key, cycle_type, billing_day, amount, currency, next_billing_date, max_retries)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'KRW', ?, ?)`,
      [
        paymentId,
        session.user.id,
        customerKey,
        billingKey,
        cycleType,
        billingDay,
        billingCycleAmount,
        nextBillingDate,
        body.maxRetries ?? 3,
      ],
    );

    const cycleRows = await queryRows<BillingCycleRow>(
      connection,
      `SELECT *
       FROM billing_cycles
       WHERE payment_id = ?
       LIMIT 1`,
      [paymentId],
    );
    const billingCycle = cycleRows[0];
    if (!billingCycle) {
      throw new HTTPException(500, { message: "Failed to create billing cycle" });
    }

    if (promotion) {
      await recordPromotionCodeUse(connection, {
        promotionId: promotion.promotionId,
        code: promotion.code,
        userId: session.user.id,
        originalAmount: promotion.discount.originalAmount,
        discountAmount: promotion.discount.discountAmount,
        finalAmount: promotion.discount.finalAmount,
        paymentId,
        billingCycleId: billingCycle.id,
      });
    }

    let firstPayment: unknown = null;
    let membershipProcessed = false;

    if (body.executeFirstPayment !== false) {
      try {
        const tossPayment = await executeBillingWithToss(c.env, billingKey, {
          customerKey,
          amount,
          orderId: `billing_${billingCycle.id}_${Date.now()}`,
          orderName,
          customerEmail: session.user.email,
          customerName: session.user.username,
        });

        await queryRows(
          connection,
          `UPDATE payments
           SET payment_key = ?, status = ?, method = ?, toss_payment_data = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            tossPayment.paymentKey,
            tossPayment.status || "DONE",
            tossPayment.method || "CARD",
            JSON.stringify(tossPayment),
            paymentId,
          ],
        );

        if ((tossPayment.status || "DONE") === "DONE") {
          membershipProcessed = await applyMembershipByOrderName(
            connection,
            session.user.id,
            orderName,
          );
          await queryRows(
            connection,
            `UPDATE billing_cycles
             SET last_billing_date = NOW(), retry_count = 0, last_retry_date = NOW(), updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [billingCycle.id],
          );
        } else {
          await queryRows(
            connection,
            `UPDATE billing_cycles
             SET retry_count = retry_count + 1, last_retry_date = NOW(), updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [billingCycle.id],
          );
        }

        firstPayment = tossPayment;
      } catch (error) {
        await queryRows(
          connection,
          `UPDATE payments
           SET status = 'ABORTED', updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [paymentId],
        );
        await queryRows(
          connection,
          `UPDATE billing_cycles
           SET retry_count = retry_count + 1, last_retry_date = NOW(), updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [billingCycle.id],
        );

        firstPayment = {
          error: error instanceof Error ? error.message : "Initial billing payment failed",
        };
      }
    }

    const refreshedRows = await queryRows<BillingCycleRow>(
      connection,
      `SELECT *
       FROM billing_cycles
       WHERE id = ?
       LIMIT 1`,
      [billingCycle.id],
    );

    return {
      billingCycle: refreshedRows[0] || billingCycle,
      firstPayment,
      membershipProcessed,
      promotion: promotion
        ? {
            code: promotion.code,
            description: promotion.description,
            discount: promotion.discount,
            expiresAt: promotion.expiresAt,
          }
        : null,
    };
  });

  return c.json(success(result, "Billing cycle created"), 201);
});
