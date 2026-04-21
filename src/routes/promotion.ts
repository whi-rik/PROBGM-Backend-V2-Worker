import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { requireAdminSessionFromRequest } from "../lib/admin";
import { optionalSessionFromRequest, requireSessionFromRequest } from "../lib/auth";
import { queryRows, withConnection } from "../lib/db";
import { success } from "../lib/response";
import { validatePromotionCodeOrThrow } from "../lib/promotion";

interface PromotionRow extends RowDataPacket {
  id: number;
  code: string;
  discount_type: "FIXED_AMOUNT" | "PERCENTAGE";
  discount_value: number;
  applicable_plans: string | null;
  description: string | null;
  is_active: number;
  current_uses: number;
  max_uses: number;
  expires_at: Date | string | null;
  created_at?: Date | string | null;
  updated_at?: Date | string | null;
}

interface PromotionUsageRow extends RowDataPacket {
  id: number;
  promotion_code_id: number;
  code: string;
  used_by: string;
  used_at: Date | string | null;
  original_amount: number;
  discount_amount: number;
  final_amount: number;
  payment_id: number | null;
  billing_cycle_id: number | null;
  ip_address: string | null;
  user_agent: string | null;
  discount_type?: string | null;
  description?: string | null;
}

interface PromotionStatsRow extends RowDataPacket {
  total: number;
  active: number;
  expired: number;
  totalUses: number;
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

function parseApplicablePlans(value: string | null) {
  if (!value) {
    return null;
  }
  try {
    return JSON.parse(value) as string[];
  } catch {
    return null;
  }
}

function normalizeCode(value: unknown) {
  return typeof value === "string" ? value.trim().toUpperCase().slice(0, 100) : "";
}

export const promotionRoutes = new Hono<{ Bindings: Bindings }>();

promotionRoutes.get("/promotion/check/:code", async (c) => {
  const rawCode = c.req.param("code")?.trim().toUpperCase();
  if (!rawCode) {
    return c.json({
      success: false,
      valid: false,
      message: "프로모션 코드를 입력해주세요",
    }, 400);
  }

  const amount = Number(c.req.query("amount") || "0");
  const plan = (c.req.query("plan") || "").trim().toUpperCase();
  const session = await optionalSessionFromRequest(c.env, c.req.header("Authorization"));

  const result = await withConnection(c.env, async (connection) => {
    const rows = await queryRows<PromotionRow>(
      connection,
      `SELECT code, discount_type, discount_value, applicable_plans, description, is_active, current_uses, max_uses, expires_at
       FROM promotion_codes
       WHERE code = ?
       LIMIT 1`,
      [rawCode],
    ).catch(() => []);

    const row = rows[0];
    if (!row) {
      return {
        success: false,
        valid: false,
        message: "유효하지 않은 프로모션 코드입니다",
      };
    }

    if (!row.is_active) {
      return {
        success: false,
        valid: false,
        message: "비활성화된 프로모션 코드입니다",
        data: { code: row.code, isActive: false },
      };
    }

    if (row.expires_at && new Date(row.expires_at) < new Date()) {
      return {
        success: false,
        valid: false,
        message: "만료된 프로모션 코드입니다",
        data: { code: row.code, expiresAt: row.expires_at },
      };
    }

    if (row.max_uses !== -1 && row.current_uses >= row.max_uses) {
      return {
        success: false,
        valid: false,
        message: "사용 가능 횟수를 초과한 프로모션 코드입니다",
      };
    }

    const baseData = {
      code: row.code,
      discountType: row.discount_type,
      discountValue: Number(row.discount_value),
      applicablePlans: row.applicable_plans ? JSON.parse(row.applicable_plans) : null,
      description: row.description,
      usage: {
        current: row.current_uses,
        max: row.max_uses,
        remaining: row.max_uses === -1 ? "unlimited" : row.max_uses - row.current_uses,
      },
      expiresAt: row.expires_at,
      requestedBy: session?.user.id || "anonymous",
    };

    if (!(amount > 0)) {
      return {
        success: true,
        valid: true,
        message: "사용 가능한 프로모션 코드입니다",
        data: baseData,
      };
    }

    const validated = await validatePromotionCodeOrThrow(
      connection,
      rawCode,
      session?.user.id || "anonymous",
      amount,
      plan || null,
    ).catch((error) => ({ error: error instanceof Error ? error.message : "프로모션 코드를 사용할 수 없습니다" }));

    if ("error" in validated) {
      return {
        success: false,
        valid: false,
        message: validated.error,
      };
    }

    return {
      success: true,
      valid: true,
      message: "사용 가능한 프로모션 코드입니다",
      data: {
        ...baseData,
        discount: validated.discount,
      },
    };
  });

  return c.json(result, result.success ? 200 : 404);
});

promotionRoutes.get("/promotion/history", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const page = parsePositiveInt(c.req.query("page") || null, 1, 500);
  const limit = parsePositiveInt(c.req.query("limit") || null, 20, 100);
  const offset = (page - 1) * limit;
  const code = normalizeCode(c.req.query("code"));
  const createdFrom = parseDateTimeFilter(c.req.query("createdFrom") || null, "createdFrom");
  const createdTo = parseDateTimeFilter(c.req.query("createdTo") || null, "createdTo");

  const data = await withConnection(c.env, async (connection) => {
    const whereConditions = ["pcu.used_by = ?"];
    const whereValues: Array<string | number> = [session.user.id];

    if (code) {
      whereConditions.push("pc.code = ?");
      whereValues.push(code);
    }
    if (createdFrom) {
      whereConditions.push("pcu.used_at >= ?");
      whereValues.push(createdFrom);
    }
    if (createdTo) {
      whereConditions.push("pcu.used_at <= ?");
      whereValues.push(createdTo);
    }

    const whereClause = `WHERE ${whereConditions.join(" AND ")}`;
    const countRows = await queryRows<RowDataPacket & { count: number }>(
      connection,
      `SELECT COUNT(*) AS count
       FROM promotion_code_usage pcu
       JOIN promotion_codes pc ON pcu.promotion_code_id = pc.id
       ${whereClause}`,
      whereValues,
    ).catch(() => [{ count: 0 }] as Array<RowDataPacket & { count: number }>);

    const rows = await queryRows<PromotionUsageRow>(
      connection,
      `SELECT pcu.*, pc.code, pc.discount_type, pc.description
       FROM promotion_code_usage pcu
       JOIN promotion_codes pc ON pcu.promotion_code_id = pc.id
       ${whereClause}
       ORDER BY pcu.used_at DESC`,
      whereValues,
    ).catch(() => []);

    return {
      data: rows.slice(offset, offset + limit),
      filters: {
        code: code || null,
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

  return c.json(success(data, "Promotion history retrieved"));
});

promotionRoutes.get("/promotion/stats", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const createdFrom = parseDateTimeFilter(c.req.query("createdFrom") || null, "createdFrom");
  const createdTo = parseDateTimeFilter(c.req.query("createdTo") || null, "createdTo");

  const data = await withConnection(c.env, async (connection) => {
    const usageWhereConditions = ["1 = 1"];
    const usageWhereValues: Array<string | number> = [];
    if (createdFrom) {
      usageWhereConditions.push("used_at >= ?");
      usageWhereValues.push(createdFrom);
    }
    if (createdTo) {
      usageWhereConditions.push("used_at <= ?");
      usageWhereValues.push(createdTo);
    }

    const [basicStats, discountStats, typeStats] = await Promise.all([
      queryRows<PromotionStatsRow>(
        connection,
        `SELECT
            COUNT(*) as total,
            SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
            SUM(CASE WHEN expires_at IS NOT NULL AND expires_at < CURRENT_TIMESTAMP THEN 1 ELSE 0 END) as expired,
            SUM(current_uses) as totalUses
         FROM promotion_codes`,
      ),
      queryRows<RowDataPacket & { totalDiscountAmount: number }>(
        connection,
        `SELECT COALESCE(SUM(discount_amount), 0) AS totalDiscountAmount
         FROM promotion_code_usage
         WHERE ${usageWhereConditions.join(" AND ")}`,
        usageWhereValues,
      ).catch(() => [{ totalDiscountAmount: 0 }] as Array<RowDataPacket & { totalDiscountAmount: number }>),
      queryRows<RowDataPacket & { discount_type: string; count: number }>(
        connection,
        `SELECT discount_type, COUNT(*) as count
         FROM promotion_codes
         GROUP BY discount_type`,
      ).catch(() => []),
    ]);

    const byType: Record<string, number> = {};
    for (const row of typeStats) {
      byType[row.discount_type] = row.count;
    }

    return {
      filters: {
        createdFrom,
        createdTo,
      },
      total: basicStats[0]?.total || 0,
      active: basicStats[0]?.active || 0,
      expired: basicStats[0]?.expired || 0,
      totalUses: basicStats[0]?.totalUses || 0,
      totalDiscountAmount: Number(discountStats[0]?.totalDiscountAmount || 0),
      byType,
    };
  });

  return c.json(success(data, "Promotion stats retrieved"));
});

promotionRoutes.get("/promotion/usage/:code", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const code = c.req.param("code")?.trim().toUpperCase();
  if (!code) {
    throw new HTTPException(400, { message: "프로모션 코드를 입력해주세요" });
  }
  const page = parsePositiveInt(c.req.query("page") || null, 1, 500);
  const limit = parsePositiveInt(c.req.query("limit") || null, 20, 100);
  const offset = (page - 1) * limit;
  const usedBy = (c.req.query("usedBy") || "").trim() || null;
  const paymentId = c.req.query("paymentId") ? Number(c.req.query("paymentId")) : null;
  const createdFrom = parseDateTimeFilter(c.req.query("createdFrom") || null, "createdFrom");
  const createdTo = parseDateTimeFilter(c.req.query("createdTo") || null, "createdTo");
  if (paymentId !== null && (!Number.isFinite(paymentId) || paymentId <= 0)) {
    throw new HTTPException(400, { message: "paymentId must be a positive number" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const whereConditions = ["pc.code = ?"];
    const whereValues: Array<string | number> = [code];

    if (usedBy) {
      whereConditions.push("pcu.used_by = ?");
      whereValues.push(usedBy);
    }
    if (paymentId !== null) {
      whereConditions.push("pcu.payment_id = ?");
      whereValues.push(paymentId);
    }
    if (createdFrom) {
      whereConditions.push("pcu.used_at >= ?");
      whereValues.push(createdFrom);
    }
    if (createdTo) {
      whereConditions.push("pcu.used_at <= ?");
      whereValues.push(createdTo);
    }

    const whereClause = `WHERE ${whereConditions.join(" AND ")}`;
    const countRows = await queryRows<RowDataPacket & { count: number }>(
      connection,
      `SELECT COUNT(*) AS count
       FROM promotion_code_usage pcu
       JOIN promotion_codes pc ON pcu.promotion_code_id = pc.id
       ${whereClause}`,
      whereValues,
    ).catch(() => [{ count: 0 }] as Array<RowDataPacket & { count: number }>);

    const rows = await queryRows<PromotionUsageRow>(
      connection,
      `SELECT pcu.*, pc.code
       FROM promotion_code_usage pcu
       JOIN promotion_codes pc ON pcu.promotion_code_id = pc.id
       ${whereClause}
       ORDER BY pcu.used_at DESC
       LIMIT ? OFFSET ?`,
      [...whereValues, limit, offset],
    ).catch(() => []);

    return {
      data: rows,
      filters: {
        code,
        usedBy,
        paymentId,
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

  return c.json(success(data, "Promotion code usage retrieved"));
});

promotionRoutes.get("/admin/promotions", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const code = normalizeCode(c.req.query("code"));
  const active = c.req.query("active");
  const page = parsePositiveInt(c.req.query("page") || null, 1, 500);
  const limit = parsePositiveInt(c.req.query("limit") || null, 20, 100);
  const offset = (page - 1) * limit;

  const data = await withConnection(c.env, async (connection) => {
    const whereConditions = ["1 = 1"];
    const whereValues: Array<string | number> = [];

    if (code) {
      whereConditions.push("code = ?");
      whereValues.push(code);
    }
    if (active === "true") {
      whereConditions.push("is_active = 1");
    } else if (active === "false") {
      whereConditions.push("is_active = 0");
    }

    const whereClause = `WHERE ${whereConditions.join(" AND ")}`;
    const countRows = await queryRows<RowDataPacket & { count: number }>(
      connection,
      `SELECT COUNT(*) AS count
       FROM promotion_codes
       ${whereClause}`,
      whereValues,
    ).catch(() => [{ count: 0 }] as Array<RowDataPacket & { count: number }>);

    const rows = await queryRows<PromotionRow>(
      connection,
      `SELECT *
       FROM promotion_codes
       ${whereClause}
       ORDER BY created_at DESC, code ASC
       LIMIT ? OFFSET ?`,
      [...whereValues, limit, offset],
    ).catch(() => []);

    return {
      data: rows.map((row) => ({
        ...row,
        applicable_plans: parseApplicablePlans(row.applicable_plans),
      })),
      filters: {
        code: code || null,
        active: active === "true" ? true : active === "false" ? false : null,
      },
      pagination: {
        page,
        limit,
        total: countRows[0]?.count || 0,
        totalPages: Math.ceil((countRows[0]?.count || 0) / limit),
      },
    };
  });

  return c.json(success(data, "Promotions retrieved"));
});

promotionRoutes.post("/admin/promotions", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = ((await c.req.json().catch(() => ({}))) || {}) as {
    code?: string;
    discount_type?: "FIXED_AMOUNT" | "PERCENTAGE";
    discount_value?: number;
    applicable_plans?: string[] | null;
    max_uses?: number;
    expires_at?: string | null;
    description?: string;
  };

  const code = normalizeCode(body.code);
  if (!code) {
    throw new HTTPException(400, { message: "code is required" });
  }
  if (body.discount_type !== "FIXED_AMOUNT" && body.discount_type !== "PERCENTAGE") {
    throw new HTTPException(400, { message: "discount_type must be FIXED_AMOUNT or PERCENTAGE" });
  }
  if (typeof body.discount_value !== "number" || !Number.isFinite(body.discount_value) || body.discount_value < 0) {
    throw new HTTPException(400, { message: "discount_value must be a non-negative number" });
  }
  const discountType = body.discount_type;
  const discountValue = body.discount_value;

  const data = await withConnection(c.env, async (connection) => {
    const existing = await queryRows<PromotionRow>(
      connection,
      "SELECT * FROM promotion_codes WHERE code = ? LIMIT 1",
      [code],
    );
    if (existing[0]) {
      throw new HTTPException(400, { message: `Promotion code "${code}" already exists` });
    }

    await queryRows(
      connection,
      `INSERT INTO promotion_codes
       (code, discount_type, discount_value, applicable_plans, max_uses, expires_at, description, is_active, current_uses)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, 0)`,
      [
        code,
        discountType,
        discountValue,
        Array.isArray(body.applicable_plans) ? JSON.stringify(body.applicable_plans) : null,
        typeof body.max_uses === "number" && Number.isFinite(body.max_uses) ? Math.floor(body.max_uses) : 1,
        body.expires_at || null,
        typeof body.description === "string" ? body.description.trim() : null,
      ],
    );

    const created = await queryRows<PromotionRow>(
      connection,
      "SELECT * FROM promotion_codes WHERE code = ? LIMIT 1",
      [code],
    );

    return created.map((row) => ({
      ...row,
      applicable_plans: parseApplicablePlans(row.applicable_plans),
    }))[0] || null;
  });

  return c.json(success(data, "Promotion created"), 201);
});

promotionRoutes.put("/admin/promotions/:code/deactivate", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const code = normalizeCode(c.req.param("code"));
  if (!code) {
    throw new HTTPException(400, { message: "code is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const existing = await queryRows<PromotionRow>(
      connection,
      "SELECT * FROM promotion_codes WHERE code = ? LIMIT 1",
      [code],
    );
    if (!existing[0]) {
      throw new HTTPException(404, { message: `Promotion code "${code}" not found` });
    }

    await queryRows(
      connection,
      "UPDATE promotion_codes SET is_active = 0 WHERE code = ?",
      [code],
    );

    const updated = await queryRows<PromotionRow>(
      connection,
      "SELECT * FROM promotion_codes WHERE code = ? LIMIT 1",
      [code],
    );

    return updated.map((row) => ({
      ...row,
      applicable_plans: parseApplicablePlans(row.applicable_plans),
    }))[0] || null;
  });

  return c.json(success(data, "Promotion deactivated"));
});
