import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import { queryRows, type DbConnection } from "./db";

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
}

function parseApplicablePlans(value: string | null): string[] | null {
  if (!value) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : null;
  } catch {
    return null;
  }
}

function discountAmountFor(row: PromotionRow, amount: number) {
  if (row.discount_type === "FIXED_AMOUNT") {
    return Math.min(Number(row.discount_value), amount);
  }

  const percentage = Math.min(100, Math.max(0, Number(row.discount_value)));
  return Math.floor(amount * (percentage / 100));
}

export interface PromotionValidationSuccess {
  promotionId: number;
  code: string;
  discountType: "FIXED_AMOUNT" | "PERCENTAGE";
  discountValue: number;
  applicablePlans: string[] | null;
  description: string | null;
  expiresAt: Date | string | null;
  discount: {
    originalAmount: number;
    discountAmount: number;
    finalAmount: number;
    discountRate: number;
  };
}

export async function validatePromotionCodeOrThrow(
  connection: DbConnection,
  code: string,
  userId: string,
  originalAmount: number,
  membershipPlan?: string | null,
): Promise<PromotionValidationSuccess> {
  const normalizedCode = code.trim().toUpperCase();
  if (!normalizedCode) {
    throw new HTTPException(400, { message: "프로모션 코드를 입력해주세요" });
  }

  const rows = await queryRows<PromotionRow>(
    connection,
    `SELECT id, code, discount_type, discount_value, applicable_plans, description, is_active, current_uses, max_uses, expires_at
     FROM promotion_codes
     WHERE code = ?
     LIMIT 1`,
    [normalizedCode],
  );
  const row = rows[0];

  if (!row) {
    throw new HTTPException(404, { message: "유효하지 않은 프로모션 코드입니다" });
  }

  if (!row.is_active) {
    throw new HTTPException(400, { message: "비활성화된 프로모션 코드입니다" });
  }

  if (row.expires_at && new Date(row.expires_at) < new Date()) {
    throw new HTTPException(400, { message: "만료된 프로모션 코드입니다" });
  }

  if (row.max_uses !== -1 && row.current_uses >= row.max_uses) {
    throw new HTTPException(400, { message: "사용 가능 횟수를 초과한 프로모션 코드입니다" });
  }

  const usageRows = await queryRows<RowDataPacket & { count: number }>(
    connection,
    `SELECT COUNT(*) AS count
     FROM promotion_code_usage
     WHERE promotion_code_id = ? AND used_by = ?`,
    [row.id, userId],
  ).catch(() => [{ count: 0 }] as Array<RowDataPacket & { count: number }>);

  if ((usageRows[0]?.count || 0) > 0) {
    throw new HTTPException(400, { message: "이미 사용한 프로모션 코드입니다" });
  }

  const applicablePlans = parseApplicablePlans(row.applicable_plans);
  if (applicablePlans && applicablePlans.length > 0) {
    const plan = (membershipPlan || "").trim().toUpperCase();
    if (!plan) {
      throw new HTTPException(400, { message: "멤버십 플랜 정보가 필요합니다" });
    }

    const normalizedPlans = applicablePlans.map((item) => item.toUpperCase());
    if (!normalizedPlans.includes(plan)) {
      throw new HTTPException(400, {
        message: `이 프로모션 코드는 ${applicablePlans.join(", ")} 플랜에만 적용됩니다`,
      });
    }
  }

  const discountAmount = discountAmountFor(row, originalAmount);
  const finalAmount = Math.max(0, originalAmount - discountAmount);

  return {
    promotionId: row.id,
    code: row.code,
    discountType: row.discount_type,
    discountValue: Number(row.discount_value),
    applicablePlans,
    description: row.description,
    expiresAt: row.expires_at,
    discount: {
      originalAmount,
      discountAmount,
      finalAmount,
      discountRate: originalAmount > 0 ? Math.round((discountAmount / originalAmount) * 100) : 0,
    },
  };
}

export async function recordPromotionCodeUse(
  connection: DbConnection,
  params: {
    promotionId: number;
    code: string;
    userId: string;
    originalAmount: number;
    discountAmount: number;
    finalAmount: number;
    paymentId?: number | null;
    billingCycleId?: number | null;
  },
) {
  await queryRows(
    connection,
    `INSERT INTO promotion_code_usage
     (promotion_code_id, code, used_by, used_at, original_amount, discount_amount, final_amount, payment_id, billing_cycle_id)
     VALUES (?, ?, ?, NOW(), ?, ?, ?, ?, ?)`,
    [
      params.promotionId,
      params.code,
      params.userId,
      params.originalAmount,
      params.discountAmount,
      params.finalAmount,
      params.paymentId || null,
      params.billingCycleId || null,
    ],
  );

  await queryRows(
    connection,
    `UPDATE promotion_codes
     SET current_uses = current_uses + 1
     WHERE id = ?`,
    [params.promotionId],
  );
}
