import { createHmac, createPrivateKey, createPublicKey, sign } from "node:crypto";

/** Connector platform identity is derived from the registry key; no key is exported. */
export class RegistrySigner {
  constructor(private readonly key: Buffer) {}
  private signingKey() {
    const seed = createHmac("sha256", this.key).update("connector-platform-signing-v1").digest();
    return createPrivateKey({
      key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]),
      format: "der",
      type: "pkcs8",
    });
  }
  publicKey(): string {
    return createPublicKey(this.signingKey())
      .export({ format: "der", type: "spki" })
      .subarray(-32)
      .toString("base64url");
  }
  signBytes(content: Uint8Array): string {
    return sign(null, content, this.signingKey()).toString("base64url");
  }
  signFields(fields: string[]): string {
    return this.signBytes(Buffer.from(fields.join("\n")));
  }
}
