/**
 * Cloudflare Pages Function: same-origin proxy for AI API calls.
 * Mirrors the Vite dev-server /ai-proxy middleware so browser CORS
 * does not block OpenAI-compatible providers in production.
 */

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, x-ai-target",
};

export async function onRequest(context: { request: Request }): Promise<Response> {
  const { request } = context;

  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (request.method !== "GET" && request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
  }

  const target = request.headers.get("x-ai-target");
  if (!target) {
    return new Response("Missing x-ai-target header", { status: 400, headers: CORS_HEADERS });
  }

  try {
    const forwardHeaders: Record<string, string> = {};
    const contentType = request.headers.get("Content-Type");
    const authorization = request.headers.get("Authorization");
    if (contentType) forwardHeaders["Content-Type"] = contentType;
    if (authorization) forwardHeaders["Authorization"] = authorization;

    const response = await fetch(target, {
      method: request.method,
      headers: forwardHeaders,
      body: request.method === "POST" ? await request.text() : undefined,
    });

    const responseHeaders = new Headers(CORS_HEADERS);
    const responseContentType = response.headers.get("Content-Type");
    if (responseContentType) responseHeaders.set("Content-Type", responseContentType);

    return new Response(await response.text(), {
      status: response.status,
      headers: responseHeaders,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(`Proxy error: ${message}`, { status: 502, headers: CORS_HEADERS });
  }
}
