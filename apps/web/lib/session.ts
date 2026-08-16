import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";

export type SessionUser = {
  id: string;
  email?: string | null;
  name?: string | null;
  role: "CUSTOMER" | "ADMIN" | string;
};

export async function requireSession(): Promise<SessionUser> {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  const user = session.user as SessionUser;
  if (!user.id) redirect("/login");
  return user;
}

export async function requireAdmin(): Promise<SessionUser> {
  const user = await requireSession();
  if (user.role !== "ADMIN") redirect("/dashboard");
  return user;
}

export async function requireCustomer(): Promise<SessionUser> {
  const user = await requireSession();
  if (user.role === "ADMIN") {
    // Admins may inspect customer surfaces, but ownership checks still apply.
  }
  return user;
}

export function assertOwnership(resourceCustomerId: string, user: SessionUser) {
  if (user.role === "ADMIN") return;
  if (resourceCustomerId !== user.id) {
    throw new Error("FORBIDDEN");
  }
}
