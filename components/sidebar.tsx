"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Activity, CheckSquare, Kanban, LayoutDashboard, LogOut, Mail, Plug, Users, Workflow } from "lucide-react";
import { logout } from "@/app/(auth)/actions";
import { cn } from "@/lib/utils";
import type { Role } from "@/types";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/contacts", label: "Contacts", icon: Users },
  { href: "/pipeline", label: "Pipeline", icon: Kanban },
  { href: "/tasks", label: "Tasks", icon: CheckSquare },
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/email", label: "Email", icon: Mail },
  { href: "/integrations", label: "Integrations", icon: Plug },
];

export function Sidebar({ userName, role, demo = false }: { userName: string; role: Role; demo?: boolean }) {
  const pathname = usePathname();

  return (
    <aside className="flex w-full shrink-0 flex-col border-b border-slate-200 bg-white md:h-screen md:w-60 md:border-b-0 md:border-r">
      <div className="flex items-center gap-2 px-5 py-4 text-lg font-semibold">
        <Workflow className="h-5 w-5 text-indigo-600" /> FlowCRM
        {demo && (
          <span
            className="ml-auto rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-800"
            title="Demo mode: Qualified follow-ups are due in 30 seconds and the scheduler runs every 10 seconds"
          >
            Demo
          </span>
        )}
      </div>
      <nav className="flex gap-1 overflow-x-auto px-3 pb-2 md:flex-1 md:flex-col md:pb-0">
        {NAV.map(({ href, label, icon: Icon }) => {
          const active = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium",
                active ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100",
              )}
            >
              <Icon className="h-4 w-4" /> {label}
            </Link>
          );
        })}
      </nav>
      <div className="flex items-center justify-between gap-2 border-t border-slate-200 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-700" title={userName}>
            {userName}
          </p>
          <p className="text-xs capitalize text-slate-400">{role}</p>
        </div>
        <form action={logout}>
          <button type="submit" className="btn-secondary !px-2 !py-1.5" aria-label="Log out" title="Log out">
            <LogOut className="h-4 w-4" />
          </button>
        </form>
      </div>
    </aside>
  );
}
