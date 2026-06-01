// Explicit, theme-agnostic form field styles — no HeroUI default-* tokens
// (those render fields white-on-white). Works in light and dark via Tailwind
// `dark:` variants; accent is the brand orange (#FF6B2B). Shared by the
// creation dialogs (new task, new goal, ...).

export const ACCENT = '#FF6B2B';

export const fieldBase =
  'w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors ' +
  'bg-white text-zinc-900 border-zinc-300 placeholder:text-zinc-400 ' +
  'dark:bg-zinc-900 dark:text-zinc-100 dark:border-zinc-700 dark:placeholder:text-zinc-500 ' +
  'focus:border-[#FF6B2B] focus:ring-1 focus:ring-[#FF6B2B]/40 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

const fieldErrorRing = 'border-red-500 dark:border-red-500 focus:border-red-500 focus:ring-red-500/40';

export function fieldClass(invalid?: boolean): string {
  return invalid ? `${fieldBase} ${fieldErrorRing}` : fieldBase;
}

export function Field({
  label,
  htmlFor,
  required,
  error,
  hint,
  children,
}: {
  label: string;
  htmlFor: string;
  required?: boolean;
  error?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-sm font-medium text-zinc-700 dark:text-zinc-200">
        {label}
        {required && <span style={{ color: ACCENT }}> *</span>}
      </label>
      {children}
      {error ? (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      ) : hint ? (
        <span className="text-xs text-zinc-500 dark:text-zinc-400">{hint}</span>
      ) : null}
    </div>
  );
}
