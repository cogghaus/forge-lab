function Block({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800 ${className ?? ''}`} />;
}

export default function TasksLoading() {
  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2">
        <Block className="h-4 w-20" />
        <span className="text-zinc-300 dark:text-zinc-700">/</span>
        <Block className="h-4 w-28" />
        <span className="text-zinc-300 dark:text-zinc-700">/</span>
        <Block className="h-7 w-14" />
      </div>

      {/* Count + button row */}
      <div className="flex items-center justify-between">
        <Block className="h-4 w-16" />
        <Block className="h-9 w-28" />
      </div>

      {/* Task list skeleton */}
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-xl border border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div className="flex flex-1 flex-col gap-1.5">
              <Block className="h-4 w-64" />
              <Block className="h-3 w-40" />
            </div>
            <Block className="h-6 w-20" />
          </div>
        ))}
      </div>
    </div>
  );
}
