'use client';
// Client-only loader so dynamic({ ssr: false }) is valid in Next.js 15
// (ssr:false is only allowed inside 'use client' files)
import dynamic from 'next/dynamic';

export const ReassignDropdown = dynamic(
  () => import('./reassign-dropdown').then((m) => m.ReassignDropdown),
  { ssr: false },
);
