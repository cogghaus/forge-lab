'use client';

import { Button, Modal, ModalContent, useDisclosure } from '@heroui/react';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  createWorkspaceAction,
  type WorkspaceErrorField,
} from '@/actions/workspaces';
import { slugify } from '@/lib/slug';
import { toast } from 'sonner';

type FieldErrors = Partial<Record<Exclude<WorkspaceErrorField, 'form'>, string>>;

// Explicit, theme-agnostic styles — no HeroUI default-* tokens (those rendered
// inputs as white boxes on the dark surface). Works in both light and dark via
// Tailwind `dark:` variants; accent is the brand orange (#FF6B2B).
const ACCENT = '#FF6B2B';
const fieldBase =
  'w-full rounded-md border px-3 py-2 text-sm outline-none transition-colors ' +
  'bg-white text-zinc-900 border-zinc-300 placeholder:text-zinc-400 ' +
  'dark:bg-zinc-900 dark:text-zinc-100 dark:border-zinc-700 dark:placeholder:text-zinc-500 ' +
  'focus:border-[#FF6B2B] focus:ring-1 focus:ring-[#FF6B2B]/40 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';
const fieldErrorRing = 'border-red-500 dark:border-red-500 focus:border-red-500 focus:ring-red-500/40';

function fieldClass(invalid?: boolean): string {
  return invalid ? `${fieldBase} ${fieldErrorRing}` : fieldBase;
}

function Field({
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

function GitBranchIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="6" cy="18" r="2.5" />
      <circle cx="18" cy="7" r="2.5" />
      <path d="M6 8.5v7" />
      <path d="M18 9.5a6 6 0 0 1-6 6H6" />
    </svg>
  );
}

export function NewWorkspaceButton({ variant }: { variant?: 'inline' }) {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [showRepo, setShowRepo] = useState(false);
  const [repoUrl, setRepoUrl] = useState('');
  const [repoBranch, setRepoBranch] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const connectTriggerRef = useRef<HTMLButtonElement>(null);
  const repoUrlRef = useRef<HTMLInputElement>(null);
  const repoToggledOnce = useRef(false);

  // Auto-open when arriving via ?new=1 (rail / top-bar buttons link here), then
  // strip the param so it opens once per navigation and a later ?new=1 reopens.
  useEffect(() => {
    if (searchParams.get('new') === '1' && !isOpen) {
      onOpen();
      router.replace('/workspaces');
    }
  }, [searchParams, onOpen, router, isOpen]);

  // Focus into the repo section when it opens, back to the trigger when removed.
  useEffect(() => {
    if (!repoToggledOnce.current) return;
    if (showRepo) repoUrlRef.current?.focus();
    else connectTriggerRef.current?.focus();
  }, [showRepo]);

  function reset() {
    setName('');
    setSlug('');
    setSlugTouched(false);
    setShowRepo(false);
    setRepoUrl('');
    setRepoBranch('');
    setFieldErrors({});
    setFormError(null);
    repoToggledOnce.current = false;
  }

  const effectiveSlug = slugTouched ? slug : slugify(name);

  function clearError(field: keyof FieldErrors) {
    setFormError(null);
    setFieldErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));
  }

  function validate(): FieldErrors {
    const errs: FieldErrors = {};
    if (!name.trim()) errs.name = 'Name is required.';
    if (!effectiveSlug) errs.slug = 'Add a slug.';
    if (showRepo) {
      const url = repoUrl.trim();
      if (url && !/^https:\/\//i.test(url)) errs.repoUrl = 'Must be an https:// URL.';
      if (repoBranch.trim() && !url) errs.repoUrl = 'Add a repo URL, or clear the branch.';
    }
    return errs;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    const clientErrs = validate();
    if (Object.keys(clientErrs).length > 0) {
      setFieldErrors(clientErrs);
      return;
    }
    setFieldErrors({});
    setIsSubmitting(true);
    try {
      const fd = new FormData();
      fd.set('name', name.trim());
      fd.set('slug', effectiveSlug);
      fd.set('description', '');
      const descEl = (e.currentTarget.elements.namedItem('description') as HTMLTextAreaElement | null);
      if (descEl) fd.set('description', descEl.value);
      if (showRepo) {
        fd.set('repoUrl', repoUrl.trim());
        fd.set('repoBranch', repoBranch.trim());
      }
      const result = await createWorkspaceAction(fd);
      if (result?.error) {
        if (result.field && result.field !== 'form') {
          setFieldErrors({ [result.field]: result.error });
        } else {
          setFormError(result.error);
        }
        toast.error(result.error);
        return;
      }
      toast.success('Workspace created');
      reset();
      onOpenChange();
      if (result?.id) router.push(`/workspaces/${result.id}`);
      else router.refresh();
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleModalChange() {
    if (isOpen) reset();
    onOpenChange();
  }

  function openRepo() {
    repoToggledOnce.current = true;
    setShowRepo(true);
  }

  function removeRepo() {
    repoToggledOnce.current = true;
    setShowRepo(false);
    setRepoUrl('');
    setRepoBranch('');
    setFieldErrors((e) => ({ ...e, repoUrl: undefined, repoBranch: undefined }));
  }

  return (
    <>
      <Button
        color="primary"
        variant={variant === 'inline' ? 'flat' : 'solid'}
        onPress={onOpen}
      >
        New Workspace
      </Button>

      <Modal
        isOpen={isOpen}
        onOpenChange={handleModalChange}
        size="lg"
        backdrop="blur"
        classNames={{
          // Own the surface explicitly so it's correct on any theme.
          base: 'bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100',
          closeButton: 'text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800',
        }}
      >
        <ModalContent>
          {(onClose) => (
            <form onSubmit={handleSubmit} noValidate>
              {/* Header */}
              <div className="px-6 pt-5 pb-3 border-b border-zinc-200 dark:border-zinc-800">
                <h2 className="text-lg font-semibold">Create workspace</h2>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  Groups tasks for a project.
                </p>
              </div>

              {/* Body */}
              <div className="flex flex-col gap-4 px-6 py-5">
                <Field label="Name" htmlFor="ws-name" required error={fieldErrors.name}>
                  <input
                    id="ws-name"
                    name="name"
                    autoFocus
                    placeholder="My Project"
                    value={name}
                    onChange={(e) => {
                      setName(e.target.value);
                      clearError('name');
                    }}
                    disabled={isSubmitting}
                    className={fieldClass(!!fieldErrors.name)}
                  />
                </Field>

                <Field
                  label="Slug"
                  htmlFor="ws-slug"
                  error={fieldErrors.slug}
                  hint={slugTouched ? 'Lowercase letters, numbers, hyphens.' : 'Auto-derived from the name — edit to override.'}
                >
                  <div className="relative">
                    <input
                      id="ws-slug"
                      name="slug"
                      placeholder="my-project"
                      value={effectiveSlug}
                      onChange={(e) => {
                        setSlugTouched(true);
                        setSlug(e.target.value);
                        clearError('slug');
                      }}
                      disabled={isSubmitting}
                      className={`${fieldClass(!!fieldErrors.slug)} ${slugTouched ? 'pr-16' : 'pr-14'}`}
                    />
                    <span className="absolute inset-y-0 right-2 flex items-center">
                      {slugTouched ? (
                        <button
                          type="button"
                          onClick={() => {
                            setSlugTouched(false);
                            setSlug('');
                            clearError('slug');
                          }}
                          className="text-[11px] text-zinc-500 hover:text-[#FF6B2B] transition-colors"
                          aria-label="Reset slug to auto-derived from the name"
                        >
                          ↺ auto
                        </button>
                      ) : (
                        effectiveSlug && (
                          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                            auto
                          </span>
                        )
                      )}
                    </span>
                  </div>
                </Field>

                <Field label="Description" htmlFor="ws-desc">
                  <textarea
                    id="ws-desc"
                    name="description"
                    placeholder="Optional"
                    rows={2}
                    disabled={isSubmitting}
                    className={`${fieldClass(false)} resize-y`}
                  />
                </Field>

                {showRepo ? (
                  <div className="flex flex-col gap-4 rounded-lg border border-[#FF6B2B]/40 bg-[#FF6B2B]/[0.06] p-3.5">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <GitBranchIcon className="h-4 w-4 text-[#FF6B2B]" />
                        Git repo
                      </span>
                      <button
                        type="button"
                        onClick={removeRepo}
                        disabled={isSubmitting}
                        className="text-xs text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors disabled:opacity-50"
                      >
                        Remove
                      </button>
                    </div>
                    <p className="-mt-1 text-xs text-zinc-500 dark:text-zinc-400">
                      This workspace&apos;s agents check out the repo, branch per task, and open PRs.
                    </p>
                    <Field
                      label="Repo URL"
                      htmlFor="ws-repo-url"
                      error={fieldErrors.repoUrl}
                      hint="https only."
                    >
                      <input
                        id="ws-repo-url"
                        ref={repoUrlRef}
                        name="repoUrl"
                        placeholder="https://github.com/org/repo.git"
                        value={repoUrl}
                        onChange={(e) => {
                          setRepoUrl(e.target.value);
                          clearError('repoUrl');
                        }}
                        disabled={isSubmitting}
                        className={fieldClass(!!fieldErrors.repoUrl)}
                      />
                    </Field>
                    <Field
                      label="Base branch"
                      htmlFor="ws-repo-branch"
                      error={fieldErrors.repoBranch}
                      hint="Branch PRs target (defaults to main)."
                    >
                      <input
                        id="ws-repo-branch"
                        name="repoBranch"
                        placeholder="main"
                        value={repoBranch}
                        onChange={(e) => {
                          setRepoBranch(e.target.value);
                          clearError('repoBranch');
                        }}
                        disabled={isSubmitting}
                        className={fieldClass(!!fieldErrors.repoBranch)}
                      />
                    </Field>
                  </div>
                ) : (
                  <button
                    ref={connectTriggerRef}
                    type="button"
                    onClick={openRepo}
                    disabled={isSubmitting}
                    className="flex w-full items-center gap-3 rounded-lg border border-dashed px-3.5 py-3 text-left transition-colors border-zinc-300 hover:border-[#FF6B2B]/60 hover:bg-[#FF6B2B]/[0.04] dark:border-zinc-700 disabled:opacity-50"
                  >
                    <GitBranchIcon className="h-5 w-5 shrink-0 text-[#FF6B2B]" />
                    <span className="flex flex-1 flex-col gap-0.5">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        Connect a git repo
                        <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
                          optional
                        </span>
                      </span>
                      <span className="text-xs text-zinc-500 dark:text-zinc-400">
                        Let this workspace&apos;s agents check out the code and open PRs.
                      </span>
                    </span>
                  </button>
                )}

                {formError && (
                  <p role="alert" aria-live="polite" className="text-sm text-red-600 dark:text-red-400">
                    {formError}
                  </p>
                )}
              </div>

              {/* Footer */}
              <div className="flex items-center justify-end gap-2 border-t border-zinc-200 px-6 py-4 dark:border-zinc-800">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isSubmitting}
                  className="rounded-md px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800 disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="inline-flex items-center gap-2 rounded-md bg-[#FF6B2B] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#e5531a] disabled:opacity-60"
                >
                  {isSubmitting && (
                    <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white" />
                  )}
                  {showRepo && repoUrl.trim() ? 'Create & connect repo' : 'Create'}
                </button>
              </div>
            </form>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
