export interface PaymentCheckoutResult {
  provider: "stripe" | "bkash" | "nagad" | "mock";
  checkoutUrl: string;
  externalId: string;
}

export interface PaymentAdapter {
  readonly name: string;
  createCheckout(input: {
    customerId: string;
    invoiceId: string;
    amountCents: number;
    description: string;
  }): Promise<PaymentCheckoutResult>;
  verifyWebhook?(payload: string, signature: string): Promise<{ event: string; invoiceId?: string }>;
}

export class MockPaymentAdapter implements PaymentAdapter {
  readonly name = "mock";

  async createCheckout(input: {
    customerId: string;
    invoiceId: string;
    amountCents: number;
    description: string;
  }): Promise<PaymentCheckoutResult> {
    return {
      provider: "mock",
      checkoutUrl: `https://pay.modelforge.local/mock/${input.invoiceId}?amount=${input.amountCents}`,
      externalId: `mock_${input.invoiceId}`,
    };
  }

  async verifyWebhook(payload: string, _signature: string) {
    const data = JSON.parse(payload) as { event: string; invoiceId?: string };
    return data;
  }
}
