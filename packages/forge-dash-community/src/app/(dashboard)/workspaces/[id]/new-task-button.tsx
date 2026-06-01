'use client';

import { Modal, ModalContent, useDisclosure } from '@heroui/react';
import { useState } from 'react';
import { createTaskAction } from '@/actions/tasks';
import { derivePrefix } from '@/lib/task-prefix';
import { Field, fieldClass } from '@/lib/form-ui';
import type { HubGoal } from '@/lib/hub';
import { toast } from 'sonner';

// Priority as a colored segmented control — same hexes the kanban + task list use.
const PRIORITY_OPTS: { key: string; label: string; color: string; onColor: string }[] = [
  { key: 'low', label: 'Low', color: '#71717a', onColor: '#ffffff' },
  { key: 'normal', label: 'Normal', color: '#a1a1aa', onColor: '#18181b' },
  { key: 'high', label: 'High', color: '#FFB547', onColor: '#1A1A1F' },
  { key: 'urgent', label: 'Urgent', color: '#FF4757', onColor: '#ffffff' },
];

interface Props {
  workspaceId: string;
  workspaceSlug: string;
  goals: HubGoal[];
}

export function NewTaskButton({ workspaceId, workspaceSlug, goals }: Props) {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const [title, setTitle] = useState('');
  const [priority, setPriority] = useState('normal');
  const [goalId, setGoalId] = useState('');
  const [titleError, setTitleError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const projectPrefix = derivePrefix(workspaceSlug);

  const activeGoals = goals.filter((g) => g.status === 'active');

  function reset() {
    setTitle('');
    setPriority('normal');
    setGoalId('');
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
      fd.set('projectPrefix', projectPrefix);
      fd.set('priority', priority);
      if (goalId) fd.set('goalId', goalId);
      const descEl = e.currentTarget.elements.namedItem('description') as HTMLTextAreaElement | null;
      if (descEl) fd.set('description', descEl.value);

      const result = await createTaskAction(workspaceId, fd);
      if (result?.error) {
        setFormError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success('Task created');
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
        New Task
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
                <h2 className="text-lg font-semibold">Create task</h2>
                <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  Forge Master triages it and routes it to an agent.
                </p>
              </div>

              {/* Body */}
              <div className="flex flex-col gap-4 px-6 py-5">
                <Field label="Title" htmlFor="task-title" required error={titleError ?? undefined}>
                  <input
                    id="task-title"
                    name="title"
                    autoFocus
                    placeholder="What needs doing?"
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

                <Field label="Description" htmlFor="task-desc">
                  <textarea
                    id="task-desc"
                    name="description"
                    placeholder="Optional context, acceptance criteria, links."
                    rows={3}
                    disabled={isSubmitting}
                    className={`${fieldClass(false)} resize-y`}
                  />
                </Field>

                <div className="flex flex-col gap-1.5">
                  <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Priority</span>
                  <div className="grid grid-cols-4 gap-1.5">
                    {PRIORITY_OPTS.map((opt) => {
                      const selected = priority === opt.key;
                      return (
                        <button
                          key={opt.key}
                          type="button"
                          onClick={() => setPriority(opt.key)}
                          disabled={isSubmitting}
                          aria-pressed={selected}
                          className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                            selected
                              ? ''
                              : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600'
                          }`}
                          style={
                            selected
                              ? { background: opt.color, color: opt.onColor, borderColor: opt.color }
                              : undefined
                          }
                        >
                          {opt.label}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {activeGoals.length > 0 && (
                  <Field label="Link to goal" htmlFor="task-goal" hint="Groups the task under a goal in the kanban.">
                    <select
                      id="task-goal"
                      value={goalId}
                      onChange={(e) => setGoalId(e.target.value)}
                      disabled={isSubmitting}
                      className={fieldClass(false)}
                    >
                      <option value="">None</option>
                      {activeGoals.map((goal) => (
                        <option key={goal.id} value={goal.id}>
                          {goal.title}
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
                  Create task
                </button>
              </div>
            </form>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
