import { Card, CardBody, Skeleton } from '@heroui/react';

export default function WorkspacesLoading() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-8 w-48 rounded-lg" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardBody className="flex flex-row items-center justify-between gap-4 py-4">
              <div className="flex flex-col gap-2 flex-1">
                <Skeleton className="h-5 w-48 rounded-lg" />
                <Skeleton className="h-4 w-64 rounded-lg" />
              </div>
              <Skeleton className="h-6 w-16 rounded-lg" />
            </CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
