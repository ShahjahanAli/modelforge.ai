import Stripe from "stripe";
import type { PaymentAdapter, PaymentCheckoutResult } from "./adapters.js";

export class StripeAdapter implements PaymentAdapter {
  readonly name = "stripe";
  private stripe: Stripe;

  constructor(secretKey: string) {
    this.stripe = new Stripe(secretKey);
  }

  async createCheckout(input: {
    customerId: string;
    invoiceId: string;
    amountCents: number;
    description: string;
  }): Promise<PaymentCheckoutResult> {
    const session = await this.stripe.checkout.sessions.create({
      mode: "payment",
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: input.amountCents,
            product_data: { name: input.description },
          },
        },
      ],
      success_url: `${process.env.NEXT_PUBLIC_APP_URL}/billing?paid=1`,
      cancel_url: `${process.env.NEXT_PUBLIC_APP_URL}/billing?canceled=1`,
      metadata: {
        customerId: input.customerId,
        invoiceId: input.invoiceId,
      },
    });

    return {
      provider: "stripe",
      checkoutUrl: session.url ?? "",
      externalId: session.id,
    };
  }

  async verifyWebhook(payload: string, signature: string) {
    const secret = process.env.STRIPE_WEBHOOK_SECRET;
    if (!secret) throw new Error("STRIPE_WEBHOOK_SECRET not configured");
    const event = this.stripe.webhooks.constructEvent(payload, signature, secret);
    const invoiceId =
      event.type === "checkout.session.completed"
        ? ((event.data.object as Stripe.Checkout.Session).metadata?.invoiceId ?? undefined)
        : undefined;
    return { event: event.type, invoiceId };
  }
}
