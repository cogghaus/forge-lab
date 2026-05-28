'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState } from 'react';

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

const PRESETS = [
  { label: '7d', days: 7 },
  { label: '30d', days: 30 },
  { label: '90d', days: 90 },
  { label: 'All time', days: null as number | null },
] as const;

/** Detect which preset matches the current from/to, or null for custom/unknown. */
function detectPreset(from: string | null, to: string | null): number | 'all' | null {
  if (!from && !to) return 'all';
  if (!from || !to) return null;
  const diffMs = new Date(to).getTime() - new Date(from).getTime();
  const days = Math.round(diffMs / (24 * 60 * 60 * 1000));
  if (days === 7 || days === 30 || days === 90) return days;
  return null; // custom
}

// ---------------------------------------------------------------------------
// DateRangePicker
// ---------------------------------------------------------------------------

interface Props {
  /** Additional Tailwind classes for the wrapper. */
  className?: string;
}

export default function DateRangePicker({ className }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const currentFrom = searchParams.get('from');
  const currentTo = searchParams.get('to');
  const activePreset = detectPreset(currentFrom, currentTo);

  const [showCustom, setShowCustom] = useState(activePreset === null);
  const [customFrom, setCustomFrom] = useState(
    currentFrom ? currentFrom.slice(0, 10) : '',
  );
  const [customTo, setCustomTo] = useState(
    currentTo ? currentTo.slice(0, 10) : '',
  );
  const [customError, setCustomError] = useState('');

  function applyPreset(days: number | null) {
    setShowCustom(false);
    setCustomError('');
    const params = new URLSearchParams(searchParams.toString());
    if (days === null) {
      params.delete('from');
      params.delete('to');
    } else {
      const now = new Date();
      const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
      params.set('from', from.toISOString());
      params.set('to', now.toISOString());
    }
    router.push(`${pathname}?${params.toString()}`);
  }

  function applyCustom() {
    setCustomError('');
    if (!customFrom || !customTo) {
      setCustomError('Both dates required.');
      return;
    }
    const fromMs = new Date(customFrom).getTime();
    const toMs = new Date(customTo + 'T23:59:59Z').getTime();
    if (isNaN(fromMs) || isNaN(toMs)) {
      setCustomError('Invalid date.');
      return;
    }
    if (fromMs >= toMs) {
      setCustomError('From must be before to.');
      return;
    }
    if (toMs - fromMs > 365 * 24 * 60 * 60 * 1000) {
      setCustomError('Max range is 365 days.');
      return;
    }
    const params = new URLSearchParams(searchParams.toString());
    params.set('from', new Date(customFrom).toISOString());
    params.set('to', new Date(customTo + 'T23:59:59Z').toISOString());
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <div className={className}>
      {/* Preset row */}
      <div
        className="flex gap-1 p-1 rounded-lg w-fit"
        style={{ background: 'rgba(255,255,255,0.04)' }}
      >
        {PRESETS.map(({ label, days }) => {
          const isActive =
            days === null ? activePreset === 'all' : activePreset === days;
          return (
            <button
              key={label}
              onClick={() => {
                if (days === null && !isActive) applyPreset(null);
                else if (days !== null && !isActive) applyPreset(days);
                // clicking active preset: no-op
              }}
              className="font-mono text-[11px] px-3 py-1 rounded-md transition-colors"
              style={
                isActive
                  ? { background: '#FF6B2B', color: '#fff' }
                  : { color: 'rgba(245,240,235,0.45)' }
              }
            >
              {label}
            </button>
          );
        })}
        <button
          onClick={() => setShowCustom((v) => !v)}
          className="font-mono text-[11px] px-3 py-1 rounded-md transition-colors"
          style={
            showCustom && activePreset === null
              ? { background: '#FF6B2B', color: '#fff' }
              : { color: 'rgba(245,240,235,0.45)' }
          }
        >
          Custom
        </button>
      </div>

      {/* Custom range row */}
      {showCustom && (
        <div className="flex items-center gap-2 mt-2">
          <input
            type="date"
            value={customFrom}
            onChange={(e) => setCustomFrom(e.target.value)}
            className="font-mono text-[11px] px-2 py-1 rounded"
            style={{
              background: 'rgba(255,255,255,0.07)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: 'rgba(245,240,235,0.8)',
              colorScheme: 'dark',
            }}
          />
          <span className="font-mono text-[11px]" style={{ color: 'rgba(245,240,235,0.3)' }}>
            to
          </span>
          <input
            type="date"
            value={customTo}
            onChange={(e) => setCustomTo(e.target.value)}
            className="font-mono text-[11px] px-2 py-1 rounded"
            style={{
              background: 'rgba(255,255,255,0.07)',
              border: '1px solid rgba(255,255,255,0.12)',
              color: 'rgba(245,240,235,0.8)',
              colorScheme: 'dark',
            }}
          />
          <button
            onClick={applyCustom}
            className="font-mono text-[11px] px-3 py-1 rounded transition-colors"
            style={{ background: '#FF6B2B', color: '#fff' }}
          >
            Apply
          </button>
          {customError && (
            <span className="font-mono text-[10px]" style={{ color: '#F87171' }}>
              {customError}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
