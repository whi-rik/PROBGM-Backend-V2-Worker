import type { Bindings } from "./env";
import { runScheduledJob } from "./lib/jobs";

export async function handleScheduled(controller: ScheduledController, env: Bindings, ctx: ExecutionContext) {
  const startedAt = Date.now();
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
}
