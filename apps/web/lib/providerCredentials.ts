import { createCipheriv, createHash, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";

function masterKeyBytes(): Buffer {
  const raw =
    process.env.PROVIDER_CREDENTIALS_MASTER_KEY?.trim() ||
    process.env.JWT_SECRET?.trim() ||
    process.env.AUTH_SECRET?.trim() ||
    "";
  if (!raw) {
    throw new Error(
      "PROVIDER_CREDENTIALS_MASTER_KEY (or JWT_SECRET / AUTH_SECRET) is required to store remote LLM API keys",
    );
  }
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return createHash("sha256").update(raw, "utf8").digest();
}

export function encryptProviderSecret(plaintext: string): {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyPrefix: string;
} {
  const key = masterKeyBytes();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const trimmed = plaintext.trim();
  const keyPrefix = trimmed.length <= 8 ? trimmed.slice(0, 4) : trimmed.slice(-4);
  return {
    ciphertext: encrypted.toString("base64"),
    iv: iv.toString("base64"),
    authTag: authTag.toString("base64"),
    keyPrefix,
  };
}
