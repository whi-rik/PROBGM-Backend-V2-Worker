import { Hono } from "hono";
import { cors } from "hono/cors";
import { HTTPException } from "hono/http-exception";
import type { Bindings } from "./env";
import { failure, legacyHttpFailure } from "./lib/response";
import { healthRoutes } from "./routes/health";
import { v3Routes } from "./routes/v3";
import { playlistRoutes } from "./routes/playlists";
import { authRoutes } from "./routes/auth";
import { v2PlaylistRoutes } from "./routes/v2-playlists";
import { billingRoutes } from "./routes/billing";
import { paymentRoutes } from "./routes/payments";
import { userRoutes } from "./routes/user";
import { downloadRoutes } from "./routes/download";
import { promotionRoutes } from "./routes/promotion";
import { redeemRoutes } from "./routes/redeem";
import { uploadRoutes } from "./routes/upload";
import { adminRoutes } from "./routes/admin";
import { v2AdminRoutes } from "./routes/v2-admin";
import { syncRoutes } from "./routes/sync";
import { jobRoutes } from "./routes/jobs";
import { workflowRoutes } from "./routes/workflow";
import { tailoredRoutes } from "./routes/tailored";
import { handleScheduled } from "./scheduled";

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", cors());

app.onError((error, c) => {
  if (error instanceof HTTPException) {
    const response = error.getResponse();
    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return response;
    }

    return c.json(
      legacyHttpFailure(
        error.message || "요청 처리 중 오류가 발생했습니다.",
        error.status,
        c.req.path,
        c.req.method,
        c.env.APP_ENV === "development" && error.stack ? { stack: error.stack } : undefined,
      ),
      error.status,
    );
  }

  console.error("[probgm-backend-v2-worker] unhandled error", error);
  return c.json(
    failure(
      error instanceof Error ? error.message : "서버 오류가 발생했습니다.",
      500,
    ),
    500,
  );
});

app.route("/", healthRoutes);
app.route("/", userRoutes);
// Legacy Backend-TS mounts user routes under /api (so the contract is
// /api/user/info, /api/user/channel/:id, /api/user/profile, etc.). FE V2 has
// been authored against the unprefixed /user/* form, and some FE V1 call
// sites still use the /api/user/* form. Register both so no client breaks.
app.route("/api", userRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/v3", v3Routes);
app.route("/api", playlistRoutes);
app.route("/api", downloadRoutes);
app.route("/api", promotionRoutes);
app.route("/api", redeemRoutes);
app.route("/api", uploadRoutes);
app.route("/api", billingRoutes);
app.route("/api", paymentRoutes);
app.route("/api/v2", v2PlaylistRoutes);
app.route("/api/v2", v2AdminRoutes);
app.route("/api/admin", adminRoutes);
app.route("/api", syncRoutes);
app.route("/api", jobRoutes);
app.route("/api", workflowRoutes);
app.route("/api", tailoredRoutes);

export default {
  fetch: app.fetch,
  scheduled: handleScheduled,
};
