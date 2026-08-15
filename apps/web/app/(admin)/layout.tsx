import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import type { NavGroup } from "@/components/shell/SidebarNav";

export const dynamic = "force-dynamic";

const groups: NavGroup[] = [
  {
    heading: "Workspace",
    items: [
      { href: "/dashboard", label: "Usage", icon: "activity" },
      { href: "/keys", label: "API Keys", icon: "key" },
      { href: "/models", label: "Models", icon: "boxes" },
      { href: "/billing", label: "Billing", icon: "card" },
    ],
  },
  {
    heading: "Operations",
    items: [
      { href: "/admin/infra", label: "Infrastructure", icon: "server" },
      { href: "/admin/models", label: "Model Registry", icon: "cpu" },
      { href: "/admin/customers", label: "Customers", icon: "users" },
      { href: "/admin/revenue", label: "Revenue", icon: "chart" },
    ],
  },
];

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  const role = (session.user as { role?: string }).role;
  if (role !== "ADMIN") redirect("/dashboard");

  return (
    <AppShell
      groups={groups}
      email={session.user.email ?? "unknown"}
      role={role}
      variant="admin"
    >
      {children}
    </AppShell>
  );
}
