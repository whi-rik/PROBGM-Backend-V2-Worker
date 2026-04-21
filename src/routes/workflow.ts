import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { isAdminUserId, requireAdminSessionFromRequest } from "../lib/admin";
import { requireSessionFromRequest } from "../lib/auth";
import { queryRows, type DbConnection, withConnection } from "../lib/db";
import { success } from "../lib/response";

interface CountRow extends RowDataPacket {
  count: number;
}

interface TailoredRequestRow extends RowDataPacket {
  id: string;
  user_id: string;
  job_id: string | null;
  external_job_id: string | null;
  status: string | null;
  title: string | null;
  price: number | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  estimated_at: Date | string | null;
  processed_at: Date | string | null;
  completed_at: Date | string | null;
  confirmed_at: Date | string | null;
}

interface WorkflowEventRow extends RowDataPacket {
  id: string;
  event_type: string;
  job_id: string;
  user_id: string | null;
  from_status: string | null;
  to_status: string | null;
  operation_duration: number | null;
  success: number | boolean;
  error_message: string | null;
  metadata: string | null;
  created_at: Date | string | null;
}

function parsePositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function getWorkflowMonitoringTableName(env: Bindings) {
  const table = (env.WORKFLOW_MONITORING_TABLE || "workflow_monitoring_events").trim();
  if (!/^[A-Za-z0-9_]+$/.test(table)) {
    throw new HTTPException(500, { message: "WORKFLOW_MONITORING_TABLE contains invalid characters" });
  }
  return table;
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

function mapWorkflowEvent(row: WorkflowEventRow) {
  return {
    ...row,
    success: Boolean(row.success),
    metadata: parseJsonField<Record<string, unknown>>(row.metadata),
  };
}

async function getTailoredRequestById(connection: DbConnection, idOrJobId: string) {
  const rows = await queryRows<TailoredRequestRow>(
    connection,
    `SELECT *
     FROM tailored_requests
     WHERE id = ? OR job_id = ?
     LIMIT 1`,
    [idOrJobId, idOrJobId],
  ).catch(() => []);
  return rows[0] || null;
}

export const workflowRoutes = new Hono<{ Bindings: Bindings }>();

workflowRoutes.get("/workflow/health", async (c) => {
  const monitoringTable = getWorkflowMonitoringTableName(c.env);
  const data = await withConnection(c.env, async (connection) => {
    const [tailoredRows, activeRows, failedRows, eventRows] = await Promise.all([
      queryRows<CountRow>(connection, "SELECT COUNT(*) AS count FROM tailored_requests").catch(() => [{ count: 0 }] as CountRow[]),
      queryRows<CountRow>(
        connection,
        "SELECT COUNT(*) AS count FROM tailored_requests WHERE status IN ('pending', 'estimated', 'processing', 'confirming')",
      ).catch(() => [{ count: 0 }] as CountRow[]),
      queryRows<CountRow>(
        connection,
        "SELECT COUNT(*) AS count FROM tailored_requests WHERE status = 'failed'",
      ).catch(() => [{ count: 0 }] as CountRow[]),
      queryRows<CountRow>(connection, `SELECT COUNT(*) AS count FROM ${monitoringTable}`).catch(
        () => [{ count: 0 }] as CountRow[],
      ),
    ]);

    return {
      tailored: {
        total: tailoredRows[0]?.count || 0,
        active: activeRows[0]?.count || 0,
        failed: failedRows[0]?.count || 0,
      },
      monitoring: {
        events: eventRows[0]?.count || 0,
      },
      externalApi: {
        configured: Boolean(c.env.TAILORED_EXTERNAL_API_URL),
        hasApiKey: Boolean(c.env.TAILORED_EXTERNAL_API_KEY),
      },
      mode: "worker-observability",
      timestamp: new Date().toISOString(),
    };
  });

  return c.json(success(data, "Workflow health retrieved"));
});

workflowRoutes.get("/workflow/dashboard", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const monitoringTable = getWorkflowMonitoringTableName(c.env);

  const data = await withConnection(c.env, async (connection) => {
    const statusRows = await queryRows<RowDataPacket & { status: string | null; count: number }>(
      connection,
      `SELECT status, COUNT(*) AS count
       FROM tailored_requests
       GROUP BY status`,
    ).catch(() => []);

    const recentRows = await queryRows<WorkflowEventRow>(
      connection,
      `SELECT *
       FROM ${monitoringTable}
       ORDER BY created_at DESC
       LIMIT 20`,
    ).catch(() => []);

    return {
      statusSummary: statusRows,
      recentEvents: recentRows.map(mapWorkflowEvent),
      externalApiConfigured: Boolean(c.env.TAILORED_EXTERNAL_API_URL),
      timestamp: new Date().toISOString(),
    };
  });

  return c.json(success(data, "Workflow dashboard retrieved"));
});

workflowRoutes.get("/workflow/logs", async (c) => {
  await requireAdminSessionFromRequest(c.env, c.req.header("Authorization"));
  const monitoringTable = getWorkflowMonitoringTableName(c.env);
  const page = parsePositiveInt(c.req.query("page") || null, 1, 500);
  const limit = parsePositiveInt(c.req.query("limit") || null, 20, 100);
  const offset = (page - 1) * limit;

  const result = await withConnection(c.env, async (connection) => {
    const countRows = await queryRows<CountRow>(
      connection,
      `SELECT COUNT(*) AS count FROM ${monitoringTable}`,
    ).catch(() => [{ count: 0 }] as CountRow[]);

    const rows = await queryRows<WorkflowEventRow>(
      connection,
      `SELECT *
       FROM ${monitoringTable}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [limit, offset],
    ).catch(() => []);

    return {
      data: rows.map(mapWorkflowEvent),
      pagination: {
        page,
        limit,
        total: countRows[0]?.count || 0,
      },
    };
  });

  return c.json(success(result, "Workflow logs retrieved"));
});

workflowRoutes.get("/jobs/:id/workflow-status", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const jobId = c.req.param("id");
  if (!jobId) {
    throw new HTTPException(400, { message: "Job ID is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const job = await getTailoredRequestById(connection, jobId);
    if (!job) {
      throw new HTTPException(404, { message: "Job not found" });
    }
    if (job.user_id !== session.user.id && !isAdminUserId(c.env, session.user.id)) {
      throw new HTTPException(403, { message: "Not authorized to view this job" });
    }

    return {
      job_id: job.job_id || job.id,
      external_job_id: job.external_job_id,
      current_status: job.status || "pending",
      compensation_amount: job.price || 0,
      can_pay: (job.status || "") === "estimated",
      payment_required_credits: job.price || 0,
      created_at: job.created_at,
      updated_at: job.updated_at,
      estimated_at: job.estimated_at,
      processed_at: job.processed_at,
      completed_at: job.completed_at,
      confirmed_at: job.confirmed_at,
    };
  });

  return c.json(success(data, "Workflow status retrieved"));
});

workflowRoutes.get("/jobs/:id/workflow-history", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const monitoringTable = getWorkflowMonitoringTableName(c.env);
  const jobId = c.req.param("id");
  if (!jobId) {
    throw new HTTPException(400, { message: "Job ID is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const job = await getTailoredRequestById(connection, jobId);
    if (!job) {
      throw new HTTPException(404, { message: "Job not found" });
    }
    if (job.user_id !== session.user.id && !isAdminUserId(c.env, session.user.id)) {
      throw new HTTPException(403, { message: "Not authorized to view this job" });
    }

    const rows = await queryRows<WorkflowEventRow>(
      connection,
      `SELECT *
       FROM ${monitoringTable}
       WHERE job_id = ?
       ORDER BY created_at DESC`,
      [job.job_id || job.id],
    ).catch(() => []);

    return {
      job_id: job.job_id || job.id,
      history: rows.map(mapWorkflowEvent),
    };
  });

  return c.json(success(data, "Workflow history retrieved"));
});
