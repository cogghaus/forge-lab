import { Card, CardBody, Skeleton } from '@heroui/react';

export default function TaskDetailLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2 flex-wrap">
        <Skeleton className="h-4 w-20 rounded-lg" />
        <span className="text-default-400">/</span>
        <Skeleton className="h-4 w-28 rounded-lg" />
        <span className="text-default-400">/</span>
        <Skeleton className="h-4 w-32 rounded-lg" />
      </div>
      <Card>
        <CardBody className="flex flex-col gap-3">
          <div className="flex items-start justify-between gap-4">
            <Skeleton className="h-6 w-72 rounded-lg" />
            <div className="flex items-center gap-2 shrink-0">
              <Skeleton className="h-6 w-20 rounded-lg" />
              <Skeleton className="h-8 w-20 rounded-lg" />
            </div>
          </div>
          <Skeleton className="h-4 w-full rounded-lg" />
          <Skeleton className="h-4 w-3/4 rounded-lg" />
          <div className="flex gap-4 pt-1 border-t border-default-100">
            <Skeleton className="h-3 w-28 rounded-lg" />
            <Skeleton className="h-3 w-32 rounded-lg" />
          </div>
        </CardBody>
      </Card>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-4 w-16 rounded-lg" />
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <div className="flex flex-col items-center">
              <div className="w-2 h-2 rounded-full bg-default-200 mt-1.5 shrink-0" />
              <div className="w-px flex-1 bg-default-100 mt-1" />
            </div>
            <div className="pb-4 flex-1 flex flex-col gap-1.5">
              <Skeleton className="h-4 w-40 rounded-lg" />
              <Skeleton className="h-3 w-56 rounded-lg" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
