"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Boxes,
  BookOpen,
  BrainCircuit,
  CreditCard,
  Cpu,
  FlaskConical,
  Gauge,
  LayoutDashboard,
  KeyRound,
  LineChart,
  MessageSquare,
  Network,
  Receipt,
  ScrollText,
  Shield,
  Server,
  Timer,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: keyof typeof iconMap;
}

export interface NavGroup {
  heading: string;
  items: NavItem[];
}

const iconMap: Record<string, LucideIcon> = {
  overview: LayoutDashboard,
  activity: Activity,
  chat: MessageSquare,
  key: KeyRound,
  boxes: Boxes,
  card: CreditCard,
  server: Server,
  cpu: Cpu,
  users: Users,
  chart: LineChart,
  shield: Shield,
  wallet: Wallet,
  receipt: Receipt,
  timer: Timer,
  book: BookOpen,
  brain: BrainCircuit,
  network: Network,
  scroll: ScrollText,
  flask: FlaskConical,
  gauge: Gauge,
};

export function SidebarNav({
  groups,
  onNavigate,
}: {
  groups: NavGroup[];
  onNavigate?: () => void;
}) {
  const pathname = usePathname();

  return (
    <nav className="space-y-6">
      {groups.map((group) => (
        <div key={group.heading}>
          <p className="label-caps px-3 pb-2">{group.heading}</p>
          <ul className="space-y-0.5">
            {group.items.map((item) => {
              const Icon = iconMap[item.icon];
              const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    className={`group relative flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${
                      active
                        ? "bg-brand-50 font-medium text-brand-700"
                        : "text-content-secondary hover:bg-surface-2 hover:text-content-primary"
                    }`}
                  >
                    {active && (
                      <span className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-r-full bg-brand-600" />
                    )}
                    <Icon
                      className={`size-4 shrink-0 ${
                        active
                          ? "text-brand-600"
                          : "text-content-muted group-hover:text-content-secondary"
                      }`}
                      strokeWidth={2}
                      aria-hidden
                    />
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
