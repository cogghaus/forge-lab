'use client';

import Link from 'next/link';
import { Button } from '@heroui/react';

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({ error: _error, reset }: Props) {
  return (
    <div className="flex flex-col items-center justify-center py-24 gap-4 text-center">
      <h2 className="text-2xl font-bold">Something went wrong</h2>
      <p className="text-default-500 text-sm">An unexpected error occurred.</p>
      <div className="flex gap-3">
        <Button color="primary" variant="flat" onPress={reset}>
          Try again
        </Button>
        <Button as={Link} href="/workspaces" variant="light">
          Back to Workspaces
        </Button>
      </div>
    </div>
  );
}
