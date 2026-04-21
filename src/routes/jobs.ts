import { Hono } from "hono";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { requireAdminSessionFromRequest } from "../lib/admin";
import {
  WORKER_CRON_SCHEDULES,
  expireMembershipCredits,
  fixTypesenseConsistency,
  processDueBillingCycles,
  processMonthlyCreditRenewal,
  processPendingGrants,
  processRetryBillingCycles,
} from "../lib/jobs";
import { queryRows, withConnection } from "../lib/db";
import { success } from "../lib/response";

interface CountRow extends RowDataPacket {
  count: number;
}

export const jobRoutes = new Hono<{ Bindings: Bindings }>();

jobRoutes.get("/admin/jobs/status", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));

  const data = await withConnection(c.env, async (connection) => {
    const [pendingGrantRows, pendingVerificationRows, visibleAssetRows, activeBillingRows, retryBillingRows] =
      await Promise.all([
        queryRows<CountRow>(
          connection,
          "SELECT COUNT(*) AS count FROM pending_membership_grants WHERE status IN ('pending', 'failed')",
        ).catch(() => [{ count: 0 }] as CountRow[]),
        queryRows<CountRow>(
          connection,
          `SELECT COUNT(*) AS count
           FROM users_channels
           WHERE is_deleted = 0 AND is_verified = 0 AND verification_url IS NOT NULL`,
        ).catch(() => [{ count: 0 }] as CountRow[]),
        queryRows<CountRow>(
          connection,
          "SELECT COUNT(*) AS count FROM musics WHERE is_hide = 0",
        ).catch(() => [{ count: 0 }] as CountRow[]),
        queryRows<CountRow>(
          connection,
          `SELECT COUNT(*) AS count
           FROM billing_cycles
           WHERE status = 'ACTIVE'
             AND next_billing_date IS NOT NULL
             AND next_billing_date <= CURRENT_TIMESTAMP`,
        ).catch(() => [{ count: 0 }] as CountRow[]),
        queryRows<CountRow>(
          connection,
          `SELECT COUNT(*) AS count
           FROM billing_cycles
           WHERE status = 'ACTIVE'
             AND retry_count > 0
             AND retry_count < max_retries`,
        ).catch(() => [{ count: 0 }] as CountRow[]),
      ]);

    return {
      jobs: [
        {
          id: "pending-grants",
          mode: "manual-and-cron",
          status: "available",
          pending: pendingGrantRows[0]?.count || 0,
          recommendedRuntime: "cron-trigger",
          cron: WORKER_CRON_SCHEDULES.pendingGrants,
        },
        {
          id: "typesense-consistency",
          mode: "manual-and-cron",
          status: "available",
          visibleAssets: visibleAssetRows[0]?.count || 0,
          recommendedRuntime: "cron-trigger",
          cron: WORKER_CRON_SCHEDULES.typesenseConsistency,
        },
        {
          id: "credit-renewal-monthly",
          mode: "manual-and-cron",
          status: "available",
          recommendedRuntime: "cron-trigger",
          cron: WORKER_CRON_SCHEDULES.creditRenewalMonthly,
        },
        {
          id: "credit-expiration-daily",
          mode: "manual-and-cron",
          status: "available",
          recommendedRuntime: "cron-trigger",
          cron: WORKER_CRON_SCHEDULES.creditExpirationDaily,
        },
        {
          id: "billing-due",
          mode: "manual-and-cron",
          status: "available",
          dueCycles: activeBillingRows[0]?.count || 0,
          recommendedRuntime: "cron-trigger",
          cron: WORKER_CRON_SCHEDULES.billingDue,
        },
        {
          id: "billing-retries",
          mode: "manual-and-cron",
          status: "available",
          retryableCycles: retryBillingRows[0]?.count || 0,
          recommendedRuntime: "cron-trigger",
          cron: WORKER_CRON_SCHEDULES.billingRetries,
        },
        {
          id: "tailored-monitoring",
          mode: "planned",
          status: "not_implemented",
          recommendedRuntime: "workflow/queue",
        },
      ],
      queueBacklog: {
        pendingGrants: pendingGrantRows[0]?.count || 0,
        pendingChannelVerifications: pendingVerificationRows[0]?.count || 0,
        dueBillings: activeBillingRows[0]?.count || 0,
        retryableBillings: retryBillingRows[0]?.count || 0,
      },
      timestamp: new Date().toISOString(),
    };
  });

  return c.json(success(data, "Background job status retrieved"));
});

jobRoutes.post("/admin/jobs/run/pending-grants", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, async (connection) => processPendingGrants(connection));
  return c.json(success(data, "Pending grant job executed"));
});

jobRoutes.post("/admin/jobs/run/typesense-consistency", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, async (connection) => fixTypesenseConsistency(c.env, connection));
  return c.json(success(data, "Typesense consistency job executed"));
});

jobRoutes.post("/admin/jobs/run/credit-renewal/monthly", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, async (connection) => processMonthlyCreditRenewal(connection));
  return c.json(success(data, "Monthly credit renewal job executed"));
});

jobRoutes.post("/admin/jobs/run/credit-renewal/expire", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, async (connection) => expireMembershipCredits(connection));
  return c.json(success(data, "Credit expiration job executed"));
});

jobRoutes.post("/admin/jobs/run/billing-due", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, async (connection) => processDueBillingCycles(c.env, connection));
  return c.json(success(data, "Due billing job executed"));
});

jobRoutes.post("/admin/jobs/run/billing-retries", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, async (connection) => processRetryBillingCycles(c.env, connection));
  return c.json(success(data, "Billing retry job executed"));
});
