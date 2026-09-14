/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/**
 * Vite config.
 *
 * `defineConfig` is imported from vite rather than vitest/config, with the
 * triple-slash reference above supplying the `test` key's types — that keeps
 * vitest out of the production build's module graph while still typechecking
 * the test block.
 */
export default defineConfig({
  plugins: [
    react(),
    // Dev-server middleware to proxy AI API calls, bypassing browser CORS.
    // The frontend sends requests to /ai-proxy with the real target URL
    // in the x-ai-target header; this middleware forwards them server-side.
    {
      name: "ai-proxy",
      configureServer(server) {
        server.middlewares.use("/ai-proxy", async (req, res) => {
          // Handle CORS preflight
          if (req.method === "OPTIONS") {
            res.setHeader("Access-Control-Allow-Origin", "*");
            res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-ai-target");
            res.statusCode = 204;
            res.end();
            return;
          }

          // Collect request body
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(chunk);
          const body = Buffer.concat(chunks);

          const target = req.headers["x-ai-target"];
          if (!target || typeof target !== "string") {
            res.statusCode = 400;
            res.end("Missing x-ai-target header");
            return;
          }

          try {
            const forwardHeaders: Record<string, string> = {
              "Content-Type": req.headers["content-type"] as string || "application/json",
              Authorization: req.headers["authorization"] as string || "",
            };

            const response = await fetch(target, {
              method: req.method || "POST",
              headers: forwardHeaders,
              body: body.length > 0 ? body : undefined,
            });

            res.statusCode = response.status;
            // Forward CORS headers so the browser accepts the response
            res.setHeader("Access-Control-Allow-Origin", "*");
            const responseBody = await response.text();
            res.end(responseBody);
          } catch (err) {
            res.statusCode = 502;
            res.end(`Proxy error: ${err instanceof Error ? err.message : String(err)}`);
          }
        });
      },
    },
  ],
  // Tauri points its dev window at this port, so a silent fallback to another
  // one would leave the desktop shell showing a blank window.
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2020",
    sourcemap: true,
  },
  test: {
    // Everything under test is pure logic; no DOM environment needed.
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
