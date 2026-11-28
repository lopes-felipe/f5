import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { connect, type ClientHttp2Session } from "node:http2";

export const MOBILE_APNS_KEY_SECRET = "mobile-apns-p8";
export const MOBILE_ID_SECRET = "mobile-server-id";
export type PushEnvironment = "sandbox" | "production";

export function readApnsKey(pem: string): KeyObject {
  const key = createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("The APNs key must be a P-256 private key.");
  return key;
}

export function signApnsToken(key: KeyObject, teamId: string, keyId: string, now: number): string {
  const base64 = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const token =
    base64({ alg: "ES256", kid: keyId }) +
    "." +
    base64({ iss: teamId, iat: Math.floor(now / 1000) });
  return (
    token +
    "." +
    sign("sha256", Buffer.from(token), { key, dsaEncoding: "ieee-p1363" }).toString("base64url")
  );
}

export function makeApnsClient(options: { key: KeyObject; teamId: string; keyId: string }) {
  const sessions = new Map<PushEnvironment, ClientHttp2Session>();
  let cached: { at: number; jwt: string } | undefined;
  let stopped = false;

  function session(environment: PushEnvironment) {
    const previous = sessions.get(environment);
    if (previous && !previous.closed && !previous.destroyed) return previous;
    const origin =
      environment === "sandbox"
        ? "https://api.sandbox.push.apple.com"
        : "https://api.push.apple.com";
    const client = connect(origin, { settings: { enablePush: false } });
    sessions.set(environment, client);
    const remove = () => {
      if (sessions.get(environment) === client) sessions.delete(environment);
    };
    client.on("goaway", () => {
      remove();
      client.close();
    });
    client.on("error", remove);
    client.on("close", remove);
    return client;
  }
  return {
    send(input: {
      environment: PushEnvironment;
      token: string;
      bundleId: string;
      collapseId: string;
      priority: 5 | 10;
      payload: string;
    }): Promise<{ status: number; reason?: string }> {
      return new Promise((resolve, reject) => {
        if (stopped) throw new Error("APNs client is closed.");
        const now = Date.now();
        if (!cached || now < cached.at || now - cached.at >= 50 * 60_000)
          cached = { at: now, jwt: signApnsToken(options.key, options.teamId, options.keyId, now) };
        const stream = session(input.environment).request({
          ":path": "/3/device/" + input.token,
          ":method": "POST",
          authorization: "bearer " + cached.jwt,
          "content-type": "application/json",
          "apns-topic": input.bundleId,
          "apns-push-type": "alert",
          "apns-priority": input.priority,
          "apns-collapse-id": input.collapseId,
          "apns-expiration": String(Math.floor(Date.now() / 1000) + 60),
        });
        let status = 0;
        let body = "";
        stream.setEncoding("utf8");
        stream.setTimeout(8000, () => stream.destroy(new Error("APNs request timed out.")));
        stream.on("response", (headers) => {
          status = Number(headers[":status"]);
        });
        stream.on("data", (chunk: string) => {
          if (body.length <= 4096) body += chunk;
        });
        stream.on("end", () => {
          let reason: unknown;
          try {
            reason = JSON.parse(body).reason;
          } catch {}
          resolve(typeof reason === "string" ? { status, reason } : { status });
        });
        stream.on("error", reject);
        stream.on("close", () => reject(new Error("APNs stream closed.")));
        stream.end(input.payload);
      });
    },
    close() {
      stopped = true;
      for (const client of sessions.values()) client.destroy();
      sessions.clear();
    },
  };
}
