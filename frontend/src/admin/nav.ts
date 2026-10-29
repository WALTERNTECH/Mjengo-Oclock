import { Bell, Gauge, IdCard, LayoutGrid, MessageSquare, Receipt, ScrollText, Settings, ShieldAlert, Siren, Tags, UserCog, Users, Wallet, Briefcase, ClipboardList, HardHat, Coins, Cog, type LucideIcon } from "lucide-react";

// The console's menu: Dashboard first, then groups that open like dropdowns. Each item lists
// the admin roles that may use it (owner sees everything); others are left out.

export type Role = "owner" | "admin" | "ops" | "finance";
export type NavItem = { to: string; label: string; icon: LucideIcon; roles?: Role[]; badge?: string };
export type NavGroup = { id: string; label: string; icon: LucideIcon; items: NavItem[] };

export const DASHBOARD: NavItem = { to: "/admin", label: "Dashboard", icon: Gauge };

export const GROUPS: NavGroup[] = [
  {
    id: "attention",
    label: "Needs attention",
    icon: Siren,
    items: [
      { to: "/admin/alerts", label: "Alerts", icon: Bell, badge: "alerts" },
      { to: "/admin/unassigned", label: "Unassigned bookings", icon: Siren, badge: "unassigned" },
      { to: "/admin/approvals", label: "Worker approvals", icon: IdCard, badge: "approvals" },
      { to: "/admin/disputes", label: "Disputes", icon: ShieldAlert, badge: "disputes" },
      { to: "/admin/reports", label: "Safety reports", icon: MessageSquare, badge: "reports" },
    ],
  },
  {
    id: "operations",
    label: "Jobs and people",
    icon: ClipboardList,
    items: [
      { to: "/admin/jobs", label: "Jobs", icon: ClipboardList, badge: "jobs" },
      { to: "/admin/workers", label: "Workers", icon: HardHat, badge: "workers" },
      { to: "/admin/people", label: "Clients and accounts", icon: Users },
    ],
  },
  {
    id: "money",
    label: "Money",
    icon: Coins,
    items: [
      { to: "/admin/payments", label: "Payments in", icon: Receipt, roles: ["admin", "finance"] },
      { to: "/admin/payouts", label: "Payouts and refunds", icon: Wallet, roles: ["admin", "finance"], badge: "payouts" },
    ],
  },
  {
    id: "catalogue",
    label: "Rates and policy",
    icon: Tags,
    items: [
      { to: "/admin/rates", label: "Trades and rates", icon: LayoutGrid },
      { to: "/admin/settings", label: "Fees and policies", icon: Settings },
    ],
  },
  {
    id: "system",
    label: "System",
    icon: Cog,
    items: [
      { to: "/admin/sms", label: "SMS log", icon: Briefcase },
      { to: "/admin/team", label: "Team and roles", icon: UserCog, roles: [] },
      { to: "/admin/audit", label: "Audit log", icon: ScrollText, roles: ["admin"] },
    ],
  },
];

/** Owner sees everything; an empty list means owner only; no list means everyone. */
export const allowed = (i: NavItem, role: Role) => role === "owner" || !i.roles || i.roles.includes(role);

const matches = (to: string, path: string) => (to === "/admin" ? path === "/admin" || path === "/admin/" : path === to || path.startsWith(`${to}/`));

/** The menu entry a path belongs to (detail pages belong to their list). */
export function findCurrent(path: string): { item: NavItem; group: NavGroup | null } | null {
  if (matches(DASHBOARD.to, path)) return { item: DASHBOARD, group: null };
  for (const g of GROUPS) for (const i of g.items) if (matches(i.to, path)) return { item: i, group: g };
  return null;
}
