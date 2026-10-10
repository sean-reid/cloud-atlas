import { handleApi, type Env } from "./api";
import { withSecurityHeaders } from "./headers";

export type { Env };

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const res = url.pathname.startsWith("/api/")
      ? await handleApi(request, env, ctx)
      : await env.ASSETS.fetch(request);
    return withSecurityHeaders(res);
  },
} satisfies ExportedHandler<Env>;
