"use server";

import { redirect } from "next/navigation";
import { prisma } from "@modelforge/db";
import { gatewayFetch } from "@/lib/gateway";
import { requireSession, assertOwnership } from "@/lib/session";
import { writeAuditEvent } from "@/lib/audit";

export async function checkoutInvoiceAction(formData: FormData) {
  const user = await requireSession();
  const invoiceId = String(formData.get("invoiceId"));
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error("Invoice not found");
  assertOwnership(invoice.customerId, user);

  const checkout = await gatewayFetch(`/internal/invoices/${invoiceId}/checkout`, {
    method: "POST",
    body: JSON.stringify({ provider: "mock", customerId: user.id }),
  });
  await writeAuditEvent({
    actorType: "user",
    actorId: user.id,
    customerId: user.id,
    action: "invoice.checkout",
    resourceType: "Invoice",
    resourceId: invoiceId,
  });
  redirect(checkout.checkoutUrl as string);
}
