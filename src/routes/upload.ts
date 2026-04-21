import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import type { Bindings } from "../env";
import { requireSessionFromRequest } from "../lib/auth";
import { withConnection } from "../lib/db";
import { success } from "../lib/response";

const DEFAULT_ALLOWED_TYPES = [
  "audio/mpeg",
  "audio/mp3",
  "audio/wav",
  "audio/ogg",
  "audio/webm",
  "audio/aac",
  "audio/flac",
  "audio/m4a",
  "audio/x-m4a",
  "text/plain",
];

function getMaxUploadSize(env: Bindings) {
  const value = Number.parseInt(env.FILE_UPLOAD_MAX_SIZE || "104857600", 10);
  return Number.isFinite(value) && value > 0 ? value : 104857600;
}

function getAllowedTypes(env: Bindings) {
  return env.FILE_UPLOAD_ALLOWED_TYPES
    ? env.FILE_UPLOAD_ALLOWED_TYPES.split(",").map((item) => item.trim()).filter(Boolean)
    : DEFAULT_ALLOWED_TYPES;
}

function generateFilePath(env: Bindings, originalFileName: string, userId: string) {
  const now = new Date();
  const dateFolder = now.toISOString().slice(0, 10);
  const randomString = Math.random().toString(36).slice(2, 10);
  const prefix = (env.FILE_UPLOAD_PREFIX || "tailored-service-upload").replace(/^\/+|\/+$/g, "");
  return `${prefix}/${dateFolder}/${userId}/${randomString}/${originalFileName}`;
}

function encodeStoragePath(filePath: string) {
  const pathParts = filePath.split("/");
  const encodedFileName = encodeURIComponent(pathParts[pathParts.length - 1] || "");
  pathParts[pathParts.length - 1] = encodedFileName;
  return pathParts.join("/");
}

function buildPublicUrl(env: Bindings, filePath: string) {
  const base = (env.R2_PUBLIC_URL || "").replace(/\/+$/g, "");
  if (!base) {
    return null;
  }

  const encodedPath = filePath.split("/").map((segment) => encodeURIComponent(segment)).join("/");
  return `${base}/${encodedPath}`;
}

function getMetadataTableName(env: Bindings) {
  const table = (env.UPLOAD_METADATA_TABLE || "").trim();
  if (!table) {
    return null;
  }
  if (!/^[A-Za-z0-9_]+$/.test(table)) {
    throw new HTTPException(500, { message: "UPLOAD_METADATA_TABLE contains invalid characters" });
  }
  return table;
}

async function persistUploadMetadata(
  env: Bindings,
  input: {
    userId: string;
    fileName: string;
    storageKey: string;
    publicUrl: string | null;
    fileSize: number;
    mimeType: string;
  },
) {
  const table = getMetadataTableName(env);
  if (!table) {
    return { enabled: false, persisted: false as const };
  }

  try {
    await withConnection(env, async (connection) => {
      await connection.exec(
        `INSERT INTO ${table}
         (id, user_id, file_name, storage_key, public_url, file_size, mime_type, provider, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'r2', CURRENT_TIMESTAMP)`,
        [
          crypto.randomUUID(),
          input.userId,
          input.fileName,
          input.storageKey,
          input.publicUrl,
          input.fileSize,
          input.mimeType,
        ],
      );
    });

    return { enabled: true, persisted: true as const };
  } catch (error) {
    return {
      enabled: true,
      persisted: false as const,
      error: error instanceof Error ? error.message : "Failed to persist upload metadata",
    };
  }
}

export const uploadRoutes = new Hono<{ Bindings: Bindings }>();

uploadRoutes.post("/upload", async (c) => {
  const session = await requireSessionFromRequest(c.env, c.req.header("Authorization"));

  if (!c.env.UPLOADS_BUCKET) {
    throw new HTTPException(503, { message: "R2 upload bucket is not configured" });
  }

  const formData = await c.req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) {
    throw new HTTPException(400, { message: "No file uploaded" });
  }

  if (file.size > getMaxUploadSize(c.env)) {
    throw new HTTPException(400, { message: "File size exceeds the maximum allowed limit" });
  }

  const allowedTypes = getAllowedTypes(c.env);
  if (!allowedTypes.includes(file.type)) {
    throw new HTTPException(400, { message: "File type is not allowed" });
  }

  const filePath = generateFilePath(c.env, file.name, session.user.id);
  const encodedStoragePath = encodeStoragePath(filePath);
  await c.env.UPLOADS_BUCKET.put(encodedStoragePath, await file.arrayBuffer(), {
    httpMetadata: {
      contentType: file.type,
    },
  });

  const publicUrl = buildPublicUrl(c.env, filePath);
  const metadata = await persistUploadMetadata(c.env, {
    userId: session.user.id,
    fileName: file.name,
    storageKey: encodedStoragePath,
    publicUrl,
    fileSize: file.size,
    mimeType: file.type,
  });

  return c.json(
    success(
      {
        publicUrl,
        filePath: encodedStoragePath,
        storageKey: encodedStoragePath,
        originalFilePath: filePath,
        fileName: encodeURIComponent(file.name),
        originalFileName: file.name,
        fileSize: file.size,
        mimeType: file.type,
        metadata,
      },
      "File uploaded successfully",
    ),
  );
});

uploadRoutes.get("/upload/health", async (c) =>
  c.json(
    success({
      ready: Boolean(c.env.UPLOADS_BUCKET),
      provider: "r2",
      publicUrlConfigured: Boolean(c.env.R2_PUBLIC_URL),
      prefix: c.env.FILE_UPLOAD_PREFIX || "tailored-service-upload",
      maxUploadSize: getMaxUploadSize(c.env),
      allowedTypes: getAllowedTypes(c.env),
      metadataTable: getMetadataTableName(c.env),
      timestamp: new Date().toISOString(),
    }, "File upload service is running"),
  ),
);
