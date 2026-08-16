import { randomUUID } from "node:crypto";

export interface FederationCommand<TPayload = unknown> {
  type: string;
  nonce: string;
  payload: TPayload;
}

export interface FederationTransport {
  send<TPayload, TResult>(
    command: FederationCommand<TPayload>,
  ): Promise<TResult>;
}

/**
 * In-process federation transport intended for local development and tests.
 */
export class LocalLoopbackTransport implements FederationTransport {
  constructor(
    private readonly handler: (
      command: FederationCommand,
    ) => Promise<unknown> | unknown,
  ) {}

  async send<TPayload, TResult>(
    command: FederationCommand<TPayload>,
  ): Promise<TResult> {
    return (await this.handler(command)) as TResult;
  }
}

export function createCommandNonce(): string {
  return randomUUID();
}

/**
 * Checks and records a nonce. The first observation returns false; subsequent
 * observations using the same Set return true.
 */
export function isReplay(nonce: string, seenSet: Set<string>): boolean {
  if (seenSet.has(nonce)) {
    return true;
  }
  seenSet.add(nonce);
  return false;
}
