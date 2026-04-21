import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { requireAdminSessionFromRequest } from "../lib/admin";
import { requireSessionFromRequest } from "../lib/auth";
import { placeholders, queryRows, withConnection, type DbConnection } from "../lib/db";
import { legacyValidationFailure, success } from "../lib/response";
import { applyMembershipByOrderName } from "../lib/membership";
import { recordPromotionCodeUse, validatePromotionCodeOrThrow } from "../lib/promotion";
import { cancelPaymentWithToss, confirmPaymentWithToss } from "../lib/toss";
import { extractWebhookSignature, validateWebhookTimestamp, verifyWebhookSignature } from "../lib/webhook";

interface PaymentRow extends RowDataPacket {
  id: number;
  payment_key: string;
  order_id: string;
  order_name: string;
  user_id: string;
  customer_key: string | null;
  billing_key: string | null;
  amount: number;
  currency: string | null;
  method: string | null;
  status: string | null;
  toss_payment_data: string | null;
  is_billing: number | boolean;
  billing_cycle: string | null;
  next_billing_date: Date | string | null;
  created_by: string;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

interface PaymentCancellationRow extends RowDataPacket {
  id: number;
  payment_id: number;
  payment_key: string;
  cancel_amount: number;
  cancel_reason: string;
  cancellation_type: string;
  toss_cancel_data: string | null;
  transaction_key: string | null;
  status: string;
  requested_by: string;
  approved_by: string | null;
  requested_at: Date | string | null;
  approved_at: Date | string | null;
}

interface CountRow extends RowDataPacket {
  count: number;
}

interface PaymentStatusSummaryRow extends RowDataPacket {
  status: string | null;
  count: number;
  amount: number | null;
}

interface WebhookAuditSummaryRow extends RowDataPacket {
  event_type: string | null;
  status: string | null;
  count: number;
}

interface CancellationSummaryRow extends RowDataPacket {
  cancellation_type: string | null;
  status: string | null;
  count: number;
  amount: number | null;
}

interface TossWebhookPayload {
  id?: string;
  eventType?: string;
  createdAt?: string;
  data?: Record<string, unknown> & {
    paymentKey?: string;
    orderId?: string;
    status?: string;
    billingKey?: string;
    customerKey?: string;
    totalAmount?: number;
    method?: string;
  };
}

interface CreatePaymentBody {
  orderId?: string;
  orderName?: string;
  amount?: number;
  currency?: string;
  method?: string;
  customerEmail?: string;
  customerName?: string;
  customerMobilePhone?: string;
  successUrl?: string;
  failUrl?: string;
  isBilling?: boolean;
  billingCycle?: string;
  billingDay?: number;
  paymentMethods?: string[];
  originalAmount?: number;
  metadata?: Record<string, unknown>;
}

function getWebhookAuditTableName(env: Bindings) {
  const table = (env.PAYMENT_WEBHOOK_AUDIT_TABLE || "").trim();
  if (!table) {
    return null;
  }
  if (!/^[A-Za-z0-9_]+$/.test(table)) {
    throw new HTTPException(500, { message: "PAYMENT_WEBHOOK_AUDIT_TABLE contains invalid characters" });
  }
  return table;
}

function parsePositiveInt(value: string | null, fallback: number, max: number): number {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function parseDateTimeFilter(value: string | null, fieldName: string): string | null {
  if (!value) {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }
  const timestamp = Date.parse(trimmed);
  if (Number.isNaN(timestamp)) {
    throw new HTTPException(400, { message: `${fieldName} must be a valid ISO datetime` });
  }
  return new Date(timestamp).toISOString();
}

function calculateNextBillingDate(
  cycleType: "MONTHLY" | "YEARLY",
  billingDay: number,
  fromDate: Date = new Date(),
) {
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

function parseJsonField<T>(value: string | null): T | null {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function mapPaymentRecord(row: PaymentRow) {
  return {
    ...row,
    is_billing: Boolean(row.is_billing),
    toss_payment_data: parseJsonField<Record<string, unknown>>(row.toss_payment_data),
  };
}

function mapCancellationRecord(row: PaymentCancellationRow) {
  return {
    ...row,
    toss_cancel_data: parseJsonField<Record<string, unknown>>(row.toss_cancel_data),
  };
}

function formatPaymentForLegacyResponse(row: PaymentRow) {
  return {
    id: row.id,
    paymentKey: row.payment_key,
    orderId: row.order_id,
    orderName: row.order_name,
    userId: row.user_id,
    customerKey: row.customer_key,
    amount: row.amount,
    currency: row.currency,
    method: row.method,
    status: row.status,
    isBilling: Boolean(row.is_billing),
    billingCycle: row.billing_cycle,
    billingKey: row.billing_key ? "***masked***" : null,
    nextBillingDate: row.next_billing_date,
    tossPaymentData: parseJsonField<Record<string, unknown>>(row.toss_payment_data),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function formatCancellationForLegacyResponse(row: PaymentCancellationRow) {
  return {
    id: row.id,
    paymentId: row.payment_id,
    paymentKey: row.payment_key,
    cancelAmount: row.cancel_amount,
    cancelReason: row.cancel_reason,
    cancellationType: row.cancellation_type,
    status: row.status,
    transactionKey: row.transaction_key,
    requestedBy: row.requested_by,
    approvedBy: row.approved_by,
    requestedAt: row.requested_at,
    approvedAt: row.approved_at,
    tossCancelData: parseJsonField<Record<string, unknown>>(row.toss_cancel_data),
  };
}

async function listCancellationsForAdmin(
  connection: DbConnection,
  page: number,
  limit: number,
  filters: {
    paymentKey?: string | null;
    orderId?: string | null;
    billingKey?: string | null;
    customerKey?: string | null;
    requestedBy?: string | null;
    status?: string | null;
    cancellationType?: string | null;
    createdFrom?: string | null;
    createdTo?: string | null;
  },
) {
  const offset = (page - 1) * limit;
  const whereConditions = ["1 = 1"];
  const whereValues: Array<string | number> = [];

  if (filters.paymentKey) {
    whereConditions.push("pc.payment_key = ?");
    whereValues.push(filters.paymentKey);
  }

  if (filters.orderId) {
    whereConditions.push("p.order_id = ?");
    whereValues.push(filters.orderId);
  }

  if (filters.billingKey) {
    whereConditions.push("p.billing_key = ?");
    whereValues.push(filters.billingKey);
  }

  if (filters.customerKey) {
    whereConditions.push("p.customer_key = ?");
    whereValues.push(filters.customerKey);
  }

  if (filters.requestedBy) {
    whereConditions.push("pc.requested_by = ?");
    whereValues.push(filters.requestedBy);
  }

  if (filters.status) {
    whereConditions.push("pc.status = ?");
    whereValues.push(filters.status);
  }

  if (filters.cancellationType) {
    whereConditions.push("pc.cancellation_type = ?");
    whereValues.push(filters.cancellationType);
  }

  if (filters.createdFrom) {
    whereConditions.push("pc.requested_at >= ?");
    whereValues.push(filters.createdFrom);
  }

  if (filters.createdTo) {
    whereConditions.push("pc.requested_at <= ?");
    whereValues.push(filters.createdTo);
  }

  const whereClause = `WHERE ${whereConditions.join(" AND ")}`;
  const countRows = await queryRows<CountRow>(
    connection,
    `SELECT COUNT(*) AS count
     FROM payment_cancellations pc
     JOIN payments p ON p.id = pc.payment_id
     ${whereClause}`,
    whereValues,
  );

  const rows = await queryRows<PaymentCancellationRow & {
    order_id: string | null;
    billing_key: string | null;
    customer_key: string | null;
    user_id: string;
    amount: number;
  }>(
    connection,
    `SELECT
        pc.*,
        p.order_id,
        p.billing_key,
        p.customer_key,
        p.user_id,
        p.amount
     FROM payment_cancellations pc
     JOIN payments p ON p.id = pc.payment_id
     ${whereClause}
     ORDER BY pc.requested_at DESC
     LIMIT ? OFFSET ?`,
    [...whereValues, limit, offset],
  );

  return {
    data: rows.map((row) => ({
      ...mapCancellationRecord(row),
      order_id: row.order_id,
      billing_key: row.billing_key,
      customer_key: row.customer_key,
      user_id: row.user_id,
      payment_amount: row.amount,
    })),
    pagination: {
      page,
      limit,
      total: countRows[0]?.count || 0,
      totalPages: Math.ceil((countRows[0]?.count || 0) / limit),
    },
  };
}

async function getOwnedPaymentByKey(
  connection: DbConnection,
  paymentKey: string,
  userId: string,
) {
  const rows = await queryRows<PaymentRow>(
    connection,
    `SELECT *
     FROM payments
     WHERE payment_key = ? AND user_id = ?
     LIMIT 1`,
    [paymentKey, userId],
  );

  return rows[0] || null;
}

async function getPaymentByKey(connection: DbConnection, paymentKey: string) {
  const rows = await queryRows<PaymentRow>(
    connection,
    `SELECT *
     FROM payments
     WHERE payment_key = ?
     LIMIT 1`,
    [paymentKey],
  );

  return rows[0] || null;
}

async function getPaymentCancellationsForKey(connection: DbConnection, paymentKey: string, userId: string) {
  const payment = await getOwnedPaymentByKey(connection, paymentKey, userId);
  if (!payment) {
    throw new HTTPException(404, { message: "Payment not found" });
  }

  const rows = await queryRows<PaymentCancellationRow>(
    connection,
    `SELECT *
     FROM payment_cancellations
     WHERE payment_id = ?
     ORDER BY requested_at DESC`,
    [payment.id],
  );

  return {
    payment,
    cancellations: rows,
  };
}

function determineCancellationType(originalAmount: number, cancelAmount?: number) {
  if (typeof cancelAmount === "number" && cancelAmount > 0 && cancelAmount < originalAmount) {
    return "PARTIAL";
  }
  return "FULL";
}

function normalizeCanceledStatus(originalAmount: number, cancelAmount?: number) {
  if (typeof cancelAmount === "number" && cancelAmount > 0 && cancelAmount < originalAmount) {
    return "PARTIAL_CANCELED";
  }
  return "CANCELED";
}

async function cancelLinkedBillingCycle(connection: DbConnection, paymentId: number) {
  await queryRows(
    connection,
    `UPDATE billing_cycles
     SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
     WHERE payment_id = ? AND status != 'CANCELLED'`,
    [paymentId],
  );
}

async function updatePaymentFromWebhook(
  connection: DbConnection,
  paymentKey: string,
  paymentData: Record<string, unknown>,
) {
  const payment = await getPaymentByKey(connection, paymentKey);
  if (!payment) {
    return null;
  }

  const nextStatus =
    typeof paymentData.status === "string" && paymentData.status.trim()
      ? paymentData.status.trim()
      : payment.status;
  const nextMethod =
    typeof paymentData.method === "string" && paymentData.method.trim()
      ? paymentData.method.trim()
      : payment.method;

  await queryRows(
    connection,
    `UPDATE payments
     SET status = ?, method = ?, toss_payment_data = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [nextStatus, nextMethod, JSON.stringify(paymentData), payment.id],
  );

  const refreshed = await getPaymentByKey(connection, paymentKey);
  return refreshed ? mapPaymentRecord(refreshed) : null;
}

async function persistWebhookAudit(
  connection: DbConnection,
  env: Bindings,
  input: {
    webhookId: string;
    eventType: string;
    paymentKey?: string | null;
    orderId?: string | null;
    billingKey?: string | null;
    customerKey?: string | null;
    status: string;
    rawData: TossWebhookPayload;
    result?: unknown;
    errorMessage?: string | null;
  },
) {
  const table = getWebhookAuditTableName(env);
  if (!table) {
    return;
  }

  await connection.exec(
    `INSERT INTO ${table}
     (id, webhook_id, event_type, payment_key, order_id, billing_key, customer_key, status, raw_data, processing_result, error_message, processed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      crypto.randomUUID(),
      input.webhookId,
      input.eventType,
      input.paymentKey || null,
      input.orderId || null,
      input.billingKey || null,
      input.customerKey || null,
      input.status,
      JSON.stringify(input.rawData),
      input.result === undefined ? null : JSON.stringify(input.result),
      input.errorMessage || null,
    ],
  );
}

async function listPaymentsForUser(
  connection: DbConnection,
  userId: string,
  page: number,
  limit: number,
  status: string | null,
  method: string | null,
  dateFrom: string | null,
  dateTo: string | null,
) {
  const offset = (page - 1) * limit;
  const whereConditions = ["user_id = ?"];
  const whereValues: Array<string | number> = [userId];

  if (status) {
    whereConditions.push("status = ?");
    whereValues.push(status);
  }

  if (method) {
    whereConditions.push("method = ?");
    whereValues.push(method);
  }

  if (dateFrom) {
    whereConditions.push("created_at >= ?");
    whereValues.push(dateFrom);
  }

  if (dateTo) {
    whereConditions.push("created_at <= ?");
    whereValues.push(dateTo);
  }

  const whereClause = `WHERE ${whereConditions.join(" AND ")}`;
  const countRows = await queryRows<CountRow>(
    connection,
    `SELECT COUNT(*) AS count
     FROM payments
     ${whereClause}`,
    whereValues,
  );
  const total = countRows[0]?.count || 0;

  const items = await queryRows<PaymentRow>(
    connection,
    `SELECT *
     FROM payments
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
}

async function getCancellationsForPaymentIds(connection: DbConnection, paymentIds: number[]) {
  if (paymentIds.length === 0) {
    return new Map<number, ReturnType<typeof mapCancellationRecord>[]>();
  }

  const rows = await queryRows<PaymentCancellationRow>(
    connection,
    `SELECT *
     FROM payment_cancellations
     WHERE payment_id IN (${placeholders(paymentIds.length)})
     ORDER BY requested_at DESC`,
    paymentIds,
  );

  const grouped = new Map<number, ReturnType<typeof mapCancellationRecord>[]>();
  for (const row of rows) {
    const existing = grouped.get(row.payment_id) || [];
    existing.push(mapCancellationRecord(row));
    grouped.set(row.payment_id, existing);
  }

  return grouped;
}

async function listPaymentsForAdmin(
  connection: DbConnection,
  page: number,
  limit: number,
  filters: {
    status?: string | null;
    method?: string | null;
    userId?: string | null;
    orderId?: string | null;
    billingOnly?: boolean;
    createdFrom?: string | null;
    createdTo?: string | null;
  },
) {
  const offset = (page - 1) * limit;
  const whereConditions = ["1 = 1"];
  const whereValues: Array<string | number> = [];

  if (filters.status) {
    whereConditions.push("status = ?");
    whereValues.push(filters.status);
  }

  if (filters.method) {
    whereConditions.push("method = ?");
    whereValues.push(filters.method);
  }

  if (filters.userId) {
    whereConditions.push("user_id = ?");
    whereValues.push(filters.userId);
  }

  if (filters.orderId) {
    whereConditions.push("order_id = ?");
    whereValues.push(filters.orderId);
  }

  if (filters.billingOnly) {
    whereConditions.push("is_billing = 1");
  }

  if (filters.createdFrom) {
    whereConditions.push("created_at >= ?");
    whereValues.push(filters.createdFrom);
  }

  if (filters.createdTo) {
    whereConditions.push("created_at <= ?");
    whereValues.push(filters.createdTo);
  }

  const whereClause = `WHERE ${whereConditions.join(" AND ")}`;
  const countRows = await queryRows<CountRow>(
    connection,
    `SELECT COUNT(*) AS count
     FROM payments
     ${whereClause}`,
    whereValues,
  );
  const total = countRows[0]?.count || 0;

  const items = await queryRows<PaymentRow>(
    connection,
    `SELECT *
     FROM payments
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
}

export const paymentRoutes = new Hono<{ Bindings: Bindings }>();

paymentRoutes.post("/payments", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body: CreatePaymentBody = await c.req.json<CreatePaymentBody>().catch(() => ({} as CreatePaymentBody));

  const requiredFields = ["orderId", "orderName", "amount", "method", "successUrl", "failUrl"] as const;
  const missing = requiredFields.filter((field) => !body[field]);
  if (missing.length > 0) {
    throw new HTTPException(400, { message: `Missing required fields: ${missing.join(", ")}` });
  }
  if (typeof body.amount !== "number" || body.amount <= 0) {
    throw new HTTPException(400, { message: "Amount must be a positive number" });
  }
  try {
    new URL(String(body.successUrl));
    new URL(String(body.failUrl));
  } catch {
    throw new HTTPException(400, { message: "Invalid success or fail URL format" });
  }

  const result = await withConnection(c.env, async (connection) => {
    const duplicate = await queryRows<RowDataPacket & { id: number }>(
      connection,
      "SELECT id FROM payments WHERE order_id = ? LIMIT 1",
      [String(body.orderId).trim()],
    );
    if (duplicate[0]) {
      throw new HTTPException(400, { message: `Payment with order ID ${String(body.orderId).trim()} already exists` });
    }

    const paymentKey = `payment_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const now = new Date();
    const nextBillingDate =
      body.isBilling && body.billingCycle && body.billingDay
        ? calculateNextBillingDate(body.billingCycle as "MONTHLY" | "YEARLY", Number(body.billingDay), now)
        : null;

    await queryRows(
      connection,
      `INSERT INTO payments
       (payment_key, order_id, order_name, user_id, customer_key, amount, currency, method, status, is_billing, billing_cycle, next_billing_date, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'READY', ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        paymentKey,
        String(body.orderId).trim(),
        String(body.orderName).trim(),
        session.user.id,
        body.customerEmail ? String(body.customerEmail).trim() : session.user.email,
        Number(body.amount),
        body.currency || "KRW",
        String(body.method),
        body.isBilling ? 1 : 0,
        body.billingCycle || null,
        nextBillingDate,
        session.user.id,
      ],
    );

    const paymentRows = await queryRows<PaymentRow>(
      connection,
      `SELECT *
       FROM payments
       WHERE payment_key = ?
       LIMIT 1`,
      [paymentKey],
    );

    const payment = paymentRows[0];
    if (!payment) {
      throw new HTTPException(500, { message: "Failed to create payment" });
    }

    return {
      payment: {
        id: payment.id,
        paymentKey: payment.payment_key,
        orderId: payment.order_id,
        orderName: payment.order_name,
        amount: payment.amount,
        currency: payment.currency,
        method: payment.method,
        status: payment.status,
        isBilling: Boolean(payment.is_billing),
        billingCycle: payment.billing_cycle,
        nextBillingDate: payment.next_billing_date,
        createdBy: payment.created_by,
        createdAt: payment.created_at,
      },
      tossPayment: {
        paymentKey,
        orderId: String(body.orderId).trim(),
        amount: body.amount,
        checkoutUrl: `https://api.tosspayments.com/v2/payments/${paymentKey}`,
        currency: body.currency || "KRW",
        country: "KR",
      },
    };
  });

  return c.json(
    {
      success: true,
      message: "Payment created successfully",
      data: result,
      timestamp: new Date().toISOString(),
    },
    201,
  );
});

paymentRoutes.get("/payments/user/history", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const page = parsePositiveInt(c.req.query("page") || null, 1, 500);
  const limit = parsePositiveInt(c.req.query("limit") || null, 10, 100);
  const status = c.req.query("status") || null;
  const method = c.req.query("method") || null;
  const dateFrom = parseDateTimeFilter(c.req.query("dateFrom") || null, "dateFrom");
  const dateTo = parseDateTimeFilter(c.req.query("dateTo") || null, "dateTo");

  const result = await withConnection(c.env, async (connection) => {
    const payments = await listPaymentsForUser(
      connection,
      session.user.id,
      page,
      limit,
      status,
      method,
      dateFrom,
      dateTo,
    );
    return {
      data: payments.data.map(mapPaymentRecord),
      pagination: payments.pagination,
    };
  });

  return c.json({
    success: true,
    data: result,
  });
});

paymentRoutes.get("/payments/user/history-with-cancellations", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const page = parsePositiveInt(c.req.query("page") || null, 1, 500);
  const limit = parsePositiveInt(c.req.query("limit") || null, 10, 100);
  const status = c.req.query("status") || null;
  const method = c.req.query("method") || null;
  const dateFrom = parseDateTimeFilter(c.req.query("dateFrom") || null, "dateFrom");
  const dateTo = parseDateTimeFilter(c.req.query("dateTo") || null, "dateTo");

  const result = await withConnection(c.env, async (connection) => {
    const payments = await listPaymentsForUser(
      connection,
      session.user.id,
      page,
      limit,
      status,
      method,
      dateFrom,
      dateTo,
    );
    const paymentIds = payments.data.map((item) => item.id);
    const cancellations = await getCancellationsForPaymentIds(connection, paymentIds);

    return {
      data: payments.data.map((row) => {
        const payment = mapPaymentRecord(row);
        const linkedCancellations = cancellations.get(row.id);
        return {
          ...payment,
          cancellations: linkedCancellations && linkedCancellations.length > 0 ? linkedCancellations : undefined,
        };
      }),
      pagination: payments.pagination,
    };
  });

  return c.json({
    success: true,
    data: result,
  });
});

paymentRoutes.get("/payments/user/cancellations", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const page = parsePositiveInt(c.req.query("page") || null, 1, 500);
  const limit = parsePositiveInt(c.req.query("limit") || null, 10, 100);
  const offset = (page - 1) * limit;

  const result = await withConnection(c.env, async (connection) => {
    const countRows = await queryRows<CountRow>(
      connection,
      `SELECT COUNT(*) AS count
       FROM payment_cancellations
       WHERE requested_by = ?`,
      [session.user.id],
    );
    const total = countRows[0]?.count || 0;

    const rows = await queryRows<PaymentCancellationRow>(
      connection,
      `SELECT *
       FROM payment_cancellations
       WHERE requested_by = ?
       ORDER BY requested_at DESC
       LIMIT ? OFFSET ?`,
      [session.user.id, limit, offset],
    );

    return {
      data: rows.map(mapCancellationRecord),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  });

  return c.json({
    success: true,
    data: result,
  });
});

paymentRoutes.get("/payments/:paymentKey", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const paymentKey = c.req.param("paymentKey")?.trim();
  if (!paymentKey) {
    throw new HTTPException(400, { message: "Payment key is required" });
  }

  const payment = await withConnection(c.env, async (connection) => {
    const row = await getOwnedPaymentByKey(connection, paymentKey, session.user.id);
    return row ? formatPaymentForLegacyResponse(row) : null;
  });

  if (!payment) {
    throw new HTTPException(404, { message: "Payment not found" });
  }

  return c.json({
    success: true,
    message: "Payment details retrieved successfully",
    data: payment,
    timestamp: new Date().toISOString(),
  });
});

paymentRoutes.get("/payments/:paymentKey/cancellations", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const paymentKey = c.req.param("paymentKey")?.trim();
  if (!paymentKey) {
    throw new HTTPException(400, { message: "Payment key is required" });
  }

  const result = await withConnection(c.env, (connection) =>
    getPaymentCancellationsForKey(connection, paymentKey, session.user.id),
  );

  return c.json({
    success: true,
    data: {
      payment: formatPaymentForLegacyResponse(result.payment),
      cancellations: result.cancellations.map(formatCancellationForLegacyResponse),
    },
    message: "Payment cancellations retrieved successfully",
    timestamp: new Date().toISOString(),
  });
});

paymentRoutes.get("/admin/payments/failed", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const page = parsePositiveInt(c.req.query("page") || null, 1, 500);
  const limit = parsePositiveInt(c.req.query("limit") || null, 20, 100);
  const userId = c.req.query("userId") || null;
  const orderId = c.req.query("orderId") || null;
  const method = c.req.query("method") || null;
  const billingOnly = (c.req.query("billingOnly") || "").toLowerCase() === "true";
  const createdFrom = parseDateTimeFilter(c.req.query("createdFrom") || null, "createdFrom");
  const createdTo = parseDateTimeFilter(c.req.query("createdTo") || null, "createdTo");

  const result = await withConnection(c.env, async (connection) => {
    const payments = await listPaymentsForAdmin(connection, page, limit, {
      status: "FAILED",
      method,
      userId,
      orderId,
      billingOnly,
      createdFrom,
      createdTo,
    });

    const summaryWhereConditions = ["status IN ('FAILED', 'ABORTED', 'EXPIRED', 'PARTIAL_CANCELED', 'CANCELED', 'CANCELLED')"];
    const summaryWhereValues: Array<string | number> = [];
    if (method) {
      summaryWhereConditions.push("method = ?");
      summaryWhereValues.push(method);
    }
    if (userId) {
      summaryWhereConditions.push("user_id = ?");
      summaryWhereValues.push(userId);
    }
    if (orderId) {
      summaryWhereConditions.push("order_id = ?");
      summaryWhereValues.push(orderId);
    }
    if (billingOnly) {
      summaryWhereConditions.push("is_billing = 1");
    }
    if (createdFrom) {
      summaryWhereConditions.push("created_at >= ?");
      summaryWhereValues.push(createdFrom);
    }
    if (createdTo) {
      summaryWhereConditions.push("created_at <= ?");
      summaryWhereValues.push(createdTo);
    }

    const summary = await queryRows<PaymentStatusSummaryRow>(
      connection,
      `SELECT status, COUNT(*) AS count, COALESCE(SUM(amount), 0) AS amount
       FROM payments
       WHERE ${summaryWhereConditions.join(" AND ")}
       GROUP BY status
       ORDER BY count DESC`,
      summaryWhereValues,
    ).catch(() => []);

    return {
      data: payments.data.map(mapPaymentRecord),
      pagination: payments.pagination,
      filters: {
        method,
        userId,
        orderId,
        billingOnly,
        createdFrom,
        createdTo,
      },
      summary: summary.map((row) => ({
        status: row.status || "UNKNOWN",
        count: row.count,
        amount: Number(row.amount || 0),
      })),
    };
  });

  return c.json(success(result, "Admin failed payments retrieved"));
});

paymentRoutes.get("/admin/payments/webhook-audit", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const auditTable = getWebhookAuditTableName(c.env);
  if (!auditTable) {
    throw new HTTPException(503, { message: "PAYMENT_WEBHOOK_AUDIT_TABLE is not configured" });
  }

  const page = parsePositiveInt(c.req.query("page") || null, 1, 500);
  const limit = parsePositiveInt(c.req.query("limit") || null, 20, 100);
  const offset = (page - 1) * limit;
  const status = c.req.query("status") || null;
  const eventType = c.req.query("eventType") || null;
  const paymentKey = c.req.query("paymentKey") || null;
  const orderId = c.req.query("orderId") || null;
  const billingKey = c.req.query("billingKey") || null;
  const customerKey = c.req.query("customerKey") || null;
  const createdFrom = parseDateTimeFilter(c.req.query("createdFrom") || null, "createdFrom");
  const createdTo = parseDateTimeFilter(c.req.query("createdTo") || null, "createdTo");

  const result = await withConnection(c.env, async (connection) => {
    const whereConditions = ["1 = 1"];
    const whereValues: Array<string | number> = [];

    if (status) {
      whereConditions.push("status = ?");
      whereValues.push(status);
    }

    if (eventType) {
      whereConditions.push("event_type = ?");
      whereValues.push(eventType);
    }

    if (paymentKey) {
      whereConditions.push("payment_key = ?");
      whereValues.push(paymentKey);
    }

    if (orderId) {
      whereConditions.push("order_id = ?");
      whereValues.push(orderId);
    }

    if (billingKey) {
      whereConditions.push("billing_key = ?");
      whereValues.push(billingKey);
    }

    if (customerKey) {
      whereConditions.push("customer_key = ?");
      whereValues.push(customerKey);
    }

    if (createdFrom) {
      whereConditions.push("created_at >= ?");
      whereValues.push(createdFrom);
    }

    if (createdTo) {
      whereConditions.push("created_at <= ?");
      whereValues.push(createdTo);
    }

    const whereClause = `WHERE ${whereConditions.join(" AND ")}`;
    const countRows = await queryRows<CountRow>(
      connection,
      `SELECT COUNT(*) AS count
       FROM ${auditTable}
       ${whereClause}`,
      whereValues,
    );

    const rows = await queryRows<RowDataPacket & {
      id: string;
      webhook_id: string;
      event_type: string;
      payment_key: string | null;
      order_id: string | null;
      billing_key: string | null;
      customer_key: string | null;
      status: string;
      raw_data: string | null;
      processing_result: string | null;
      error_message: string | null;
      processed_at: Date | string | null;
      created_at: Date | string | null;
    }>(
      connection,
      `SELECT *
       FROM ${auditTable}
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...whereValues, limit, offset],
    );

    return {
      data: rows.map((row) => ({
        ...row,
        raw_data: parseJsonField<Record<string, unknown>>(row.raw_data),
        processing_result: parseJsonField<Record<string, unknown>>(row.processing_result),
      })),
      filters: {
        status,
        eventType,
        paymentKey,
        orderId,
        billingKey,
        customerKey,
        createdFrom,
        createdTo,
      },
      pagination: {
        page,
        limit,
        total: countRows[0]?.count || 0,
        totalPages: Math.ceil((countRows[0]?.count || 0) / limit),
      },
    };
  });

  return c.json(success(result, "Webhook audit records retrieved"));
});

paymentRoutes.get("/admin/payments/webhook-audit/stats", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const auditTable = getWebhookAuditTableName(c.env);
  if (!auditTable) {
    throw new HTTPException(503, { message: "PAYMENT_WEBHOOK_AUDIT_TABLE is not configured" });
  }

  const eventType = c.req.query("eventType") || null;
  const status = c.req.query("status") || null;
  const paymentKey = c.req.query("paymentKey") || null;
  const orderId = c.req.query("orderId") || null;
  const billingKey = c.req.query("billingKey") || null;
  const customerKey = c.req.query("customerKey") || null;
  const createdFrom = parseDateTimeFilter(c.req.query("createdFrom") || null, "createdFrom");
  const createdTo = parseDateTimeFilter(c.req.query("createdTo") || null, "createdTo");

  const result = await withConnection(c.env, async (connection) => {
    const whereConditions = ["1 = 1"];
    const whereValues: Array<string | number> = [];

    if (eventType) {
      whereConditions.push("event_type = ?");
      whereValues.push(eventType);
    }

    if (status) {
      whereConditions.push("status = ?");
      whereValues.push(status);
    }

    if (paymentKey) {
      whereConditions.push("payment_key = ?");
      whereValues.push(paymentKey);
    }

    if (orderId) {
      whereConditions.push("order_id = ?");
      whereValues.push(orderId);
    }

    if (billingKey) {
      whereConditions.push("billing_key = ?");
      whereValues.push(billingKey);
    }

    if (customerKey) {
      whereConditions.push("customer_key = ?");
      whereValues.push(customerKey);
    }

    if (createdFrom) {
      whereConditions.push("created_at >= ?");
      whereValues.push(createdFrom);
    }

    if (createdTo) {
      whereConditions.push("created_at <= ?");
      whereValues.push(createdTo);
    }

    const whereClause = `WHERE ${whereConditions.join(" AND ")}`;
    const [statusRows, recentFailureRows] = await Promise.all([
      queryRows<WebhookAuditSummaryRow>(
        connection,
        `SELECT event_type, status, COUNT(*) AS count
         FROM ${auditTable}
         ${whereClause}
         GROUP BY event_type, status
         ORDER BY count DESC`,
        whereValues,
      ).catch(() => []),
      queryRows<RowDataPacket & {
        webhook_id: string;
        event_type: string;
        payment_key: string | null;
        status: string;
        error_message: string | null;
        created_at: Date | string | null;
      }>(
        connection,
        `SELECT webhook_id, event_type, payment_key, status, error_message, created_at
         FROM ${auditTable}
         WHERE ${whereConditions.join(" AND ")} AND status = 'FAILED'
         ORDER BY created_at DESC
         LIMIT 20`,
        whereValues,
      ).catch(() => []),
    ]);

    return {
      filters: {
        eventType,
        status,
        paymentKey,
        orderId,
        billingKey,
        customerKey,
        createdFrom,
        createdTo,
      },
      summary: statusRows.map((row) => ({
        eventType: row.event_type || "UNKNOWN",
        status: row.status || "UNKNOWN",
        count: row.count,
      })),
      recentFailures: recentFailureRows,
    };
  });

  return c.json(success(result, "Webhook audit stats retrieved"));
});

paymentRoutes.get("/admin/payments/cancellations", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const page = parsePositiveInt(c.req.query("page") || null, 1, 500);
  const limit = parsePositiveInt(c.req.query("limit") || null, 20, 100);
  const paymentKey = c.req.query("paymentKey") || null;
  const orderId = c.req.query("orderId") || null;
  const billingKey = c.req.query("billingKey") || null;
  const customerKey = c.req.query("customerKey") || null;
  const requestedBy = c.req.query("requestedBy") || null;
  const status = c.req.query("status") || null;
  const cancellationType = c.req.query("cancellationType") || null;
  const createdFrom = parseDateTimeFilter(c.req.query("createdFrom") || null, "createdFrom");
  const createdTo = parseDateTimeFilter(c.req.query("createdTo") || null, "createdTo");

  const result = await withConnection(c.env, async (connection) => {
    const cancellations = await listCancellationsForAdmin(connection, page, limit, {
      paymentKey,
      orderId,
      billingKey,
      customerKey,
      requestedBy,
      status,
      cancellationType,
      createdFrom,
      createdTo,
    });

    return {
      ...cancellations,
      filters: {
        paymentKey,
        orderId,
        billingKey,
        customerKey,
        requestedBy,
        status,
        cancellationType,
        createdFrom,
        createdTo,
      },
    };
  });

  return c.json(success(result, "Admin payment cancellations retrieved"));
});

paymentRoutes.get("/admin/payments/cancellations/stats", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const paymentKey = c.req.query("paymentKey") || null;
  const orderId = c.req.query("orderId") || null;
  const billingKey = c.req.query("billingKey") || null;
  const customerKey = c.req.query("customerKey") || null;
  const requestedBy = c.req.query("requestedBy") || null;
  const status = c.req.query("status") || null;
  const cancellationType = c.req.query("cancellationType") || null;
  const createdFrom = parseDateTimeFilter(c.req.query("createdFrom") || null, "createdFrom");
  const createdTo = parseDateTimeFilter(c.req.query("createdTo") || null, "createdTo");

  const result = await withConnection(c.env, async (connection) => {
    const whereConditions = ["1 = 1"];
    const whereValues: Array<string | number> = [];

    if (paymentKey) {
      whereConditions.push("pc.payment_key = ?");
      whereValues.push(paymentKey);
    }
    if (orderId) {
      whereConditions.push("p.order_id = ?");
      whereValues.push(orderId);
    }
    if (billingKey) {
      whereConditions.push("p.billing_key = ?");
      whereValues.push(billingKey);
    }
    if (customerKey) {
      whereConditions.push("p.customer_key = ?");
      whereValues.push(customerKey);
    }
    if (requestedBy) {
      whereConditions.push("pc.requested_by = ?");
      whereValues.push(requestedBy);
    }
    if (status) {
      whereConditions.push("pc.status = ?");
      whereValues.push(status);
    }
    if (cancellationType) {
      whereConditions.push("pc.cancellation_type = ?");
      whereValues.push(cancellationType);
    }
    if (createdFrom) {
      whereConditions.push("pc.requested_at >= ?");
      whereValues.push(createdFrom);
    }
    if (createdTo) {
      whereConditions.push("pc.requested_at <= ?");
      whereValues.push(createdTo);
    }

    const whereClause = `WHERE ${whereConditions.join(" AND ")}`;

    const rows = await queryRows<CancellationSummaryRow>(
      connection,
      `SELECT pc.cancellation_type, pc.status, COUNT(*) AS count, COALESCE(SUM(pc.cancel_amount), 0) AS amount
       FROM payment_cancellations pc
       JOIN payments p ON p.id = pc.payment_id
       ${whereClause}
       GROUP BY pc.cancellation_type, pc.status
       ORDER BY count DESC`,
      whereValues,
    ).catch(() => []);

    return {
      filters: {
        paymentKey,
        orderId,
        billingKey,
        customerKey,
        requestedBy,
        status,
        cancellationType,
        createdFrom,
        createdTo,
      },
      summary: rows.map((row) => ({
        cancellationType: row.cancellation_type || "UNKNOWN",
        status: row.status || "UNKNOWN",
        count: row.count,
        amount: Number(row.amount || 0),
      })),
    };
  });

  return c.json(success(result, "Admin payment cancellation stats retrieved"));
});

paymentRoutes.delete("/payments/:paymentKey", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const paymentKey = c.req.param("paymentKey")?.trim();
  if (!paymentKey) {
    throw new HTTPException(400, { message: "Payment key is required" });
  }

  const body = await c.req.json<{
    cancelReason?: string;
    cancelAmount?: number;
    taxFreeAmount?: number;
    taxExemptionAmount?: number;
    refundReceiveAccount?: Record<string, unknown>;
    refundVirtualAccount?: boolean;
  }>();

  const cancelReason = body.cancelReason?.trim();
  if (!cancelReason) {
    throw new HTTPException(400, { message: "cancelReason is required" });
  }
  if (body.cancelAmount !== undefined && (!Number.isFinite(body.cancelAmount) || body.cancelAmount <= 0)) {
    throw new HTTPException(400, { message: "cancelAmount must be a positive number" });
  }

  const result = await withConnection(c.env, async (connection) => {
    const payment = await getOwnedPaymentByKey(connection, paymentKey, session.user.id);
    if (!payment) {
      throw new HTTPException(404, { message: "Payment not found" });
    }

    if (payment.status === "CANCELED" || payment.status === "CANCELLED" || payment.status === "PARTIAL_CANCELED") {
      throw new HTTPException(400, { message: "Payment is already cancelled" });
    }

    const tossCancel = await cancelPaymentWithToss(c.env, paymentKey, {
      cancelReason,
      cancelAmount: body.cancelAmount,
      taxFreeAmount: body.taxFreeAmount,
      taxExemptionAmount: body.taxExemptionAmount,
      refundReceiveAccount: body.refundReceiveAccount,
      refundVirtualAccount: body.refundVirtualAccount,
    });

    const nextStatus = tossCancel.status || normalizeCanceledStatus(payment.amount, body.cancelAmount);
    const cancellationType = determineCancellationType(payment.amount, body.cancelAmount);

    await queryRows(
      connection,
      `UPDATE payments
       SET status = ?, toss_payment_data = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [nextStatus, JSON.stringify(tossCancel), payment.id],
    );

    await queryRows(
      connection,
      `INSERT INTO payment_cancellations
       (payment_id, payment_key, cancel_amount, cancel_reason, cancellation_type, toss_cancel_data,
        transaction_key, status, requested_by, approved_by, requested_at, approved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        payment.id,
        payment.payment_key,
        body.cancelAmount || payment.amount,
        cancelReason,
        cancellationType,
        JSON.stringify(tossCancel),
        tossCancel.lastTransactionKey || null,
        nextStatus,
        session.user.id,
        session.user.id,
      ],
    );

    if (Boolean(payment.is_billing) && cancellationType === "FULL") {
      await cancelLinkedBillingCycle(connection, payment.id);
    }

    const refreshedPayment = await getOwnedPaymentByKey(connection, paymentKey, session.user.id);
    const cancellations = await getPaymentCancellationsForKey(connection, paymentKey, session.user.id);

    return {
      payment: refreshedPayment ? formatPaymentForLegacyResponse(refreshedPayment) : null,
      cancellation: cancellations.cancellations[0]
        ? formatCancellationForLegacyResponse(cancellations.cancellations[0])
        : null,
    };
  });

  return c.json({
    success: true,
    message: "Payment cancelled successfully",
    data: result,
    timestamp: new Date().toISOString(),
  });
});

paymentRoutes.post("/payments/confirm", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = await c.req.json<{
    paymentKey?: string;
    orderId?: string;
    amount?: number;
    originalAmount?: number;
    membershipPlan?: string;
    promotionCode?: string;
  }>();

  const validationErrors: Array<{ field: string; message: string }> = [];
  if (!body.paymentKey) {
    validationErrors.push({ field: "body.paymentKey", message: "paymentKey 필드는 필수입니다." });
  }
  if (!body.orderId) {
    validationErrors.push({ field: "body.orderId", message: "orderId 필드는 필수입니다." });
  }
  if (body.amount === undefined || body.amount === null) {
    validationErrors.push({ field: "body.amount", message: "amount 필드는 필수입니다." });
  } else if (typeof body.amount !== "number" || body.amount <= 0) {
    validationErrors.push({ field: "body.amount", message: "amount 필드는 1 이상의 숫자여야 합니다." });
  }

  if (validationErrors.length > 0) {
    throw new HTTPException(422, {
      res: new Response(
        JSON.stringify(
          legacyValidationFailure(
            "요청 본문 검증에 실패했습니다.",
            c.req.path,
            c.req.method,
            validationErrors,
          ),
        ),
        {
          status: 422,
          headers: { "Content-Type": "application/json; charset=utf-8" },
        },
      ),
    });
  }

  const confirmed = await confirmPaymentWithToss(c.env, {
    paymentKey: body.paymentKey as string,
    orderId: body.orderId as string,
    amount: body.amount as number,
  });

  const saved = await withConnection(c.env, async (connection) => {
    let promotion: Awaited<ReturnType<typeof validatePromotionCodeOrThrow>> | null = null;
    if (body.promotionCode && typeof body.originalAmount === "number" && body.originalAmount > 0) {
      promotion = await validatePromotionCodeOrThrow(
        connection,
        body.promotionCode,
        session.user.id,
        body.originalAmount,
        body.membershipPlan || confirmed.orderName,
      );

      if (promotion.discount.finalAmount !== confirmed.totalAmount) {
        throw new HTTPException(400, { message: "Promotion-adjusted amount does not match confirmed payment amount" });
      }
    }

    const existingRows = await queryRows<PaymentRow>(
      connection,
      `SELECT *
       FROM payments
       WHERE payment_key = ? OR order_id = ?
       ORDER BY created_at DESC
       LIMIT 1`,
      [confirmed.paymentKey, confirmed.orderId],
    );

    const orderName = confirmed.orderName;
    const status = confirmed.status || "DONE";
    const method = confirmed.method || "CARD";
    const isBilling = orderName.toUpperCase().includes("MONTH") || orderName.toUpperCase().includes("YEAR");
    let paymentId = existingRows[0]?.id || null;

    if (existingRows[0]) {
      await queryRows(
        connection,
        `UPDATE payments
         SET payment_key = ?, order_id = ?, order_name = ?, amount = ?, currency = ?, method = ?, status = ?,
             toss_payment_data = ?, is_billing = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [
          confirmed.paymentKey,
          confirmed.orderId,
          orderName,
          confirmed.totalAmount,
          confirmed.currency || "KRW",
          method,
          status,
          JSON.stringify(confirmed),
          isBilling ? 1 : 0,
          existingRows[0].id,
        ],
      );
    } else {
      await queryRows(
        connection,
        `INSERT INTO payments
         (payment_key, order_id, order_name, user_id, amount, currency, method, status, toss_payment_data, is_billing, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          confirmed.paymentKey,
          confirmed.orderId,
          orderName,
          session.user.id,
          confirmed.totalAmount,
          confirmed.currency || "KRW",
          method,
          status,
          JSON.stringify(confirmed),
          isBilling ? 1 : 0,
          session.user.id,
        ],
      );

      const createdRows = await queryRows<PaymentRow>(
        connection,
        `SELECT *
         FROM payments
         WHERE payment_key = ?
         LIMIT 1`,
        [confirmed.paymentKey],
      );
      paymentId = createdRows[0]?.id || null;
    }

    if (status === "DONE") {
      await applyMembershipByOrderName(connection, session.user.id, orderName);
    }

    if (promotion && paymentId) {
      await recordPromotionCodeUse(connection, {
        promotionId: promotion.promotionId,
        code: promotion.code,
        userId: session.user.id,
        originalAmount: promotion.discount.originalAmount,
        discountAmount: promotion.discount.discountAmount,
        finalAmount: promotion.discount.finalAmount,
        paymentId,
      });
    }

    const refreshedRows = await queryRows<PaymentRow>(
      connection,
      `SELECT *
       FROM payments
       WHERE payment_key = ?
       LIMIT 1`,
      [confirmed.paymentKey],
    );
    return refreshedRows[0] ? formatPaymentForLegacyResponse(refreshedRows[0]) : null;
  });

  if (!saved) {
    throw new HTTPException(500, { message: "Failed to persist confirmed payment" });
  }

  return c.json({
    success: true,
    message: "Payment confirmed successfully",
    data: saved,
    timestamp: new Date().toISOString(),
  });
});

paymentRoutes.post("/payments/webhook", async (c) => {
  const rawBody = await c.req.text();
  let webhook: TossWebhookPayload;

  try {
    webhook = JSON.parse(rawBody) as TossWebhookPayload;
  } catch {
    throw new HTTPException(400, { message: "Invalid webhook data format" });
  }

  if (!webhook || typeof webhook !== "object" || !webhook.eventType || !webhook.data) {
    throw new HTTPException(400, { message: "Webhook eventType and data are required" });
  }

  const webhookSecret = c.env.TOSS_WEBHOOK_SECRET?.trim();
  if (webhookSecret) {
    const signature = extractWebhookSignature(c.req.raw.headers);
    if (!(await verifyWebhookSignature(rawBody, signature, webhookSecret))) {
      throw new HTTPException(401, { message: "Webhook signature verification failed" });
    }
  }

  if (webhook.createdAt && !validateWebhookTimestamp(webhook.createdAt, 300)) {
    throw new HTTPException(400, { message: "Webhook timestamp is too old" });
  }

  const result = await withConnection(c.env, async (connection) => {
    const eventType = webhook.eventType as string;
    const paymentData = webhook.data || {};
    const paymentKey = typeof paymentData.paymentKey === "string" ? paymentData.paymentKey.trim() : null;
    const orderId = typeof paymentData.orderId === "string" ? paymentData.orderId.trim() : null;
    const billingKey = typeof paymentData.billingKey === "string" ? paymentData.billingKey.trim() : null;
    const customerKey = typeof paymentData.customerKey === "string" ? paymentData.customerKey.trim() : null;
    const webhookId = webhook.id || `webhook_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

    try {
      let result: unknown;
      switch (eventType) {
        case "PAYMENT_STATUS_CHANGED": {
          if (!paymentKey) {
            throw new HTTPException(400, { message: "paymentKey is required for PAYMENT_STATUS_CHANGED" });
          }

          const updated = await updatePaymentFromWebhook(connection, paymentKey, paymentData);
          result = {
            action: updated ? "status_updated" : "payment_not_found",
            eventType,
            paymentKey,
            payment: updated,
          };
          break;
        }

        case "BILLING_DELETED": {
          if (!billingKey) {
            throw new HTTPException(400, { message: "billingKey is required for BILLING_DELETED" });
          }

          await queryRows(
            connection,
            `UPDATE billing_cycles
             SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
             WHERE billing_key = ? AND status != 'CANCELLED'`,
            [billingKey],
          );

          const cycleRows = await queryRows<RowDataPacket & { id: number; payment_id: number }>(
            connection,
            `SELECT id, payment_id
             FROM billing_cycles
             WHERE billing_key = ?
             ORDER BY id DESC`,
            [billingKey],
          );

          result = {
            action: cycleRows.length > 0 ? "billing_cancelled" : "billing_cycle_not_found",
            eventType,
            billingKey,
            billingCycleIds: cycleRows.map((row) => row.id),
          };
          break;
        }

        case "PAYMENT_WEBHOOK": {
          if (!paymentKey) {
            throw new HTTPException(400, { message: "paymentKey is required for PAYMENT_WEBHOOK" });
          }

          const updated = await updatePaymentFromWebhook(connection, paymentKey, paymentData);
          result = {
            action: updated ? "payment_updated" : "payment_not_found",
            eventType,
            paymentKey,
            payment: updated,
          };
          break;
        }

        default:
          result = {
            action: "ignored",
            eventType,
            reason: "Unsupported webhook event",
          };
      }

      await persistWebhookAudit(connection, c.env, {
        webhookId,
        eventType,
        paymentKey,
        orderId,
        billingKey,
        customerKey,
        status: "PROCESSED",
        rawData: webhook,
        result,
      });

      return result;
    } catch (error) {
      await persistWebhookAudit(connection, c.env, {
        webhookId,
        eventType,
        paymentKey,
        orderId,
        billingKey,
        customerKey,
        status: "FAILED",
        rawData: webhook,
        errorMessage: error instanceof Error ? error.message : "Webhook processing failed",
      });
      throw error;
    }
  });

  return c.json(success(result, "Webhook processed successfully"));
});

paymentRoutes.post("/payments/test/membership", async (c) => {
  await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body: { userId?: string; orderName?: string } =
    await c.req.json<{ userId?: string; orderName?: string }>().catch(
      () => ({} as { userId?: string; orderName?: string }),
    );
  if (!body.userId || !body.orderName) {
    throw new HTTPException(400, { message: "userId and orderName are required" });
  }

  const result = await withConnection(c.env, async (connection) => {
    const processed = await applyMembershipByOrderName(connection, body.userId!, body.orderName!);
    return {
      userId: body.userId,
      orderName: body.orderName,
      processed,
    };
  });

  return c.json({
    success: true,
    data: result,
    message: "Membership processing test completed",
    timestamp: new Date().toISOString(),
  });
});
