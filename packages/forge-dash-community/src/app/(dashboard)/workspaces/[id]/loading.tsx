function Block({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800 ${className ?? ''}`} />;
}

export default function WorkspaceLoading() {
  return (
    <div className="flex flex-col gap-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Block className="h-4 w-20" />
          <span className="text-zinc-300 dark:text-zinc-700">/</span>
          <Block className="h-7 w-40" />
        </div>
        <Block className="h-9 w-28" />
      </div>

      {/* Stat strip */}
      <div className="flex items-center gap-7 rounded-lg border border-zinc-200 px-4 py-2.5 dark:border-zinc-800">
        {Array.from({ length: 5 }).map((_, i) => (
          <Block key={i} className="h-5 w-16" />
        ))}
      </div>

      {/* Kanban */}
      <Block className="h-[235px] w-full rounded-[10px]" />

      {/* Activity + devices */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1fr_260px]">
        <Block className="h-56 w-full" />
        <Block className="h-56 w-full" />
      </div>
    </div>
  );
}
