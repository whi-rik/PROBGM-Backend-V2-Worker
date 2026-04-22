import type { Bindings } from "./env";
import { runScheduledJob } from "./lib/jobs";

export async function handleScheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
  const startedAt = Date.now();

  try {
    const result = await runScheduledJob(env, controller.cron);
    const elapsedMs = Date.now() - startedAt;

    ctx.waitUntil(
      Promise.resolve().then(() => {
        console.log("[scheduled]", JSON.stringify({
          cron: controller.cron,
          scheduledTime: controller.scheduledTime,
          elapsedMs,
          result,
        }));
      }),
    );
  } catch (error) {
    const elapsedMs = Date.now() - startedAt;
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;

    console.error("[scheduled] job failed", JSON.stringify({
      cron: controller.cron,
      scheduledTime: controller.scheduledTime,
      elapsedMs,
      error: message,
      stack,
    }));

    throw error;
  }
}
