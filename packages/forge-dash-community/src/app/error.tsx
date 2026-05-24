'use client';

import Link from 'next/link';
import { Button } from '@heroui/react';

interface Props {
  error: Error & { digest?: string };
  reset: () => void;
}

export default function RootError({ error: _error, reset }: Props) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 text-center px-4">
      <h1 className="text-3xl font-bold">Something went wrong</h1>
      <p className="text-default-500 text-sm">An unexpected error occurred.</p>
      <div className="flex gap-3">
        <Button color="primary" variant="flat" onPress={reset}>
          Try again
        </Button>
        <Button as={Link} href="/workspaces" variant="light">
          Go to Workspaces
        </Button>
      </div>
    </div>
  );
}
