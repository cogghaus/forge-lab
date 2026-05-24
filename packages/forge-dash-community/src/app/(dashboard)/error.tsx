'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { Button } from '@heroui/react';

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function DashboardError({ error, reset }: Props) {
  useEffect(() => {
    // errors captured here are unexpected — log digest for triage
    if (error.digest) {
      // eslint-disable-next-line no-console
      console.error('Dashboard error digest:', error.digest);
    }
  }, [error]);

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
