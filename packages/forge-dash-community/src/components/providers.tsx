'use client';

import { HeroUIProvider } from '@heroui/react';
import { Toaster } from 'sonner';

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <HeroUIProvider>
      {children}
      <Toaster
        theme="dark"
        richColors
        position="bottom-right"
        toastOptions={{
          style: {
            background: '#24242C',
            border: '1px solid rgba(255,255,255,0.06)',
            color: '#F5F0EB',
            fontFamily: 'var(--font-inter, system-ui)',
          },
        }}
      />
    </HeroUIProvider>
  );
}
