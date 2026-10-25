import { ingestDispatch } from "../shared/dispatch";
import { handleApi, type Env } from "./api";
import { withSecurityHeaders } from "./headers";

export type { Env };

// GitHub's own schedule for the ingest workflow drifts by hours on this repository, so the
// Worker's cron asks GitHub to run it on the hour instead.
async function dispatchIngest(env: Env, now: Date): Promise<void> {
  if (!env.GITHUB_DISPATCH_TOKEN) {
    console.warn("ingest dispatch skipped: GITHUB_DISPATCH_TOKEN is not set");
    return;
  }
  const { url, init } = ingestDispatch(now, env.GITHUB_DISPATCH_TOKEN);
  const res = await fetch(url, init);
  if (res.status !== 204)
    console.error(`ingest dispatch failed: ${res.status} ${await res.text()}`);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const res = url.pathname.startsWith("/api/")
      ? await handleApi(request, env, ctx)
      : await env.ASSETS.fetch(request);
    return withSecurityHeaders(res);
  },
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(dispatchIngest(env, new Date(controller.scheduledTime)));
  },
} satisfies ExportedHandler<Env>;
