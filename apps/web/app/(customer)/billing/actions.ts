"use server";

import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { gatewayFetch } from "@/lib/gateway";

export async function checkoutInvoiceAction(formData: FormData) {
  const session = await getServerSession(authOptions);
  if (!session?.user) throw new Error("Unauthorized");
  const invoiceId = String(formData.get("invoiceId"));
  const checkout = await gatewayFetch(`/internal/invoices/${invoiceId}/checkout`, {
    method: "POST",
    body: JSON.stringify({ provider: "mock" }),
  });
  redirect(checkout.checkoutUrl as string);
}
