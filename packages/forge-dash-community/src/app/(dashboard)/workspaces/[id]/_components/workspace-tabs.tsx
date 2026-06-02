'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

interface Tab {
  key: string;
  label: string;
  /** Path segment after the workspace base; '' = the overview tab. */
  seg: string;
  disabled?: boolean;
}

const TABS: Tab[] = [
  { key: 'overview', label: 'Overview', seg: '' },
  { key: 'tasks', label: 'Tasks', seg: 'tasks' },
  { key: 'goals', label: 'Goals', seg: 'goals' },
  { key: 'triage', label: 'Triage', seg: 'triage' },
  { key: 'knowledge', label: 'Knowledge', seg: 'knowledge' },
  { key: 'analytics', label: 'Analytics', seg: 'analytics' },
  { key: 'members', label: 'Members', seg: 'members', disabled: true },
  { key: 'settings', label: 'Settings', seg: 'settings' },
];

export function WorkspaceTabs({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const base = `/workspaces/${workspaceId}`;

  function isActive(seg: string): boolean {
    if (seg === '') return pathname === base;
    return pathname === `${base}/${seg}` || pathname.startsWith(`${base}/${seg}/`);
  }

  return (
    <nav
      className="flex flex-wrap items-center gap-1 border-b border-zinc-200 dark:border-zinc-800"
      aria-label="Workspace sections"
    >
      {TABS.map((tab) => {
        if (tab.disabled) {
          return (
            <span
              key={tab.key}
              aria-disabled="true"
              title="Coming soon"
              className="cursor-not-allowed px-3 py-2 text-sm font-medium text-zinc-300 dark:text-zinc-600"
            >
              {tab.label}
            </span>
          );
        }
        const active = isActive(tab.seg);
        return (
          <Link
            key={tab.key}
            href={tab.seg === '' ? base : `${base}/${tab.seg}`}
            aria-current={active ? 'page' : undefined}
            className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition-colors ${
              active
                ? 'border-[#FF6B2B] text-[#FF6B2B]'
                : 'border-transparent text-zinc-500 hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
