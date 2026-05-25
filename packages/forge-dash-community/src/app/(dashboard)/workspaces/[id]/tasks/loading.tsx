import { Card, CardBody, Skeleton } from '@heroui/react';

export default function TasksLoading() {
  return (
    <div className="flex flex-col gap-6">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-20 rounded-lg" />
        <span className="text-default-400">/</span>
        <Skeleton className="h-4 w-28 rounded-lg" />
        <span className="text-default-400">/</span>
        <Skeleton className="h-7 w-12 rounded-lg" />
      </div>

      {/* Count + button row */}
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-16 rounded-lg" />
        <Skeleton className="h-9 w-28 rounded-lg" />
      </div>

      {/* Task list skeleton */}
      <div className="flex flex-col gap-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardBody className="flex flex-row items-center gap-3 py-3">
              <div className="flex-1 flex flex-col gap-1.5">
                <Skeleton className="h-4 w-64 rounded-lg" />
                <Skeleton className="h-3 w-40 rounded-lg" />
              </div>
              <Skeleton className="h-6 w-20 rounded-lg" />
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
