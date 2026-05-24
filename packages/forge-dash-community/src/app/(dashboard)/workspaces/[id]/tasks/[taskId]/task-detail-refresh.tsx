'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useTransition } from 'react';

export function TaskDetailRefresh() {
  const router = useRouter();
  const [, startTransition] = useTransition();

  useEffect(() => {
    const id = setInterval(() => startTransition(() => router.refresh()), 5000);
    return () => clearInterval(id);
  }, [router]);

  return null;
}
