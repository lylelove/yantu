/**
 * Same-origin AI API proxy for web deployments.
 * Works in Vite dev (middleware) and Cloudflare Pages (Functions).
 */

export async function fetchAiApi(
  targetUrl: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("x-ai-target", targetUrl);

  return fetch(`${window.location.origin}/ai-proxy`, {
    ...init,
    headers,
  });
}
