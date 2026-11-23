import type { FastifyInstance } from "fastify";
import type { ServerResponse } from "node:http";
import { sql } from "../db.ts";

/** Open event streams, one per browser tab. */
const clients = new Set<ServerResponse>();

/**
 * Server-sent events: pushes `document` events ({ id, status }) the moment a
 * document arrives, changes status or is deleted, so the inbox and the nav
 * badge update without polling. Postgres NOTIFY carries the change, so this
 * also sees work done by a worker running in another process.
 */
export async function eventRoutes(app: FastifyInstance) {
  await sql.listen("docket_document", (payload) => broadcast("document", payload), () => {
    // (Re)connected to Postgres: changes may have been missed while it was down.
    broadcast("resync", "{}");
  });

  app.get("/api/events", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Don't let a reverse proxy (nginx) hold events back in a buffer.
      "x-accel-buffering": "no",
    });
    // How long the browser waits before reconnecting after the stream drops.
    res.write("retry: 3000\n\n");
    clients.add(res);
    req.raw.on("close", () => clients.delete(res));
  });

  // A comment line now and then keeps proxies and phones from closing an idle stream.
  const ping = setInterval(() => { for (const c of clients) c.write(": ping\n\n"); }, 25_000);
  app.addHook("onClose", async () => {
    clearInterval(ping);
    for (const c of clients) c.end();
    clients.clear();
  });
}

function broadcast(event: string, data: string) {
  const msg = `event: ${event}\ndata: ${data}\n\n`;
  for (const c of clients) c.write(msg);
}
