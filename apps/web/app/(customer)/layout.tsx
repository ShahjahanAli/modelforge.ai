import { getServerSession } from "next-auth";
import { redirect } from "next/navigation";
import { authOptions } from "@/lib/auth";
import { AppShell } from "@/components/shell/AppShell";
import type { NavGroup } from "@/components/shell/SidebarNav";
import { ChatWidget } from "@/components/chat/ChatWidget";
import { chatModelsForSession } from "@/lib/chatModels";

export const dynamic = "force-dynamic";

const workspaceGroup: NavGroup = {
  heading: "Workspace",
  items: [
    { href: "/dashboard", label: "Usage", icon: "activity" },
    { href: "/chat", label: "Chat", icon: "chat" },
    { href: "/core-inspector", label: "Core Inspector", icon: "brain" },
    { href: "/requests", label: "Requests", icon: "timer" },
    { href: "/keys", label: "API Keys", icon: "key" },
    { href: "/models", label: "Models", icon: "boxes" },
    { href: "/billing", label: "Billing", icon: "card" },
  ],
};

const controlGroup: NavGroup = {
  heading: "Control",
  items: [
    { href: "/policies", label: "Policies", icon: "shield" },
    { href: "/budgets", label: "Budgets", icon: "wallet" },
    { href: "/reservations", label: "Reservations", icon: "server" },
    { href: "/reliability", label: "Reliability", icon: "gauge" },
    { href: "/knowledge", label: "Knowledge", icon: "book" },
    { href: "/usage/receipts", label: "Receipts", icon: "receipt" },
  ],
};

const operationsGroup: NavGroup = {
  heading: "Operations",
  items: [
    { href: "/admin/dashboard", label: "Overview", icon: "overview" },
    { href: "/admin/infra", label: "Infrastructure", icon: "server" },
    { href: "/admin/nodes", label: "Nodes", icon: "network" },
    { href: "/admin/models", label: "Model Registry", icon: "cpu" },
    { href: "/admin/policies", label: "Policies", icon: "shield" },
    { href: "/admin/slo", label: "SLOs", icon: "gauge" },
    { href: "/admin/evaluations", label: "Evaluations", icon: "flask" },
    { href: "/admin/audit", label: "Audit", icon: "scroll" },
    { href: "/admin/customers", label: "Customers", icon: "users" },
    { href: "/admin/revenue", label: "Revenue", icon: "chart" },
  ],
};

export default async function CustomerLayout({ children }: { children: React.ReactNode }) {
  const session = await getServerSession(authOptions);
  if (!session?.user) redirect("/login");
  const role = (session.user as { role?: string }).role;
  const groups =
    role === "ADMIN"
      ? [
          {
            ...workspaceGroup,
            items: workspaceGroup.items.filter((item) => item.href !== "/core-inspector"),
          },
          controlGroup,
          operationsGroup,
        ]
      : [workspaceGroup, controlGroup];
  const chatModels = await chatModelsForSession();

  return (
    <AppShell
      groups={groups}
      email={session.user.email ?? "unknown"}
      role={role}
      overlay={role !== "ADMIN" ? <ChatWidget models={chatModels} /> : null}
    >
      {children}
    </AppShell>
  );
}
