import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Bindings } from "../env";
import { requireAdminSessionFromRequest } from "../lib/admin";
import { requireSessionFromRequest } from "../lib/auth";
import { withConnection } from "../lib/db";
import {
  addBonusCredits,
  addBonusDownloadPoints,
  grantRedeemMembership,
  redeemMembershipTypeToTier,
  type RedeemMembershipType,
} from "../lib/membership";
import {
  findRedeemCode,
  getRedeemCodeUsageHistory,
  getRedeemStats,
  getUserRedeemHistory,
  normalizeRedeemCode,
  useRedeemCode,
  validateRedeemCode,
  type RedeemCodeRow,
  type RedeemValidationReason,
} from "../lib/redeem";

function reasonToMessage(reason: RedeemValidationReason | undefined): string {
  switch (reason) {
    case "Code not found":
      return "Invalid redeem code";
    case "Code is inactive":
      return "This redeem code is no longer active";
    case "Code has expired":
      return "This redeem code has expired";
    case "Code usage limit reached":
      return "This redeem code has reached its usage limit";
    case "User already used this code":
      return "You have already used this redeem code";
    default:
      return "This redeem code cannot be used";
  }
}

function getClientIp(headers: Headers): string | null {
  return headers.get("CF-Connecting-IP") || headers.get("X-Forwarded-For") || null;
}

function getUserAgent(headers: Headers): string | null {
  return headers.get("User-Agent");
}

function remainingUses(row: Pick<RedeemCodeRow, "max_uses" | "current_uses">): number | "unlimited" {
  if (row.max_uses === -1) {
    return "unlimited";
  }
  return Math.max(0, row.max_uses - row.current_uses);
}

export const redeemRoutes = new Hono<{ Bindings: Bindings }>();

redeemRoutes.post("/redeem", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = ((await c.req.json().catch(() => ({}))) || {}) as { code?: unknown };
  const rawCode = typeof body.code === "string" ? body.code : "";
  const trimmedCode = normalizeRedeemCode(rawCode);

  if (!trimmedCode) {
    throw new HTTPException(400, { message: "Redeem code is required" });
  }

  const ipAddress = getClientIp(c.req.raw.headers);
  const userAgent = getUserAgent(c.req.raw.headers);

  const result = await withConnection(c.env, async (connection) => {
    const validation = await validateRedeemCode(connection, trimmedCode, session.user.id);
    if (!validation.valid) {
      throw new HTTPException(400, { message: reasonToMessage(validation.reason) });
    }
    const redeemCodeData = validation.data!;

    if (
      redeemCodeData.reward_type === "membership" ||
      redeemCodeData.reward_type === "combo"
    ) {
      if (redeemCodeData.membership_type) {
        try {
          redeemMembershipTypeToTier(redeemCodeData.membership_type as RedeemMembershipType);
        } catch {
          throw new HTTPException(400, { message: "Invalid membership type on redeem code" });
        }
      }
    }

    const usedCode = await useRedeemCode(connection, trimmedCode, {
      userId: session.user.id,
      ipAddress,
      userAgent,
    });

    if (!usedCode) {
      throw new HTTPException(400, {
        message: "Failed to use redeem code. It may have been used by someone else just now.",
      });
    }

    const rewardResults: {
      rewardType: string;
      membership?: { type: string; durationDays: number; endDate: string };
      credits?: { amount: number; expiresInDays: number };
      downloadPoints?: { amount: number; expiresInDays: number };
    } = {
      rewardType: redeemCodeData.reward_type,
    };

    try {
      if (
        (redeemCodeData.reward_type === "membership" || redeemCodeData.reward_type === "combo") &&
        redeemCodeData.membership_type &&
        redeemCodeData.duration_days
      ) {
        const membershipEndDate = new Date();
        membershipEndDate.setDate(membershipEndDate.getDate() + redeemCodeData.duration_days);

        await grantRedeemMembership(
          connection,
          session.user.id,
          redeemCodeData.membership_type as RedeemMembershipType,
          redeemCodeData.duration_days,
        );

        rewardResults.membership = {
          type: redeemCodeData.membership_type,
          durationDays: redeemCodeData.duration_days,
          endDate: membershipEndDate.toISOString(),
        };
      }

      if (
        (redeemCodeData.reward_type === "credits" || redeemCodeData.reward_type === "combo") &&
        redeemCodeData.credits_amount
      ) {
        const expiresInDays = redeemCodeData.duration_days || 365;
        await addBonusCredits(
          connection,
          session.user.id,
          redeemCodeData.credits_amount,
          expiresInDays,
          `Redeem code: ${trimmedCode}`,
        );
        rewardResults.credits = {
          amount: redeemCodeData.credits_amount,
          expiresInDays,
        };
      }

      if (
        (redeemCodeData.reward_type === "download_points" || redeemCodeData.reward_type === "combo") &&
        redeemCodeData.download_points_amount
      ) {
        const expiresInDays = redeemCodeData.duration_days || 365;
        await addBonusDownloadPoints(
          connection,
          session.user.id,
          redeemCodeData.download_points_amount,
          expiresInDays,
        );
        rewardResults.downloadPoints = {
          amount: redeemCodeData.download_points_amount,
          expiresInDays,
        };
      }
    } catch (rewardError) {
      console.error(
        "[redeem] CRITICAL: code consumed but reward grant failed — manual fix required",
        JSON.stringify({
          userId: session.user.id,
          code: trimmedCode,
          rewardType: redeemCodeData.reward_type,
          membershipType: redeemCodeData.membership_type,
          durationDays: redeemCodeData.duration_days,
          creditsAmount: redeemCodeData.credits_amount,
          downloadPointsAmount: redeemCodeData.download_points_amount,
          partialRewards: rewardResults,
          error: rewardError instanceof Error ? rewardError.message : String(rewardError),
          timestamp: new Date().toISOString(),
        }),
      );
      throw new HTTPException(500, {
        message: "Redeem code was used but reward grant failed. Please contact support.",
      });
    }

    return {
      success: true,
      message: "Redeem code used successfully",
      data: {
        ...rewardResults,
        codeUsage: {
          current: usedCode.current_uses,
          max: usedCode.max_uses,
          remaining: remainingUses(usedCode),
        },
      },
      timestamp: new Date().toISOString(),
    };
  });

  return c.json(result);
});

redeemRoutes.get("/redeem/check/:code", async (c) => {
  const rawCode = c.req.param("code");
  const trimmedCode = normalizeRedeemCode(rawCode);
  if (!trimmedCode) {
    throw new HTTPException(400, { message: "Redeem code is required" });
  }

  const payload = await withConnection(c.env, async (connection) => {
    const validation = await validateRedeemCode(connection, trimmedCode);

    if (!validation.valid) {
      return {
        success: false,
        valid: false,
        message: validation.reason || "Invalid redeem code",
      };
    }

    const redeemCodeData = validation.data!;
    const responseData: Record<string, unknown> = {
      rewardType: redeemCodeData.reward_type,
      usage: {
        current: redeemCodeData.current_uses,
        max: redeemCodeData.max_uses,
        remaining: remainingUses(redeemCodeData),
      },
      expiresAt: redeemCodeData.expires_at,
    };

    if (redeemCodeData.membership_type && redeemCodeData.duration_days) {
      responseData.membership = {
        type: redeemCodeData.membership_type,
        durationDays: redeemCodeData.duration_days,
      };
    }

    if (redeemCodeData.credits_amount) {
      responseData.credits = { amount: redeemCodeData.credits_amount };
    }

    if (redeemCodeData.download_points_amount) {
      responseData.downloadPoints = { amount: redeemCodeData.download_points_amount };
    }

    return {
      success: true,
      valid: true,
      data: responseData,
    };
  });

  return c.json(payload);
});

redeemRoutes.get("/redeem/history", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));

  const data = await withConnection(c.env, async (connection) => {
    return getUserRedeemHistory(connection, session.user.id);
  });

  return c.json({
    success: true,
    data,
    timestamp: new Date().toISOString(),
  });
});

redeemRoutes.get("/redeem/stats", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));

  const data = await withConnection(c.env, async (connection) => {
    return getRedeemStats(connection);
  });

  return c.json({
    success: true,
    data,
    timestamp: new Date().toISOString(),
  });
});

redeemRoutes.get("/redeem/usage/:code", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const trimmedCode = normalizeRedeemCode(c.req.param("code"));
  if (!trimmedCode) {
    throw new HTTPException(400, { message: "Redeem code is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const redeemCode = await findRedeemCode(connection, trimmedCode);
    if (!redeemCode) {
      throw new HTTPException(404, { message: "Redeem code not found" });
    }
    return getRedeemCodeUsageHistory(connection, trimmedCode);
  });

  return c.json({
    success: true,
    data,
    timestamp: new Date().toISOString(),
  });
});
