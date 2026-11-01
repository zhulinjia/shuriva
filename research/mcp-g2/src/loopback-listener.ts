import { randomInt } from "node:crypto";
import type { Server } from "node:net";

/** Bind the owned fixture directly, without probing or replacing other services.
 * IANA dynamic/private ports avoid Fetch's blocked service-port list. Windows
 * port=0 can otherwise select a port that the official SDK's fetch rejects. */
export async function listenLoopback(
  server: Server,
  choosePort: () => number = () => randomInt(49152, 65536),
): Promise<number> {
  if (server.listening) throw new Error("G2_LISTENER_ALREADY_BOUND");
  for (let attempt = 0; attempt < 16; attempt++) {
    const port = choosePort();
    if (!Number.isInteger(port) || port < 49152 || port > 65535)
      throw new Error("G2_LISTENER_PORT_REJECTED");
    try {
      await new Promise<void>((resolve, reject) => {
        const failed = (error: unknown) => {
          server.removeListener("listening", ready);
          server.removeListener("error", failed);
          reject(error);
        };
        const ready = () => {
          server.removeListener("error", failed);
          resolve();
        };
        server.once("error", failed);
        server.once("listening", ready);
        try {
          server.listen(port, "127.0.0.1");
        } catch (error) {
          failed(error);
        }
      });
      return port;
    } catch (error) {
      const code = error instanceof Error ? Reflect.get(error, "code") : undefined;
      if (code !== "EADDRINUSE" && code !== "EACCES") throw error;
    }
  }
  throw new Error("G2_LISTENER_CAPACITY");
}
