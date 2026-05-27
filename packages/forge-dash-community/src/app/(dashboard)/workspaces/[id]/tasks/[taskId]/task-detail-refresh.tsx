'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function TaskDetailRefresh() {
  const router = useRouter();

  useEffect(() => {
    const id = setInterval(() => router.refresh(), 5000);
    return () => clearInterval(id);
  }, [router]);

  return null;
}
