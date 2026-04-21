import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { RowDataPacket } from "mysql2/promise";
import type { Bindings } from "../env";
import { isAdminUserId } from "../lib/admin";
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
  description: string | null;
  category: string | null;
  price: number | null;
  estimated_duration: string | null;
  requirements: string | null;
  files: string | null;
  result_files: string | null;
  notes: string | null;
  completion_notes: string | null;
  error_message: string | null;
  retry_reason: string | null;
  retry_count: number;
  payment_transaction_id: string | null;
  refund_transaction_id: string | null;
  created_at: Date | string | null;
  updated_at: Date | string | null;
  estimated_at: Date | string | null;
  processed_at: Date | string | null;
  completed_at: Date | string | null;
  confirmed_at: Date | string | null;
}

function parsePositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number(value || fallback);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(1, Math.min(max, Math.floor(parsed)));
}

function parseJsonField<T>(value: string | null): T | null {
  if (!value) return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

function getWorkflowMonitoringTableName(env: Bindings) {
  const table = (env.WORKFLOW_MONITORING_TABLE || "workflow_monitoring_events").trim();
  if (!/^[A-Za-z0-9_]+$/.test(table)) {
    throw new HTTPException(500, { message: "WORKFLOW_MONITORING_TABLE contains invalid characters" });
  }
  return table;
}

function mapTailoredRequest(row: TailoredRequestRow) {
  return {
    ...row,
    requirements: parseJsonField<Record<string, unknown>>(row.requirements),
    files: parseJsonField<unknown[]>(row.files),
    result_files: parseJsonField<unknown[]>(row.result_files),
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

async function appendWorkflowEvent(
  env: Bindings,
  connection: DbConnection,
  input: {
    jobId: string;
    userId: string;
    eventType: "status_transition" | "payment_operation" | "webhook_operation" | "error";
    fromStatus?: string | null;
    toStatus?: string | null;
    success?: boolean;
    errorMessage?: string | null;
    metadata?: Record<string, unknown> | null;
  },
) {
  const table = getWorkflowMonitoringTableName(env);
  await queryRows(
    connection,
    `INSERT INTO ${table}
     (id, event_type, job_id, user_id, from_status, to_status, operation_duration, success, error_message, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      crypto.randomUUID(),
      input.eventType,
      input.jobId,
      input.userId,
      input.fromStatus || null,
      input.toStatus || null,
      null,
      input.success === false ? 0 : 1,
      input.errorMessage || null,
      input.metadata ? JSON.stringify(input.metadata) : null,
    ],
  ).catch(() => {});
}

async function createExternalTailoredJob(env: Bindings, payload: Record<string, unknown>) {
  if (!env.TAILORED_EXTERNAL_API_URL) {
    return null;
  }

  const response = await fetch(`${env.TAILORED_EXTERNAL_API_URL.replace(/\/$/, "")}/jobs`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(env.TAILORED_EXTERNAL_API_KEY
        ? { Authorization: `Bearer ${env.TAILORED_EXTERNAL_API_KEY}` }
        : {}),
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = text ? (JSON.parse(text) as Record<string, unknown>) : null;
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new HTTPException(response.status as 400 | 401 | 403 | 404 | 409 | 422 | 429 | 500 | 502 | 503 | 504, {
      message:
        (parsed?.message as string | undefined) ||
        `Tailored external API request failed with status ${response.status}`,
    });
  }

  return parsed;
}

function requireTailoredCallback(c: { env: Bindings; req: { header(name: string): string | undefined | null } }) {
  const configured =
    c.env.TAILORED_CALLBACK_SECRET ||
    c.env.TAILORED_EXTERNAL_API_KEY ||
    null;
  if (!configured) {
    throw new HTTPException(503, { message: "Tailored callback auth is not configured" });
  }

  const provided =
    c.req.header("x-tailored-secret") ||
    c.req.header("x-probgm-tailored-secret") ||
    c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ||
    null;

  if (!provided || provided !== configured) {
    throw new HTTPException(401, { message: "Invalid tailored callback secret" });
  }
}

function assertOwnerOrAdmin(env: Bindings, sessionUserId: string, resourceUserId: string) {
  if (resourceUserId !== sessionUserId && !isAdminUserId(env, sessionUserId)) {
    throw new HTTPException(403, { message: "Not authorized to access this job" });
  }
}

export const tailoredRoutes = new Hono<{ Bindings: Bindings }>();

tailoredRoutes.get("/tailored/health", async (c) => {
  const data = await withConnection(c.env, async (connection) => {
    const rows = await queryRows<CountRow>(
      connection,
      "SELECT COUNT(*) AS count FROM tailored_requests",
    ).catch(() => [{ count: 0 }] as CountRow[]);

    return {
      service: "tailored-worker-skeleton",
      totalJobs: rows[0]?.count || 0,
      externalApiConfigured: Boolean(c.env.TAILORED_EXTERNAL_API_URL),
      hasExternalApiKey: Boolean(c.env.TAILORED_EXTERNAL_API_KEY),
      writeMode: "worker-safe-minimal",
      timestamp: new Date().toISOString(),
    };
  });

  return c.json(success(data, "Tailored health retrieved"));
});

tailoredRoutes.post("/tailored/create", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const body = await c.req.json().catch(
    () =>
      ({} as {
        title?: string;
        description?: string;
        category?: string;
        requirements?: Record<string, unknown>;
        files?: unknown[];
        notes?: string;
      }),
  );

  const title = String(body.title || "").trim();
  if (!title) {
    throw new HTTPException(400, { message: "title is required" });
  }

  const created = await withConnection(c.env, async (connection) => {
    const id = crypto.randomUUID();
    const jobId = crypto.randomUUID();

    let externalJobId: string | null = null;
    let externalResponse: Record<string, unknown> | null = null;

    if (c.env.TAILORED_EXTERNAL_API_URL) {
      externalResponse = await createExternalTailoredJob(c.env, {
        id,
        job_id: jobId,
        user_id: session.user.id,
        title,
        description: body.description || null,
        category: body.category || null,
        requirements: body.requirements || {},
        files: body.files || [],
        notes: body.notes || null,
      });
      externalJobId =
        (externalResponse?.external_job_id as string | undefined) ||
        (externalResponse?.job_id as string | undefined) ||
        (externalResponse?.id as string | undefined) ||
        null;
    }

    await queryRows(
      connection,
      `INSERT INTO tailored_requests
       (id, user_id, job_id, external_job_id, status, title, description, category, requirements, files, notes, retry_count, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [
        id,
        session.user.id,
        jobId,
        externalJobId,
        title,
        body.description || null,
        body.category || null,
        JSON.stringify(body.requirements || {}),
        JSON.stringify(body.files || []),
        body.notes || null,
      ],
    );

    await appendWorkflowEvent(c.env, connection, {
      jobId,
      userId: session.user.id,
      eventType: "status_transition",
      fromStatus: null,
      toStatus: "pending",
      metadata: {
        source: "worker-create",
        externalJobId,
      },
    });

    const job = await getTailoredRequestById(connection, id);
    return {
      job: job ? mapTailoredRequest(job) : { id, job_id: jobId, external_job_id: externalJobId, status: "pending", title },
      externalResponse,
    };
  });

  return c.json(success(created, "Tailored job created"), 201);
});

tailoredRoutes.get("/tailored/list", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const page = parsePositiveInt(c.req.query("page") || null, 1, 500);
  const limit = parsePositiveInt(c.req.query("limit") || null, 10, 100);
  const offset = (page - 1) * limit;
  const status = c.req.query("status");

  const result = await withConnection(c.env, async (connection) => {
    const whereConditions = ["user_id = ?"];
    const whereValues: Array<string | number> = [session.user.id];
    if (status && status !== "all") {
      whereConditions.push("status = ?");
      whereValues.push(status);
    }
    const whereClause = `WHERE ${whereConditions.join(" AND ")}`;

    const countRows = await queryRows<CountRow>(
      connection,
      `SELECT COUNT(*) AS count
       FROM tailored_requests
       ${whereClause}`,
      whereValues,
    ).catch(() => [{ count: 0 }] as CountRow[]);

    const rows = await queryRows<TailoredRequestRow>(
      connection,
      `SELECT *
       FROM tailored_requests
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
      [...whereValues, limit, offset],
    ).catch(() => []);

    return {
      data: rows.map(mapTailoredRequest),
      pagination: {
        page,
        limit,
        total: countRows[0]?.count || 0,
      },
    };
  });

  return c.json(success(result, "Tailored jobs retrieved"));
});

tailoredRoutes.get("/tailored/detail/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = c.req.param("id");
  if (!id) {
    throw new HTTPException(400, { message: "Job ID is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const job = await getTailoredRequestById(connection, id);
    if (!job) {
      throw new HTTPException(404, { message: "Tailored job not found" });
    }
    assertOwnerOrAdmin(c.env, session.user.id, job.user_id);
    return mapTailoredRequest(job);
  });

  return c.json(success(data, "Tailored job detail retrieved"));
});

tailoredRoutes.get("/tailored/result/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = c.req.param("id");
  if (!id) {
    throw new HTTPException(400, { message: "Job ID is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const job = await getTailoredRequestById(connection, id);
    if (!job) {
      throw new HTTPException(404, { message: "Tailored job not found" });
    }
    assertOwnerOrAdmin(c.env, session.user.id, job.user_id);
    return {
      id: job.id,
      job_id: job.job_id,
      status: job.status,
      result_files: parseJsonField<unknown[]>(job.result_files),
      completion_notes: job.completion_notes,
      completed_at: job.completed_at,
      confirmed_at: job.confirmed_at,
    };
  });

  return c.json(success(data, "Tailored result retrieved"));
});

tailoredRoutes.get("/tailored/preview/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = c.req.param("id");
  if (!id) {
    throw new HTTPException(400, { message: "Job ID is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const job = await getTailoredRequestById(connection, id);
    if (!job) {
      throw new HTTPException(404, { message: "Tailored job not found" });
    }
    assertOwnerOrAdmin(c.env, session.user.id, job.user_id);

    const resultFiles = parseJsonField<Array<{ url?: string; wav_url?: string } & Record<string, unknown>>>(job.result_files);
    const primaryFile = resultFiles?.[0] || null;

    return {
      id: job.id,
      job_id: job.job_id,
      status: job.status,
      preview_available: Boolean(primaryFile),
      preview_url: primaryFile?.wav_url || primaryFile?.url || null,
      completion_notes: job.completion_notes,
      completed_at: job.completed_at,
    };
  });

  return c.json(success(data, "Tailored preview retrieved"));
});

tailoredRoutes.put("/tailored/cancel/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = c.req.param("id");
  if (!id) {
    throw new HTTPException(400, { message: "Job ID is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const job = await getTailoredRequestById(connection, id);
    if (!job) {
      throw new HTTPException(404, { message: "Tailored job not found" });
    }
    assertOwnerOrAdmin(c.env, session.user.id, job.user_id);

    const currentStatus = job.status || "pending";
    if (!["pending", "estimated"].includes(currentStatus)) {
      throw new HTTPException(400, { message: `Cannot cancel job in ${currentStatus} status` });
    }

    await queryRows(
      connection,
      `UPDATE tailored_requests
       SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [job.id],
    );

    await appendWorkflowEvent(c.env, connection, {
      jobId: job.job_id || job.id,
      userId: session.user.id,
      eventType: "status_transition",
      fromStatus: currentStatus,
      toStatus: "cancelled",
      metadata: { source: "worker-cancel" },
    });

    const refreshed = await getTailoredRequestById(connection, job.id);
    return refreshed ? mapTailoredRequest(refreshed) : null;
  });

  return c.json(success(data, "Tailored job cancelled"));
});

tailoredRoutes.put("/tailored/approve/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = c.req.param("id");
  if (!id) {
    throw new HTTPException(400, { message: "Job ID is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const job = await getTailoredRequestById(connection, id);
    if (!job) {
      throw new HTTPException(404, { message: "Tailored job not found" });
    }
    assertOwnerOrAdmin(c.env, session.user.id, job.user_id);

    const currentStatus = job.status || "pending";
    if (currentStatus !== "estimated") {
      throw new HTTPException(400, { message: `Cannot approve job in ${currentStatus} status` });
    }

    await queryRows(
      connection,
      `UPDATE tailored_requests
       SET status = 'processing', processed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [job.id],
    );

    await appendWorkflowEvent(c.env, connection, {
      jobId: job.job_id || job.id,
      userId: session.user.id,
      eventType: "status_transition",
      fromStatus: currentStatus,
      toStatus: "processing",
      metadata: {
        source: "worker-approve-skeleton",
        paymentIntegrated: false,
      },
    });

    const refreshed = await getTailoredRequestById(connection, job.id);
    return refreshed ? mapTailoredRequest(refreshed) : null;
  });

  return c.json(success(data, "Tailored job approved (worker skeleton)"));
});

tailoredRoutes.put("/tailored/confirm/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = c.req.param("id");
  if (!id) {
    throw new HTTPException(400, { message: "Job ID is required" });
  }

  const body = await c.req.json().catch(() => ({} as { notes?: string }));

  const data = await withConnection(c.env, async (connection) => {
    const job = await getTailoredRequestById(connection, id);
    if (!job) {
      throw new HTTPException(404, { message: "Tailored job not found" });
    }
    assertOwnerOrAdmin(c.env, session.user.id, job.user_id);

    const currentStatus = job.status || "pending";
    if (!["confirming", "completed"].includes(currentStatus)) {
      throw new HTTPException(400, { message: `Cannot confirm job in ${currentStatus} status` });
    }

    await queryRows(
      connection,
      `UPDATE tailored_requests
       SET status = 'completed',
           completion_notes = COALESCE(?, completion_notes),
           confirmed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [body.notes || null, job.id],
    );

    await appendWorkflowEvent(c.env, connection, {
      jobId: job.job_id || job.id,
      userId: session.user.id,
      eventType: "status_transition",
      fromStatus: currentStatus,
      toStatus: "completed",
      metadata: { source: "worker-confirm" },
    });

    const refreshed = await getTailoredRequestById(connection, job.id);
    return refreshed ? mapTailoredRequest(refreshed) : null;
  });

  return c.json(success(data, "Tailored job confirmed"));
});

tailoredRoutes.put("/tailored/retry/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = c.req.param("id");
  if (!id) {
    throw new HTTPException(400, { message: "Job ID is required" });
  }

  const body = await c.req.json().catch(() => ({} as { retry_reason?: string }));

  const data = await withConnection(c.env, async (connection) => {
    const job = await getTailoredRequestById(connection, id);
    if (!job) {
      throw new HTTPException(404, { message: "Tailored job not found" });
    }
    assertOwnerOrAdmin(c.env, session.user.id, job.user_id);

    const currentStatus = job.status || "pending";
    if (!["failed", "completed", "confirming"].includes(currentStatus)) {
      throw new HTTPException(400, { message: `Cannot retry job in ${currentStatus} status` });
    }

    await queryRows(
      connection,
      `UPDATE tailored_requests
       SET status = 'processing',
           retry_reason = ?,
           retry_count = retry_count + 1,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [body.retry_reason || null, job.id],
    );

    await appendWorkflowEvent(c.env, connection, {
      jobId: job.job_id || job.id,
      userId: session.user.id,
      eventType: "status_transition",
      fromStatus: currentStatus,
      toStatus: "processing",
      metadata: {
        source: "worker-retry",
        retryReason: body.retry_reason || null,
      },
    });

    const refreshed = await getTailoredRequestById(connection, job.id);
    return refreshed ? mapTailoredRequest(refreshed) : null;
  });

  return c.json(success(data, "Tailored job retry requested"));
});

tailoredRoutes.post("/tailored/reject/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = c.req.param("id");
  if (!id) {
    throw new HTTPException(400, { message: "Job ID is required" });
  }

  const body = await c.req.json().catch(() => ({} as { comment?: string }));
  const comment = String(body.comment || "").trim();
  if (!comment) {
    throw new HTTPException(400, { message: "comment is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const job = await getTailoredRequestById(connection, id);
    if (!job) {
      throw new HTTPException(404, { message: "Tailored job not found" });
    }
    assertOwnerOrAdmin(c.env, session.user.id, job.user_id);

    const currentStatus = job.status || "pending";
    if (["cancelled", "rejected", "completed"].includes(currentStatus)) {
      throw new HTTPException(400, { message: `Cannot reject job in ${currentStatus} status` });
    }

    await queryRows(
      connection,
      `UPDATE tailored_requests
       SET status = 'rejected',
           error_message = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [comment, job.id],
    );

    await appendWorkflowEvent(c.env, connection, {
      jobId: job.job_id || job.id,
      userId: session.user.id,
      eventType: "status_transition",
      fromStatus: currentStatus,
      toStatus: "rejected",
      metadata: {
        source: "worker-reject",
        comment,
      },
    });

    const refreshed = await getTailoredRequestById(connection, job.id);
    return refreshed ? mapTailoredRequest(refreshed) : null;
  });

  return c.json(success(data, "Tailored job rejected"));
});

tailoredRoutes.post("/tailored/done/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = c.req.param("id");
  if (!id) {
    throw new HTTPException(400, { message: "Job ID is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const job = await getTailoredRequestById(connection, id);
    if (!job) {
      throw new HTTPException(404, { message: "Tailored job not found" });
    }
    assertOwnerOrAdmin(c.env, session.user.id, job.user_id);

    const currentStatus = job.status || "pending";
    if (!["processing", "estimated", "pending"].includes(currentStatus)) {
      throw new HTTPException(400, { message: `Cannot mark job done in ${currentStatus} status` });
    }

    await queryRows(
      connection,
      `UPDATE tailored_requests
       SET status = 'confirming',
           completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [job.id],
    );

    await appendWorkflowEvent(c.env, connection, {
      jobId: job.job_id || job.id,
      userId: session.user.id,
      eventType: "status_transition",
      fromStatus: currentStatus,
      toStatus: "confirming",
      metadata: { source: "worker-done" },
    });

    const refreshed = await getTailoredRequestById(connection, job.id);
    return refreshed ? mapTailoredRequest(refreshed) : null;
  });

  return c.json(success(data, "Tailored job marked as done"));
});

tailoredRoutes.post("/tailored/cancel-nopayment/:id", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));
  const id = c.req.param("id");
  if (!id) {
    throw new HTTPException(400, { message: "Job ID is required" });
  }

  const data = await withConnection(c.env, async (connection) => {
    const job = await getTailoredRequestById(connection, id);
    if (!job) {
      throw new HTTPException(404, { message: "Tailored job not found" });
    }
    assertOwnerOrAdmin(c.env, session.user.id, job.user_id);

    const currentStatus = job.status || "pending";
    if (["completed", "confirmed", "cancelled"].includes(currentStatus)) {
      throw new HTTPException(400, { message: `Cannot cancel job in ${currentStatus} status` });
    }

    await queryRows(
      connection,
      `UPDATE tailored_requests
       SET status = 'cancelled',
           refund_transaction_id = COALESCE(refund_transaction_id, 'nopayment'),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [job.id],
    );

    await appendWorkflowEvent(c.env, connection, {
      jobId: job.job_id || job.id,
      userId: session.user.id,
      eventType: "status_transition",
      fromStatus: currentStatus,
      toStatus: "cancelled",
      metadata: { source: "worker-cancel-nopayment" },
    });

    const refreshed = await getTailoredRequestById(connection, job.id);
    return refreshed ? mapTailoredRequest(refreshed) : null;
  });

  return c.json(success(data, "Tailored job cancelled without payment"));
});

tailoredRoutes.put("/tailored/estimate/:externalJobId", async (c) => {
  requireTailoredCallback(c);
  const externalJobId = c.req.param("externalJobId");
  if (!externalJobId) {
    throw new HTTPException(400, { message: "externalJobId is required" });
  }

  const body = await c.req.json().catch(
    () =>
      ({} as {
        price?: number;
        estimated_duration?: string;
        notes?: string;
      }),
  );

  const data = await withConnection(c.env, async (connection) => {
    const rows = await queryRows<TailoredRequestRow>(
      connection,
      "SELECT * FROM tailored_requests WHERE external_job_id = ? OR job_id = ? LIMIT 1",
      [externalJobId, externalJobId],
    );
    const job = rows[0];
    if (!job) {
      throw new HTTPException(404, { message: "Tailored job not found" });
    }

    const currentStatus = job.status || "pending";
    await queryRows(
      connection,
      `UPDATE tailored_requests
       SET status = 'estimated',
           price = COALESCE(?, price),
           estimated_duration = COALESCE(?, estimated_duration),
           notes = COALESCE(?, notes),
           estimated_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [body.price ?? null, body.estimated_duration || null, body.notes || null, job.id],
    );

    await appendWorkflowEvent(c.env, connection, {
      jobId: job.job_id || job.id,
      userId: job.user_id,
      eventType: "status_transition",
      fromStatus: currentStatus,
      toStatus: "estimated",
      metadata: {
        source: "external-estimate-callback",
        externalJobId,
        price: body.price ?? null,
      },
    });

    const refreshed = await getTailoredRequestById(connection, job.id);
    return refreshed ? mapTailoredRequest(refreshed) : null;
  });

  return c.json(success(data, "Tailored job estimated"));
});

tailoredRoutes.put("/tailored/completion/:externalJobId", async (c) => {
  requireTailoredCallback(c);
  const externalJobId = c.req.param("externalJobId");
  if (!externalJobId) {
    throw new HTTPException(400, { message: "externalJobId is required" });
  }

  const body = await c.req.json().catch(
    () =>
      ({} as {
        result_files?: unknown[];
        completion_notes?: string;
      }),
  );

  const data = await withConnection(c.env, async (connection) => {
    const rows = await queryRows<TailoredRequestRow>(
      connection,
      "SELECT * FROM tailored_requests WHERE external_job_id = ? OR job_id = ? LIMIT 1",
      [externalJobId, externalJobId],
    );
    const job = rows[0];
    if (!job) {
      throw new HTTPException(404, { message: "Tailored job not found" });
    }

    const currentStatus = job.status || "processing";
    await queryRows(
      connection,
      `UPDATE tailored_requests
       SET status = 'confirming',
           result_files = COALESCE(?, result_files),
           completion_notes = COALESCE(?, completion_notes),
           completed_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [
        body.result_files ? JSON.stringify(body.result_files) : null,
        body.completion_notes || null,
        job.id,
      ],
    );

    await appendWorkflowEvent(c.env, connection, {
      jobId: job.job_id || job.id,
      userId: job.user_id,
      eventType: "status_transition",
      fromStatus: currentStatus,
      toStatus: "confirming",
      metadata: {
        source: "external-completion-callback",
        externalJobId,
      },
    });

    const refreshed = await getTailoredRequestById(connection, job.id);
    return refreshed ? mapTailoredRequest(refreshed) : null;
  });

  return c.json(success(data, "Tailored job completion recorded"));
});

tailoredRoutes.put("/tailored/fail/:externalJobId", async (c) => {
  requireTailoredCallback(c);
  const externalJobId = c.req.param("externalJobId");
  if (!externalJobId) {
    throw new HTTPException(400, { message: "externalJobId is required" });
  }

  const body = await c.req.json().catch(
    () =>
      ({} as {
        error_message?: string;
      }),
  );

  const data = await withConnection(c.env, async (connection) => {
    const rows = await queryRows<TailoredRequestRow>(
      connection,
      "SELECT * FROM tailored_requests WHERE external_job_id = ? OR job_id = ? LIMIT 1",
      [externalJobId, externalJobId],
    );
    const job = rows[0];
    if (!job) {
      throw new HTTPException(404, { message: "Tailored job not found" });
    }

    const currentStatus = job.status || "processing";
    await queryRows(
      connection,
      `UPDATE tailored_requests
       SET status = 'failed',
           error_message = COALESCE(?, error_message),
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [body.error_message || null, job.id],
    );

    await appendWorkflowEvent(c.env, connection, {
      jobId: job.job_id || job.id,
      userId: job.user_id,
      eventType: "error",
      fromStatus: currentStatus,
      toStatus: "failed",
      success: false,
      errorMessage: body.error_message || "External tailored workflow failure",
      metadata: {
        source: "external-failure-callback",
        externalJobId,
      },
    });

    const refreshed = await getTailoredRequestById(connection, job.id);
    return refreshed ? mapTailoredRequest(refreshed) : null;
  });

  return c.json(success(data, "Tailored job failure recorded"));
});
