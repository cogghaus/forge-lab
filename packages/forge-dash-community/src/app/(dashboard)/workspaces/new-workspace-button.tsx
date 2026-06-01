'use client';

import {
  Button,
  Chip,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
  useDisclosure,
} from '@heroui/react';
import { useEffect, useRef, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  createWorkspaceAction,
  type WorkspaceErrorField,
} from '@/actions/workspaces';
import { slugify } from '@/lib/slug';
import { toast } from 'sonner';

type FieldErrors = Partial<Record<Exclude<WorkspaceErrorField, 'form'>, string>>;

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

  // Auto-open when arriving via ?new=1 (the left-rail / top-bar buttons link
  // here), then strip the param. Stripping re-runs this effect with new=null so
  // it opens exactly once per navigation, and a later ?new=1 reopens it.
  useEffect(() => {
    if (searchParams.get('new') === '1' && !isOpen) {
      onOpen();
      router.replace('/workspaces');
    }
  }, [searchParams, onOpen, router, isOpen]);

  // Move focus into the repo section when it opens, and back to the trigger when
  // it's removed (don't fire on the first render before any toggle).
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

  /** Clear a field's error (and any form-level error) as the user edits it. */
  function clearError(field: keyof FieldErrors) {
    setFormError(null);
    setFieldErrors((e) => (e[field] ? { ...e, [field]: undefined } : e));
  }

  /** Client-side validation — catch the obvious problems before a round-trip. */
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

  async function handleAction(formData: FormData) {
    setFormError(null);
    const clientErrs = validate();
    if (Object.keys(clientErrs).length > 0) {
      setFieldErrors(clientErrs);
      return;
    }
    setFieldErrors({});
    setIsSubmitting(true);
    try {
      const result = await createWorkspaceAction(formData);
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

  function handleOpenChange() {
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

      <Modal isOpen={isOpen} onOpenChange={handleOpenChange} size="lg">
        <ModalContent>
          {(onClose) => (
            <form action={handleAction}>
              <ModalHeader className="flex flex-col gap-0.5">
                <span>Create workspace</span>
                <span className="text-xs font-normal text-default-400">
                  Groups tasks for a project.
                </span>
              </ModalHeader>
              <ModalBody className="flex flex-col gap-4">
                <Input
                  label="Name"
                  labelPlacement="outside"
                  name="name"
                  placeholder="My Project"
                  value={name}
                  onValueChange={(v) => {
                    setName(v);
                    clearError('name');
                  }}
                  isRequired
                  autoFocus
                  isDisabled={isSubmitting}
                  isInvalid={!!fieldErrors.name}
                  errorMessage={fieldErrors.name}
                />
                <Input
                  label="Slug"
                  labelPlacement="outside"
                  name="slug"
                  placeholder="my-project"
                  value={effectiveSlug}
                  onValueChange={(v) => {
                    setSlugTouched(true);
                    setSlug(v);
                    clearError('slug');
                  }}
                  isDisabled={isSubmitting}
                  isInvalid={!!fieldErrors.slug}
                  errorMessage={fieldErrors.slug}
                  startContent={
                    !slugTouched && effectiveSlug ? (
                      <Chip size="sm" variant="flat" className="h-5 text-[10px] text-default-500">
                        auto
                      </Chip>
                    ) : undefined
                  }
                  endContent={
                    slugTouched ? (
                      <button
                        type="button"
                        onClick={() => {
                          setSlugTouched(false);
                          setSlug('');
                          clearError('slug');
                        }}
                        className="text-[11px] text-default-400 hover:text-primary transition-colors"
                        aria-label="Reset slug to auto-derived from the name"
                      >
                        ↺ auto
                      </button>
                    ) : undefined
                  }
                  description={
                    slugTouched
                      ? 'Lowercase letters, numbers, hyphens.'
                      : 'Auto-derived from the name — edit to override.'
                  }
                />
                <Textarea
                  label="Description"
                  labelPlacement="outside"
                  name="description"
                  placeholder="Optional"
                  minRows={2}
                  isDisabled={isSubmitting}
                />

                {showRepo ? (
                  <div className="flex flex-col gap-4 rounded-lg border border-primary/40 bg-primary/5 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium flex items-center gap-2">
                        <span aria-hidden>⎇</span> Git repo
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="light"
                        onPress={removeRepo}
                        isDisabled={isSubmitting}
                      >
                        Remove
                      </Button>
                    </div>
                    <p className="text-xs text-default-400 -mt-2">
                      This workspace&apos;s agents check out the repo, branch per task, and open PRs.
                    </p>
                    <Input
                      ref={repoUrlRef}
                      label="Repo URL"
                      labelPlacement="outside"
                      name="repoUrl"
                      placeholder="https://github.com/org/repo.git"
                      value={repoUrl}
                      onValueChange={(v) => {
                        setRepoUrl(v);
                        clearError('repoUrl');
                      }}
                      isDisabled={isSubmitting}
                      isInvalid={!!fieldErrors.repoUrl}
                      errorMessage={fieldErrors.repoUrl}
                      description={fieldErrors.repoUrl ? undefined : 'https only.'}
                    />
                    <Input
                      label="Base branch"
                      labelPlacement="outside"
                      name="repoBranch"
                      placeholder="main"
                      value={repoBranch}
                      onValueChange={(v) => {
                        setRepoBranch(v);
                        clearError('repoBranch');
                      }}
                      isDisabled={isSubmitting}
                      isInvalid={!!fieldErrors.repoBranch}
                      errorMessage={fieldErrors.repoBranch}
                      description={fieldErrors.repoBranch ? undefined : 'Branch PRs target (defaults to main).'}
                    />
                  </div>
                ) : (
                  <Button
                    ref={connectTriggerRef}
                    type="button"
                    variant="bordered"
                    fullWidth
                    onPress={openRepo}
                    isDisabled={isSubmitting}
                    className="h-auto justify-start gap-3 whitespace-normal py-3 border-default-300 hover:border-primary/50"
                  >
                    <span className="text-lg" aria-hidden>⎇</span>
                    <span className="flex flex-1 flex-col items-start gap-0.5">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        Connect a git repo
                        <Chip size="sm" variant="flat" className="h-5 text-[10px] text-default-500">
                          optional
                        </Chip>
                      </span>
                      <span className="text-xs text-default-400 text-left">
                        Let this workspace&apos;s agents check out the code and open PRs.
                      </span>
                    </span>
                  </Button>
                )}

                {formError && (
                  <p role="alert" aria-live="polite" className="text-danger text-sm">
                    {formError}
                  </p>
                )}
              </ModalBody>
              <ModalFooter>
                <Button type="button" variant="light" onPress={onClose} isDisabled={isSubmitting}>
                  Cancel
                </Button>
                <Button color="primary" type="submit" isLoading={isSubmitting}>
                  {showRepo && repoUrl.trim() ? 'Create & connect repo' : 'Create'}
                </Button>
              </ModalFooter>
            </form>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
