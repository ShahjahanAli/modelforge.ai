import { NextResponse } from "next/server";
import { prisma } from "@modelforge/db";
import { createPaymentAdapter } from "@modelforge/billing";

export async function POST(req: Request) {
  const signature = req.headers.get("stripe-signature") ?? "";
  const payload = await req.text();
  const adapter = createPaymentAdapter(process.env.STRIPE_SECRET_KEY ? "stripe" : "mock");

  try {
    if (!adapter.verifyWebhook) {
      return NextResponse.json({ ok: true, skipped: true });
    }
    const event = await adapter.verifyWebhook(payload, signature);
    if (event.invoiceId && (event.event === "checkout.session.completed" || event.event === "invoice.paid")) {
      await prisma.invoice.update({
        where: { id: event.invoiceId },
        data: { status: "PAID" },
      });
    }
    if (event.event === "customer.subscription.deleted" && event.invoiceId) {
      // no-op placeholder; subscription deletes handled separately when Stripe customer id is wired
    }
    return NextResponse.json({ received: true });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "webhook error" },
      { status: 400 },
    );
  }
}
