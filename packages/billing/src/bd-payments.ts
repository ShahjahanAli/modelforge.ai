import type { PaymentAdapter, PaymentCheckoutResult } from "./adapters.js";

/**
 * Bangladesh payment adapters.
 * These providers do not natively support metered billing — invoice first, then checkout link.
 */
export class BkashAdapter implements PaymentAdapter {
  readonly name = "bkash";

  async createCheckout(input: {
    customerId: string;
    invoiceId: string;
    amountCents: number;
    description: string;
  }): Promise<PaymentCheckoutResult> {
    const amountBdt = (input.amountCents / 100).toFixed(2);
    // Real integration would call bKash Create Payment API with BKASH_APP_KEY/SECRET.
    return {
      provider: "bkash",
      checkoutUrl: `https://pay.modelforge.local/bkash/${input.invoiceId}?amount=${amountBdt}`,
      externalId: `bkash_${input.invoiceId}`,
    };
  }
}

export class NagadAdapter implements PaymentAdapter {
  readonly name = "nagad";

  async createCheckout(input: {
    customerId: string;
    invoiceId: string;
    amountCents: number;
    description: string;
  }): Promise<PaymentCheckoutResult> {
    const amountBdt = (input.amountCents / 100).toFixed(2);
    return {
      provider: "nagad",
      checkoutUrl: `https://pay.modelforge.local/nagad/${input.invoiceId}?amount=${amountBdt}`,
      externalId: `nagad_${input.invoiceId}`,
    };
  }
}
