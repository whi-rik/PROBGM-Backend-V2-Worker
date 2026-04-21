import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { requireAdminSessionFromRequest } from "../lib/admin";
import {
  applyMembershipByOrderName,
  getMembershipCredits,
  getMembershipDownloadPoints,
  parsePlanFromOrderName,
} from "../lib/membership";
import { queryRows, withConnection, type DbConnection } from "../lib/db";
import { success } from "../lib/response";

interface LabelRow extends RowDataPacket {
  id: string;
  name: string;
  name_en: string | null;
  logo_url: string | null;
  logo_tailwind: string | null;
  tailwind_classes: string | null;
  background_tailwind: string | null;
  css_code: string | null;
  description: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
}

interface LabelStatsRow extends RowDataPacket {
  total_labels: number;
  active_assignments: number;
  expired_assignments: number;
}

interface CountRow extends RowDataPacket {
  count: number;
}

interface PendingGrantRow extends RowDataPacket {
  id: number;
  user_id: string;
  payment_id: number;
  order_name: string;
  grant_type: "membership" | "credits" | "both";
  status: "pending" | "completed" | "failed";
  retry_count: number;
  max_retries: number;
  error_message: string | null;
  created_at: Date | string | null;
  completed_at: Date | string | null;
}

function normalizeString(value: unknown, maxLength: number) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

async function ensureUserBalanceRow(connection: DbConnection, userId: string) {
  const rows = await queryRows<RowDataPacket & { user: string }>(
    connection,
    "SELECT user FROM users_balance WHERE user = ? LIMIT 1",
    [userId],
  );

  if (!rows[0]) {
    await queryRows(
      connection,
      `INSERT INTO users_balance (user, balance, download_point)
       VALUES (?, 20, 3)`,
      [userId],
    );
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

async function listLabels(connection: DbConnection) {
  return queryRows<LabelRow>(connection, "SELECT * FROM labels ORDER BY name");
}

async function getLabelById(connection: DbConnection, id: string) {
  const rows = await queryRows<LabelRow>(
    connection,
    "SELECT * FROM labels WHERE id = ? LIMIT 1",
    [id],
  );
  return rows[0] || null;
}

export const v2AdminRoutes = new Hono<{ Bindings: Bindings }>();

v2AdminRoutes.get("/admin/labels/stats", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));

  const data = await withConnection(c.env, async (connection) => {
    const [statsRows, usageRows] = await Promise.all([
      queryRows<LabelStatsRow>(
        connection,
        `SELECT
            COUNT(*) AS total_labels,
            (SELECT COUNT(*) FROM users_labels WHERE is_expired = 0 AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)) AS active_assignments,
            (SELECT COUNT(*) FROM users_labels WHERE is_expired = 1 OR (expires_at IS NOT NULL AND expires_at <= CURRENT_TIMESTAMP)) AS expired_assignments
         FROM labels`,
      ),
      queryRows<RowDataPacket & { label_id: string; usage_count: number }>(
        connection,
        `SELECT org_id AS label_id, COUNT(*) AS usage_count
         FROM users_labels
         GROUP BY org_id
         ORDER BY usage_count DESC`,
      ).catch(() => []),
    ]);

    const stats = statsRows[0];
    return {
      total: stats?.total_labels || 0,
      activeAssignments: stats?.active_assignments || 0,
      expiredAssignments: stats?.expired_assignments || 0,
      usageByLabel: usageRows,
    };
  });

  return c.json(success(data, "Label stats retrieved"));
});

v2AdminRoutes.get("/admin/labels", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const data = await withConnection(c.env, listLabels);
  return c.json(success(data, "Labels retrieved"));
});

v2AdminRoutes.post("/admin/labels", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = ((await c.req.json().catch(() => ({}))) || {}) as Record<string, unknown>;
  const id = normalizeString(body.id, 100);
  const name = normalizeString(body.name, 255);

  if (!id) {
    throw new HTTPException(400, { message: "id is required" });
  }
  if (!name) {
    throw new HTTPException(400, { message: "name is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const existing = await getLabelById(connection, id);
    if (existing) {
      throw new HTTPException(400, { message: `Label with id "${id}" already exists` });
    }

    await queryRows(
      connection,
      `INSERT INTO labels
       (id, name, name_en, logo_url, logo_tailwind, tailwind_classes, background_tailwind, css_code, description)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        typeof body.name_en === "string" ? body.name_en.trim() : null,
        typeof body.logo_url === "string" ? body.logo_url.trim() : null,
        typeof body.logo_tailwind === "string" ? body.logo_tailwind.trim() : null,
        typeof body.tailwind_classes === "string" ? body.tailwind_classes.trim() : null,
        typeof body.background_tailwind === "string" ? body.background_tailwind.trim() : null,
        typeof body.css_code === "string" ? body.css_code : null,
        typeof body.description === "string" ? body.description.trim() : null,
      ],
    );

    const created = await getLabelById(connection, id);
    if (!created) {
      throw new HTTPException(500, { message: "Failed to create label" });
    }
    return created;
  });

  return c.json(success(data, "Label created"), 201);
});

v2AdminRoutes.put("/admin/labels/:id", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = c.req.param("id");
  const body = ((await c.req.json().catch(() => ({}))) || {}) as Record<string, unknown>;

  const updates: string[] = [];
  const values: Array<string | null> = [];
  const fieldMap: Array<[string, string]> = [
    ["name", "name"],
    ["name_en", "name_en"],
    ["logo_url", "logo_url"],
    ["logo_tailwind", "logo_tailwind"],
    ["tailwind_classes", "tailwind_classes"],
    ["background_tailwind", "background_tailwind"],
    ["css_code", "css_code"],
    ["description", "description"],
  ];

  for (const [bodyKey, column] of fieldMap) {
    if (body[bodyKey] !== undefined) {
      updates.push(`${column} = ?`);
      values.push(typeof body[bodyKey] === "string" ? String(body[bodyKey]).trim() : null);
    }
  }

  if (updates.length === 0) {
    throw new HTTPException(400, { message: "No fields to update" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const existing = await getLabelById(connection, id);
    if (!existing) {
      throw new HTTPException(404, { message: `Label with id "${id}" not found` });
    }

    await queryRows(
      connection,
      `UPDATE labels SET ${updates.join(", ")} WHERE id = ?`,
      [...values, id],
    );

    const updated = await getLabelById(connection, id);
    if (!updated) {
      throw new HTTPException(500, { message: "Failed to update label" });
    }
    return updated;
  });

  return c.json(success(data, "Label updated"));
});

v2AdminRoutes.delete("/admin/labels/:id", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = c.req.param("id");

  await withConnection(c.env, async (connection) => {
    const existing = await getLabelById(connection, id);
    if (!existing) {
      throw new HTTPException(404, { message: `Label with id "${id}" not found` });
    }

    await queryRows(connection, "DELETE FROM labels WHERE id = ?", [id]);
  });

  return c.json(success(null, "Label deleted successfully"));
});

v2AdminRoutes.get("/admin/grants/pending", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));

  const data = await withConnection(c.env, async (connection) => {
    const rows = await queryRows<PendingGrantRow>(
      connection,
      `SELECT *
       FROM pending_membership_grants
       WHERE status IN ('pending', 'failed')
       ORDER BY created_at ASC`,
    ).catch(() => []);

    return {
      items: rows,
      total: rows.length,
    };
  });

  return c.json(success(data, "Pending grants retrieved"));
});

v2AdminRoutes.post("/admin/grants/:id/retry", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = Number.parseInt(c.req.param("id"), 10);
  if (!Number.isFinite(id)) {
    throw new HTTPException(400, { message: "Invalid grant ID" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const rows = await queryRows<PendingGrantRow>(
      connection,
      "SELECT * FROM pending_membership_grants WHERE id = ? LIMIT 1",
      [id],
    ).catch(() => []);

    const grant = rows[0];
    if (!grant) {
      throw new HTTPException(404, { message: `Grant with ID ${id} not found` });
    }

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
        [id],
      );

      return { id, status: "completed" };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Grant retry failed";
      await queryRows(
        connection,
        `UPDATE pending_membership_grants
         SET retry_count = retry_count + 1,
             error_message = ?,
             status = CASE WHEN retry_count + 1 >= max_retries THEN 'failed' ELSE status END
         WHERE id = ?`,
        [message, id],
      );
      throw new HTTPException(500, { message });
    }
  });

  return c.json(success(data, "Grant retried successfully"));
});

v2AdminRoutes.post("/admin/grants/retry-all", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));

  const data = await withConnection(c.env, async (connection) => {
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
      }
    }

    return {
      total: rows.length,
      completed,
      failed,
    };
  });

  return c.json(success(data, "Pending grants processed"));
});
