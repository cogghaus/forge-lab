import Link from 'next/link';
import { Button } from '@heroui/react';

export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center min-h-screen gap-4 text-center px-4">
      <h1 className="text-4xl font-bold">404</h1>
      <p className="text-default-500">Page not found.</p>
      <Button as={Link} href="/workspaces" color="primary" variant="flat">
        Go to Workspaces
      </Button>
    </div>
  );
}
