function Block({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800 ${className ?? ''}`} />;
}

export default function TaskDetailLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-2">
        <Block className="h-4 w-20" />
        <span className="text-zinc-300 dark:text-zinc-700">/</span>
        <Block className="h-4 w-28" />
        <span className="text-zinc-300 dark:text-zinc-700">/</span>
        <Block className="h-4 w-32" />
      </div>
      <div className="flex flex-col gap-3 rounded-xl border border-zinc-200 p-5 dark:border-zinc-800">
        <div className="flex items-start justify-between gap-4">
          <Block className="h-6 w-72" />
          <div className="flex shrink-0 items-center gap-2">
            <Block className="h-6 w-20" />
            <Block className="h-8 w-20" />
          </div>
        </div>
        <Block className="h-4 w-full" />
        <Block className="h-4 w-3/4" />
        <div className="flex gap-4 border-t border-zinc-100 pt-2 dark:border-zinc-800">
          <Block className="h-3 w-28" />
          <Block className="h-3 w-32" />
        </div>
      </div>
      <div className="flex flex-col gap-3">
        <Block className="h-4 w-16" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-zinc-200 dark:bg-zinc-700" />
              <div className="mt-1 w-px flex-1 bg-zinc-100 dark:bg-zinc-800" />
            </div>
            <div className="flex flex-1 flex-col gap-1.5 pb-4">
              <Block className="h-4 w-40" />
              <Block className="h-3 w-56" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
