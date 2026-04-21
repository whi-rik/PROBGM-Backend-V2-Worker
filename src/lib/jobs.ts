import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { hydrateAssets } from "./assets";
import { queryRows, type DbConnection, withConnection } from "./db";
import { executeBillingWithToss } from "./toss";
import { deleteTypesenseDocument, importTypesenseDocuments, searchTypesenseDocuments } from "./typesense";
import { MembershipTier, applyMembershipByOrderName, getMembershipCredits, getMembershipDownloadPoints, parsePlanFromOrderName } from "./membership";

interface PendingGrantRow extends RowDataPacket {
  id: number;
  user_id: string;
  payment_id: number;
  order_name: string;
  grant_type: "membership" | "credits" | "both";
  status: "pending" | "completed" | "failed";
  retry_count: number;
  max_retries: number;
}

interface AssetIdRow extends RowDataPacket {
  id: string;
}

interface CountRow extends RowDataPacket {
  count: number;
}

interface MembershipUserRow extends RowDataPacket {
  user: string;
  tier?: number;
}

interface BalanceRow extends RowDataPacket {
  balance: number;
  bonus_credits?: number | null;
  bonus_credits_expires_at?: Date | string | null;
}

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
}

interface PaymentRow extends RowDataPacket {
  id: number;
  order_id: string;
  order_name: string;
  user_id: string;
  payment_key: string | null;
  billing_key: string | null;
  customer_key: string | null;
  amount: number;
  currency: string | null;
  method: string | null;
  status: string | null;
  toss_payment_data: string | null;
  created_by: string;
}

const BILLING_RETRY_DELAYS_HOURS = [1, 6, 24, 48, 72];

async function ensureUserBalanceRow(connection: DbConnection, userId: string) {
  const rows = await queryRows<RowDataPacket & { user: string }>(
    connection,
    "SELECT user FROM users_balance WHERE user = ? LIMIT 1",
    [userId],
  );

  if (!rows[0]) {
    try {
      await queryRows(
        connection,
        `INSERT INTO users_balance
         (user, balance, download_point, bonus_credits, bonus_download_points)
         VALUES (?, 20, 3, 0, 0)`,
        [userId],
      );
    } catch {
      await queryRows(
        connection,
        `INSERT INTO users_balance (user, balance, download_point)
         VALUES (?, 20, 3)`,
        [userId],
      );
    }
  }
}

async function applyCreditsOnlyGrant(connection: DbConnection, userId: string, orderName: string) {
  const plan = parsePlanFromOrderName(orderName);
  if (!plan) {
    throw new HTTPException(400, { message: "Unable to parse plan from order name" });
  }

  await ensureUserBalanceRow(connection, userId);
  await queryRows(
    connection,
    `UPDATE users_balance
     SET balance = ?, download_point = ?
     WHERE user = ?`,
    [getMembershipCredits(plan.tier), getMembershipDownloadPoints(plan.tier), userId],
  );
}

export async function processPendingGrants(connection: DbConnection) {
  const rows = await queryRows<PendingGrantRow>(
    connection,
    `SELECT *
     FROM pending_membership_grants
     WHERE status IN ('pending', 'failed')
       AND retry_count < max_retries
     ORDER BY created_at ASC`,
  ).catch(() => []);

  let completed = 0;
  let failed = 0;
  const errors: Array<{ id: number; error: string }> = [];

  for (const grant of rows) {
    try {
      if (grant.grant_type === "membership" || grant.grant_type === "both") {
        await applyMembershipByOrderName(connection, grant.user_id, grant.order_name);
      } else if (grant.grant_type === "credits") {
        await applyCreditsOnlyGrant(connection, grant.user_id, grant.order_name);
      }

      await queryRows(
        connection,
        `UPDATE pending_membership_grants
         SET status = 'completed',
             completed_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [grant.id],
      );
      completed += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Grant retry failed";
      await queryRows(
        connection,
        `UPDATE pending_membership_grants
         SET retry_count = retry_count + 1,
             error_message = ?,
             status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE status END
         WHERE id = ?`,
        [message, grant.id],
      );
      failed += 1;
      errors.push({ id: grant.id, error: message });
    }
  }

  return {
    total: rows.length,
    completed,
    failed,
    errors,
  };
}

function toTypesenseDocument(asset: Awaited<ReturnType<typeof hydrateAssets>>[number]) {
  const metadataMap = new Map(asset.metadata.map((entry) => [entry.type, entry.content]));
  const createdIn =
    asset.created_in instanceof Date
      ? Math.floor(asset.created_in.getTime() / 1000)
      : Math.floor(new Date(asset.created_in).getTime() / 1000);

  return {
    id: asset.id,
    title: metadataMap.get("title") || "",
    tags: [
      ...asset.keywords.genre,
      ...asset.keywords.mood,
      ...asset.keywords.instrument,
      ...asset.keywords.scene,
    ],
    tags_genre: asset.keywords.genre,
    tags_mood: asset.keywords.mood,
    tags_instrument: asset.keywords.instrument,
    tags_scene: asset.keywords.scene,
    created_in: createdIn,
    metadata_title: metadataMap.get("title") || undefined,
    metadata_subtitle: metadataMap.get("subtitle") || undefined,
    metadata_description: metadataMap.get("description") || undefined,
    metadata_duration: Number(metadataMap.get("duration") || 0),
    metadata_bitrate: Number(metadataMap.get("bitrate") || 0),
    metadata_samplerate: Number(metadataMap.get("samplerate") || 0),
    metadata_arranger: metadataMap.get("arranger") || undefined,
    metadata_artist: metadataMap.get("artist") || undefined,
    metadata_composer: metadataMap.get("composer") || undefined,
    metadata_bpm: metadataMap.get("bpm") || undefined,
    metadata_comment: metadataMap.get("comment") || undefined,
    metadata_prompt: metadataMap.get("prompt") || undefined,
  };
}

async function listVisibleAssetIds(connection: DbConnection) {
  const rows = await queryRows<AssetIdRow>(
    connection,
    "SELECT id FROM musics WHERE is_hide = 0 ORDER BY created_in DESC",
  );
  return rows.map((row) => row.id);
}

async function loadTypesenseIds(env: Bindings) {
  const ids: string[] = [];
  let page = 1;
  const perPage = 250;

  while (true) {
    const response = await searchTypesenseDocuments<{ id: string }>(env, {
      q: "*",
      query_by: "title",
      per_page: perPage,
      page,
      include_fields: "id",
    });

    const hits = response.hits || [];
    ids.push(...hits.map((hit) => hit.document.id));
    if (hits.length < perPage) {
      break;
    }
    page += 1;
  }

  return ids;
}

export async function fixTypesenseConsistency(env: Bindings, connection: DbConnection) {
  const [dbCountRows, dbIds, typesenseIds] = await Promise.all([
    queryRows<CountRow>(
      connection,
      "SELECT COUNT(*) AS count FROM musics WHERE is_hide = 0",
    ),
    listVisibleAssetIds(connection),
    loadTypesenseIds(env),
  ]);

  const dbIdSet = new Set(dbIds);
  const typesenseIdSet = new Set(typesenseIds);
  const missing = dbIds.filter((id) => !typesenseIdSet.has(id));
  const orphaned = typesenseIds.filter((id) => !dbIdSet.has(id));

  let removed = 0;
  for (const id of orphaned.slice(0, 1000)) {
    const result = await deleteTypesenseDocument(env, id);
    if (result.found) {
      removed += 1;
    }
  }

  const assets = await hydrateAssets(connection, missing.slice(0, 1000));
  const importResults =
    assets.length > 0 ? await importTypesenseDocuments(env, assets.map(toTypesenseDocument), "upsert") : [];

  return {
    checked: {
      db_count: dbCountRows[0]?.count || 0,
      typesense_count: typesenseIds.length,
      missing_count: missing.length,
      orphaned_count: orphaned.length,
    },
    removed_orphaned_count: removed,
    indexed_missing_count: importResults.filter((row) => row.success !== false).length,
    failed_index_count: importResults.filter((row) => row.success === false).length,
    note: "Manual job trigger uses bounded batches to stay safe in Worker runtime.",
  };
}

function addMonths(date: Date, months: number) {
  const next = new Date(date);
  next.setMonth(next.getMonth() + months);
  return next;
}

async function readBalanceForRenewal(connection: DbConnection, userId: string) {
  try {
    const rows = await queryRows<BalanceRow>(
      connection,
      `SELECT balance, bonus_credits, bonus_credits_expires_at
       FROM users_balance
       WHERE user = ?
       LIMIT 1`,
      [userId],
    );
    return rows[0] || null;
  } catch {
    const fallbackRows = await queryRows<BalanceRow>(
      connection,
      `SELECT balance
       FROM users_balance
       WHERE user = ?
       LIMIT 1`,
      [userId],
    );
    return fallbackRows[0] || null;
  }
}

async function resetMembershipCredits(
  connection: DbConnection,
  userId: string,
  tier: MembershipTier,
  expiryMonths = 1,
) {
  await ensureUserBalanceRow(connection, userId);
  const balance = await readBalanceForRenewal(connection, userId);
  if (!balance) {
    throw new HTTPException(404, { message: "User balance not found" });
  }

  const credits = getMembershipCredits(tier);
  const downloadPoints = getMembershipDownloadPoints(tier);
  const expiresAt = addMonths(new Date(), expiryMonths);
  const prevBalance = Number(balance.balance || 0);

  try {
    await queryRows(
      connection,
      `UPDATE users_balance
       SET balance = ?,
           download_point = ?,
           credit_expires_at = ?,
           last_credit_reset_at = CURRENT_TIMESTAMP,
           last_download_point_reset_at = CURRENT_TIMESTAMP
       WHERE user = ?`,
      [credits, downloadPoints, expiresAt, userId],
    );
  } catch {
    await queryRows(
      connection,
      `UPDATE users_balance
       SET balance = ?,
           download_point = ?
       WHERE user = ?`,
      [credits, downloadPoints, userId],
    );
  }

  try {
    const subject = `${MembershipTier[tier]} membership renewal`;
    await queryRows(
      connection,
      `INSERT INTO users_transaction
       (id, operated_by, user, subject, change_amount, balance, datetime)
       VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
      [
        crypto.randomUUID(),
        "system",
        userId,
        subject,
        credits - prevBalance,
        credits,
      ],
    );
  } catch {
    // Optional audit table parity. Do not fail renewal on missing transaction table.
  }

  return {
    userId,
    tier,
    previousBalance: prevBalance,
    newBalance: credits,
    downloadPoints,
    expiresAt: expiresAt.toISOString(),
  };
}

export async function processMonthlyCreditRenewal(connection: DbConnection) {
  const freeUsers = await queryRows<MembershipUserRow>(
    connection,
    `SELECT DISTINCT user
     FROM users_membership
     WHERE tier = ? AND is_active = 1`,
    [MembershipTier.FREE],
  ).catch(() => []);

  const paidUsers = await queryRows<MembershipUserRow>(
    connection,
    `SELECT um.user, um.tier
     FROM users_membership um
     WHERE um.is_active = 1
       AND um.tier > ?
       AND um.user NOT IN (
         SELECT DISTINCT user_id
         FROM billing_cycles
         WHERE status = 'ACTIVE'
       )`,
    [MembershipTier.FREE],
  ).catch(() => []);

  const free = {
    total: freeUsers.length,
    successful: 0,
    failed: 0,
    errors: [] as Array<{ userId: string; error: string }>,
  };
  const paid = {
    total: paidUsers.length,
    successful: 0,
    failed: 0,
    errors: [] as Array<{ userId: string; error: string }>,
  };

  for (const row of freeUsers) {
    try {
      await resetMembershipCredits(connection, row.user, MembershipTier.FREE, 1);
      free.successful += 1;
    } catch (error) {
      free.failed += 1;
      free.errors.push({
        userId: row.user,
        error: error instanceof Error ? error.message : "Monthly FREE renewal failed",
      });
    }
  }

  for (const row of paidUsers) {
    try {
      const tier = Number(row.tier ?? MembershipTier.FREE) as MembershipTier;
      await resetMembershipCredits(connection, row.user, tier, 1);
      paid.successful += 1;
    } catch (error) {
      paid.failed += 1;
      paid.errors.push({
        userId: row.user,
        error: error instanceof Error ? error.message : "Monthly paid renewal failed",
      });
    }
  }

  return { free, paid, processedAt: new Date().toISOString() };
}

export async function expireMembershipCredits(connection: DbConnection) {
  try {
    const rows = await queryRows<RowDataPacket & { changed?: number; count?: number }>(
      connection,
      `UPDATE users_balance
       SET balance = 0, download_point = 0
       WHERE credit_expires_at IS NOT NULL
         AND credit_expires_at < CURRENT_TIMESTAMP
         AND balance > 0`,
    );
    return {
      expiredCount: rows[0]?.changed || rows[0]?.count || 0,
      processedAt: new Date().toISOString(),
    };
  } catch {
    const before = await queryRows<CountRow>(
      connection,
      `SELECT COUNT(*) AS count
       FROM users_balance
       WHERE credit_expires_at IS NOT NULL
         AND credit_expires_at < CURRENT_TIMESTAMP
         AND balance > 0`,
    ).catch(() => []);
    await queryRows(
      connection,
      `UPDATE users_balance
       SET balance = 0, download_point = 0
       WHERE credit_expires_at IS NOT NULL
         AND credit_expires_at < CURRENT_TIMESTAMP
         AND balance > 0`,
    ).catch(() => []);
    return {
      expiredCount: before[0]?.count || 0,
      processedAt: new Date().toISOString(),
    };
  }
}

function parseCustomerInfo(value: string | null) {
  if (!value) {
    return {};
  }
  try {
    const payload = JSON.parse(value) as { customer?: { email?: string; name?: string } };
    return {
      customerEmail: payload.customer?.email || null,
      customerName: payload.customer?.name || null,
    };
  } catch {
    return {};
  }
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

function getRetryDelayHours(retryCount: number) {
  return BILLING_RETRY_DELAYS_HOURS[retryCount] || BILLING_RETRY_DELAYS_HOURS[BILLING_RETRY_DELAYS_HOURS.length - 1];
}

function parseDate(value: Date | string | null) {
  if (!value) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function shouldRetryNow(cycle: BillingCycleRow, now: Date) {
  if (cycle.retry_count <= 0 || cycle.retry_count >= cycle.max_retries) {
    return false;
  }
  const lastRetry = parseDate(cycle.last_retry_date);
  if (!lastRetry) {
    return true;
  }
  const nextRetryAt = new Date(lastRetry);
  nextRetryAt.setHours(nextRetryAt.getHours() + getRetryDelayHours(Math.max(cycle.retry_count - 1, 0)));
  return nextRetryAt <= now;
}

async function processSingleBillingCycle(env: Bindings, connection: DbConnection, cycle: BillingCycleRow) {
  const paymentRows = await queryRows<PaymentRow>(
    connection,
    `SELECT *
     FROM payments
     WHERE id = ?
     LIMIT 1`,
    [cycle.payment_id],
  );
  const originalPayment = paymentRows[0];
  if (!originalPayment) {
    throw new HTTPException(404, { message: `Original payment not found for billing cycle ${cycle.id}` });
  }

  const orderName = originalPayment.order_name || `Recurring Payment - ${cycle.cycle_type}`;
  const orderId = `billing_${cycle.id}_${Date.now()}`;
  const customer = parseCustomerInfo(originalPayment.toss_payment_data);

  const tossPayment = await executeBillingWithToss(env, cycle.billing_key, {
    customerKey: cycle.customer_key,
    amount: cycle.amount,
    orderId,
    orderName,
    customerEmail: customer.customerEmail || null,
    customerName: customer.customerName || null,
  });

  await queryRows(
    connection,
    `INSERT INTO payments
     (payment_key, order_id, order_name, user_id, customer_key, billing_key, amount, currency, method, status, toss_payment_data, is_billing, billing_cycle, next_billing_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    [
      tossPayment.paymentKey,
      tossPayment.orderId,
      tossPayment.orderName,
      originalPayment.user_id,
      cycle.customer_key,
      cycle.billing_key,
      tossPayment.totalAmount,
      tossPayment.currency || cycle.currency || "KRW",
      tossPayment.method || "CARD",
      tossPayment.status || "DONE",
      JSON.stringify(tossPayment),
      cycle.cycle_type,
      calculateNextBillingDate(cycle.cycle_type, cycle.billing_day, new Date()),
      originalPayment.created_by,
    ],
  );

  if ((tossPayment.status || "DONE") === "DONE") {
    await applyMembershipByOrderName(connection, originalPayment.user_id, orderName);
    await queryRows(
      connection,
      `UPDATE billing_cycles
       SET last_billing_date = CURRENT_TIMESTAMP,
           next_billing_date = ?,
           retry_count = 0,
           last_retry_date = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [calculateNextBillingDate(cycle.cycle_type, cycle.billing_day, new Date()), cycle.id],
    );
  } else {
    await queryRows(
      connection,
      `UPDATE billing_cycles
       SET retry_count = retry_count + 1,
           last_retry_date = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [cycle.id],
    );
  }

  return {
    billingCycleId: cycle.id,
    paymentKey: tossPayment.paymentKey,
    status: tossPayment.status || "DONE",
  };
}

export async function processDueBillingCycles(env: Bindings, connection: DbConnection) {
  const cycles = await queryRows<BillingCycleRow>(
    connection,
    `SELECT *
     FROM billing_cycles
     WHERE status = 'ACTIVE'
       AND next_billing_date IS NOT NULL
       AND next_billing_date <= CURRENT_TIMESTAMP
     ORDER BY next_billing_date ASC
     LIMIT 100`,
  ).catch(() => []);

  const results = {
    processed: cycles.length,
    successful: 0,
    failed: 0,
    errors: [] as Array<{ billingCycleId: number; error: string }>,
  };

  for (const cycle of cycles) {
    try {
      await processSingleBillingCycle(env, connection, cycle);
      results.successful += 1;
    } catch (error) {
      await queryRows(
        connection,
        `UPDATE billing_cycles
         SET retry_count = retry_count + 1,
             last_retry_date = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [cycle.id],
      ).catch(() => {});
      results.failed += 1;
      results.errors.push({
        billingCycleId: cycle.id,
        error: error instanceof Error ? error.message : "Scheduled billing failed",
      });
    }
  }

  return results;
}

export async function processRetryBillingCycles(env: Bindings, connection: DbConnection) {
  const now = new Date();
  const cycles = await queryRows<BillingCycleRow>(
    connection,
    `SELECT *
     FROM billing_cycles
     WHERE status = 'ACTIVE'
       AND retry_count > 0
       AND retry_count < max_retries
     ORDER BY last_retry_date ASC
     LIMIT 100`,
  ).catch(() => []);

  const retryable = cycles.filter((cycle) => shouldRetryNow(cycle, now));
  const results = {
    processed: retryable.length,
    successful: 0,
    failed: 0,
    errors: [] as Array<{ billingCycleId: number; error: string }>,
  };

  for (const cycle of retryable) {
    try {
      await processSingleBillingCycle(env, connection, cycle);
      results.successful += 1;
    } catch (error) {
      await queryRows(
        connection,
        `UPDATE billing_cycles
         SET retry_count = retry_count + 1,
             last_retry_date = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [cycle.id],
      ).catch(() => {});
      results.failed += 1;
      results.errors.push({
        billingCycleId: cycle.id,
        error: error instanceof Error ? error.message : "Retry billing failed",
      });
    }
  }

  return results;
}

export const WORKER_CRON_SCHEDULES = {
  pendingGrants: "*/5 * * * *",
  typesenseConsistency: "15 2 * * *",
  creditRenewalMonthly: "0 0 1 * *",
  creditExpirationDaily: "0 1 * * *",
  billingDue: "*/10 * * * *",
  billingRetries: "0 * * * *",
} as const;

export async function runScheduledJob(env: Bindings, cron: string) {
  if (cron === WORKER_CRON_SCHEDULES.pendingGrants) {
    return withConnection(env, (connection) => processPendingGrants(connection));
  }
  if (cron === WORKER_CRON_SCHEDULES.typesenseConsistency) {
    return withConnection(env, (connection) => fixTypesenseConsistency(env, connection));
  }
  if (cron === WORKER_CRON_SCHEDULES.creditRenewalMonthly) {
    return withConnection(env, (connection) => processMonthlyCreditRenewal(connection));
  }
  if (cron === WORKER_CRON_SCHEDULES.creditExpirationDaily) {
    return withConnection(env, (connection) => expireMembershipCredits(connection));
  }
  if (cron === WORKER_CRON_SCHEDULES.billingDue) {
    return withConnection(env, (connection) => processDueBillingCycles(env, connection));
  }
  if (cron === WORKER_CRON_SCHEDULES.billingRetries) {
    return withConnection(env, (connection) => processRetryBillingCycles(env, connection));
  }

  return {
    skipped: true,
    cron,
    reason: "No scheduled job mapped for this cron expression",
  };
}
