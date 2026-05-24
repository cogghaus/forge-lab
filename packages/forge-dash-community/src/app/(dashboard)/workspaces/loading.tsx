import { Card, CardBody, Skeleton } from '@heroui/react';

export default function WorkspacesLoading() {
  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <Skeleton className="h-8 w-32 rounded-lg" />
          <Skeleton className="h-4 w-56 rounded-lg" />
        </div>
        <Skeleton className="h-9 w-36 rounded-lg" />
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i} className="h-full">
            <CardBody className="gap-1.5">
              <Skeleton className="h-5 w-36 rounded-lg" />
              <Skeleton className="h-3 w-24 rounded-lg" />
              <Skeleton className="h-4 w-48 rounded-lg mt-1" />
              <Skeleton className="h-3 w-16 rounded-lg mt-2" />
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
