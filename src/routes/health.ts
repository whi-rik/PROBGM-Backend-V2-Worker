import { Hono } from "hono";
import type { Bindings } from "../env";
import { getApiBaseUrl, getAppEnv } from "../env";
import { getAdminDiagnostics } from "../lib/admin";
import { getDbProviderDiagnostics, pingDatabase } from "../lib/db";
import { WORKER_CRON_SCHEDULES } from "../lib/jobs";
import { success } from "../lib/response";

export const healthRoutes = new Hono<{ Bindings: Bindings }>();

function getStorageDiagnostics(env: Bindings) {
  return {
    provider: "r2",
    configured: Boolean(env.UPLOADS_BUCKET),
    publicUrlConfigured: Boolean(env.R2_PUBLIC_URL),
    prefix: env.FILE_UPLOAD_PREFIX || "tailored-service-upload",
    maxUploadSize: Number.parseInt(env.FILE_UPLOAD_MAX_SIZE || "104857600", 10),
    uploadMetadataTable: env.UPLOAD_METADATA_TABLE || null,
    paymentWebhookAuditTable: env.PAYMENT_WEBHOOK_AUDIT_TABLE || null,
  };
}

healthRoutes.get("/", (c) =>
  c.json(
    success({
      service: "PROBGM Backend V2 Worker",
      status: "ok",
      environment: getAppEnv(c.env),
      timestamp: new Date().toISOString(),
      api_base_url: getApiBaseUrl(c.env),
    }),
  ),
);

healthRoutes.get("/health", (c) =>
  c.json(
    success({
      status: "ok",
      timestamp: new Date().toISOString(),
      environment: getAppEnv(c.env),
      runtime: "cloudflare-workers",
      database: getDbProviderDiagnostics(c.env),
      storage: getStorageDiagnostics(c.env),
      admin: getAdminDiagnostics(c.env),
      backgroundJobs: {
        scheduler: "cloudflare-scheduled",
        mappedCrons: WORKER_CRON_SCHEDULES,
      },
    }),
  ),
);

healthRoutes.get("/health/db", async (c) => {
  const diagnostics = getDbProviderDiagnostics(c.env);
  const result = await pingDatabase(c.env);

  return c.json(
    success({
      selectedProvider: diagnostics.selectedProvider,
      configuredProvider: diagnostics.configuredProvider,
      bindings: diagnostics.bindings,
      connection: result,
      recommendation:
        diagnostics.selectedProvider === "mysql"
          ? "mysql/hyperdrive is currently the safest parity path"
          : "validate schema parity carefully before promoting this provider",
      timestamp: new Date().toISOString(),
    }),
  );
});

healthRoutes.get("/health/storage", (c) =>
  c.json(
    success({
      ...getStorageDiagnostics(c.env),
      timestamp: new Date().toISOString(),
    }),
  ),
);

healthRoutes.get("/health/schema", (c) =>
  c.json(
    success({
      provider: getDbProviderDiagnostics(c.env).selectedProvider,
      optionalTables: {
        uploadMetadata: {
          configuredTable: c.env.UPLOAD_METADATA_TABLE || null,
          requiredColumns: [
            "id",
            "user_id",
            "file_name",
            "storage_key",
            "public_url",
            "file_size",
            "mime_type",
            "provider",
            "created_at",
          ],
        },
        paymentWebhookAudit: {
          configuredTable: c.env.PAYMENT_WEBHOOK_AUDIT_TABLE || null,
          requiredColumns: [
            "id",
            "webhook_id",
            "event_type",
            "payment_key",
            "order_id",
            "billing_key",
            "customer_key",
            "status",
            "raw_data",
            "processing_result",
            "error_message",
            "processed_at",
            "created_at",
          ],
        },
        workflowMonitoring: {
          configuredTable: c.env.WORKFLOW_MONITORING_TABLE || "workflow_monitoring_events",
          requiredColumns: [
            "id",
            "event_type",
            "job_id",
            "user_id",
            "from_status",
            "to_status",
            "operation_duration",
            "success",
            "error_message",
            "metadata",
            "created_at",
          ],
        },
      },
      recommendedCoreTables: [
        "users",
        "users_tokens",
        "users_balance",
        "users_membership",
        "users_channels",
        "playlist",
        "playlist_music",
        "payments",
        "payment_cancellations",
        "billing_cycles",
        "tailored_requests",
      ],
      timestamp: new Date().toISOString(),
    }),
  ),
);

healthRoutes.get("/health/jobs", (c) =>
  c.json(
    success({
      scheduler: "cloudflare-scheduled",
      mappedCrons: WORKER_CRON_SCHEDULES,
      implemented: [
        "pending-grants",
        "typesense-consistency",
        "credit-renewal-monthly",
        "credit-expiration-daily",
        "billing-due",
        "billing-retries",
      ],
      planned: [
        "billing-notifications",
        "channel-renewals",
        "tailored-monitoring",
        "typesense-blue-green-recovery",
      ],
      timestamp: new Date().toISOString(),
    }),
  ),
);
