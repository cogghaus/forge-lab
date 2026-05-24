import { Card, CardBody, Skeleton } from '@heroui/react';

export default function WorkspaceLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-2">
        <Skeleton className="h-4 w-20 rounded-lg" />
        <span className="text-default-400">/</span>
        <Skeleton className="h-7 w-36 rounded-lg" />
      </div>
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-20 rounded-lg" />
        <Skeleton className="h-9 w-28 rounded-lg" />
      </div>
      <div className="flex flex-col gap-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardBody className="flex flex-row items-center justify-between gap-4 py-3">
              <div className="flex flex-col gap-1.5 flex-1">
                <Skeleton className="h-4 w-64 rounded-lg" />
                <Skeleton className="h-3 w-32 rounded-lg" />
              </div>
              <Skeleton className="h-6 w-20 rounded-lg" />
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
