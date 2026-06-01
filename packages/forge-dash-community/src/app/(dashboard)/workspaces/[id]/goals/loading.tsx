function Block({ className }: { className?: string }) {
  return <div className={`animate-pulse rounded-lg bg-zinc-200 dark:bg-zinc-800 ${className ?? ''}`} />;
}

export default function GoalsLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Block className="h-4 w-20" />
        <span className="text-zinc-300 dark:text-zinc-700">/</span>
        <Block className="h-4 w-28" />
        <span className="text-zinc-300 dark:text-zinc-700">/</span>
        <Block className="h-7 w-16" />
      </div>
      <div className="flex items-center gap-4 border-b border-zinc-200 pb-2 dark:border-zinc-800">
        <Block className="h-4 w-10" />
        <Block className="h-4 w-12" />
      </div>
      <div className="flex items-center justify-between">
        <Block className="h-4 w-16" />
        <Block className="h-9 w-28" />
      </div>
      <div className="flex flex-col gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 rounded-xl border border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div className="flex flex-1 flex-col gap-1.5">
              <Block className="h-4 w-56" />
              <Block className="h-3 w-40" />
            </div>
            <Block className="h-6 w-16" />
            <Block className="h-8 w-8" />
          </div>
        ))}
      </div>
    </div>
  );
}
