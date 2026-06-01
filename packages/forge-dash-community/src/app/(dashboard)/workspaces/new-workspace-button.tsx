'use client';

import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Textarea,
  useDisclosure,
} from '@heroui/react';
import { useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { createWorkspaceAction } from '@/actions/workspaces';
import { slugify } from '@/lib/slug';
import { toast } from 'sonner';

export function NewWorkspaceButton({ variant }: { variant?: 'inline' }) {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const router = useRouter();
  const searchParams = useSearchParams();

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [showRepo, setShowRepo] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Auto-open when arriving via ?new=1 (the left-rail / top-bar buttons link
  // here), then strip the param. Stripping re-runs this effect with new=null so
  // it opens exactly once per navigation, and a later ?new=1 reopens it.
  useEffect(() => {
    if (searchParams.get('new') === '1' && !isOpen) {
      onOpen();
      router.replace('/workspaces');
    }
  }, [searchParams, onOpen, router, isOpen]);

  function reset() {
    setName('');
    setSlug('');
    setSlugTouched(false);
    setShowRepo(false);
    setError(null);
  }

  const effectiveSlug = slugTouched ? slug : slugify(name);

  async function handleAction(formData: FormData) {
    setError(null);
    setIsSubmitting(true);
    try {
      // The Slug input is controlled with value={effectiveSlug}, so the derived
      // slug is already in formData; the action also falls back to slugify(name).
      const result = await createWorkspaceAction(formData);
      if (result?.error) {
        setError(result.error);
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

  function handleOpenChange(open: boolean) {
    if (!open) reset();
    onOpenChange();
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
                  A workspace groups tasks for a project. Optionally bind a git repo so its
                  agents open PRs.
                </span>
              </ModalHeader>
              <ModalBody className="flex flex-col gap-4">
                <Input
                  label="Name"
                  name="name"
                  placeholder="My Project"
                  value={name}
                  onValueChange={setName}
                  isRequired
                  autoFocus
                />
                <Input
                  label="Slug"
                  name="slug"
                  placeholder="my-project"
                  value={effectiveSlug}
                  onValueChange={(v) => {
                    setSlugTouched(true);
                    setSlug(v);
                  }}
                  description={
                    slugTouched
                      ? 'Lowercase letters, numbers, hyphens'
                      : 'Auto-derived from the name — edit to override'
                  }
                />
                <Textarea
                  label="Description"
                  name="description"
                  placeholder="Optional"
                  minRows={2}
                />

                {showRepo ? (
                  <div className="flex flex-col gap-4 rounded-lg border border-default-200 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium">Repo binding</span>
                      <Button
                        type="button"
                        size="sm"
                        variant="light"
                        onPress={() => setShowRepo(false)}
                      >
                        Remove
                      </Button>
                    </div>
                    <Input
                      label="Repo URL"
                      name="repoUrl"
                      placeholder="https://github.com/org/repo.git"
                      description="https only — worker agents check this out and open PRs"
                    />
                    <Input
                      label="Base branch"
                      name="repoBranch"
                      placeholder="main"
                      description="Branch PRs target (defaults to main)"
                    />
                  </div>
                ) : (
                  <Button
                    type="button"
                    variant="light"
                    size="sm"
                    className="self-start"
                    onPress={() => setShowRepo(true)}
                  >
                    + Connect a git repo (optional)
                  </Button>
                )}

                {error && <p className="text-danger text-sm">{error}</p>}
              </ModalBody>
              <ModalFooter>
                <Button type="button" variant="light" onPress={onClose} isDisabled={isSubmitting}>
                  Cancel
                </Button>
                <Button color="primary" type="submit" isLoading={isSubmitting}>
                  Create
                </Button>
              </ModalFooter>
            </form>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
