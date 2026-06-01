'use client';

import { Modal, ModalContent, useDisclosure } from '@heroui/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { createGoalAction } from '@/actions/goals';
import { Field, fieldClass } from '@/lib/form-ui';
import type { HubGoal } from '@/lib/hub';

interface Props {
  workspaceId: string;
  goals: HubGoal[];
}

export function NewGoalButton({ workspaceId, goals }: Props) {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const [title, setTitle] = useState('');
  const [parentId, setParentId] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  const activeGoals = goals.filter((g) => g.status === 'active');

  function reset() {
    setTitle('');
    setParentId('');
    setTitleError(null);
    setFormError(null);
  }

  function handleModalChange() {
    if (isOpen) reset();
    onOpenChange();
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    if (!title.trim()) {
      setTitleError('Title is required.');
      return;
    }
    setTitleError(null);
    setIsSubmitting(true);
    try {
      const fd = new FormData();
      fd.set('title', title.trim());
      if (parentId) fd.set('parentId', parentId);
      const descEl = e.currentTarget.elements.namedItem('description') as HTMLTextAreaElement | null;
      if (descEl) fd.set('description', descEl.value);

      const result = await createGoalAction(workspaceId, fd);
      if (result?.error) {
        setFormError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success('Goal created');
      reset();
      onOpenChange();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={onOpen}
        className="inline-flex items-center gap-2 rounded-md bg-[#FF6B2B] px-4 py-2 text-sm font-semibold text-white shadow-sm shadow-[#FF6B2B]/20 transition-colors hover:bg-[#e5531a]"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" className="h-4 w-4" aria-hidden>
          <path d="M12 5v14M5 12h14" />
        </svg>
        New Goal
      </button>

      <Modal
        isOpen={isOpen}
        onOpenChange={handleModalChange}
        size="lg"
        placement="center"
        scrollBehavior="inside"
        backdrop="blur"
        classNames={{
          base: 'bg-white dark:bg-zinc-950 text-zinc-900 dark:text-zinc-100',
          closeButton: 'text-zinc-400 hover:bg-zinc-100 dark:hover:bg-zinc-800',
        }}
      >
        <ModalContent>
          {(onClose) => (
            <form onSubmit={handleSubmit} noValidate>
              {/* Header */}
              <div className="px-6 pt-5 pb-3 border-b border-zinc-200 dark:border-zinc-800">
                <h2 className="text-lg font-semibold">Create goal</h2>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  Group tasks into a milestone and track progress.
                </p>
              </div>

              {/* Body */}
              <div className="flex flex-col gap-4 px-6 py-5">
                <Field label="Title" htmlFor="goal-title" required error={titleError ?? undefined}>
                  <input
                    id="goal-title"
                    name="title"
                    autoFocus
                    placeholder="What's the milestone?"
                    value={title}
                    onChange={(e) => {
                      setTitle(e.target.value);
                      if (titleError) setTitleError(null);
                      setFormError(null);
                    }}
                    disabled={isSubmitting}
                    className={fieldClass(!!titleError)}
                  />
                </Field>

                <Field label="Description" htmlFor="goal-desc">
                  <textarea
                    id="goal-desc"
                    name="description"
                    placeholder="Optional context or definition of done."
                    rows={3}
                    disabled={isSubmitting}
                    className={`${fieldClass(false)} resize-y`}
                  />
                </Field>

                {activeGoals.length > 0 && (
                  <Field label="Parent goal" htmlFor="goal-parent" hint="Nest this under an existing goal.">
                    <select
                      id="goal-parent"
                      value={parentId}
                      onChange={(e) => setParentId(e.target.value)}
                      disabled={isSubmitting}
                      className={fieldClass(false)}
                    >
                      <option value="">None (top-level goal)</option>
                      {activeGoals.map((g) => (
                        <option key={g.id} value={g.id}>
                          {g.title}
                        </option>
                      ))}
                    </select>
                  </Field>
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
                  Create goal
                </button>
              </div>
            </form>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
