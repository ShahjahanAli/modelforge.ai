import {
  generateKeyPairSync,
  sign as cryptoSign,
  verify as cryptoVerify,
} from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  canonicalStringify,
  hashCanonicalPayload,
  sha256Hex,
} from "./canonical.js";

export const SIGNING_ALGORITHM = "Ed25519" as const;

export interface PayloadSignature {
  keyId: string;
  signature: string;
  payloadHash: string;
  algorithm: typeof SIGNING_ALGORITHM;
}

export interface SigningProvider {
  signPayload(payload: unknown): PayloadSignature;
  verifyPayload(payload: unknown, signed: PayloadSignature): boolean;
}

export interface LocalFileSigningProviderOptions {
  privateKeyFile?: string;
  publicKeyFile?: string;
}

export class LocalFileSigningProvider implements SigningProvider {
  readonly keyId: string;
  readonly publicKey: string;

  private readonly privateKey: string;

  constructor(directory: string, options: LocalFileSigningProviderOptions = {}) {
    const privatePath = join(directory, options.privateKeyFile ?? "ed25519-private.pem");
    const publicPath = join(directory, options.publicKeyFile ?? "ed25519-public.pem");
    mkdirSync(directory, { recursive: true });

    try {
      this.privateKey = readFileSync(privatePath, "utf8");
      this.publicKey = readFileSync(publicPath, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        throw error;
      }

      const keys = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      this.privateKey = keys.privateKey;
      this.publicKey = keys.publicKey;
      writeFileSync(privatePath, this.privateKey, { encoding: "utf8", mode: 0o600 });
      writeFileSync(publicPath, this.publicKey, { encoding: "utf8", mode: 0o644 });
    }

    this.keyId = sha256Hex(this.publicKey).slice(0, 32);
  }

  signPayload(payload: unknown): PayloadSignature {
    const canonical = canonicalStringify(payload);
    return {
      keyId: this.keyId,
      signature: cryptoSign(null, Buffer.from(canonical), this.privateKey).toString(
        "base64url",
      ),
      payloadHash: hashCanonicalPayload(payload),
      algorithm: SIGNING_ALGORITHM,
    };
  }

  verifyPayload(payload: unknown, signed: PayloadSignature): boolean {
    if (
      signed.algorithm !== SIGNING_ALGORITHM ||
      signed.keyId !== this.keyId ||
      signed.payloadHash !== hashCanonicalPayload(payload)
    ) {
      return false;
    }

    try {
      return cryptoVerify(
        null,
        Buffer.from(canonicalStringify(payload)),
        this.publicKey,
        Buffer.from(signed.signature, "base64url"),
      );
    } catch {
      return false;
    }
  }
}

export function signPayload(
  provider: SigningProvider,
  payload: unknown,
): PayloadSignature {
  return provider.signPayload(payload);
}

export function verifyPayload(
  provider: SigningProvider,
  payload: unknown,
  signed: PayloadSignature,
): boolean {
  return provider.verifyPayload(payload, signed);
}
