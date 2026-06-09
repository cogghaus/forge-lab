'use client';

import { Modal, ModalContent, useDisclosure } from '@heroui/react';
import { useState } from 'react';
import { createTaskAction } from '@/actions/tasks';
import { derivePrefix } from '@/lib/task-prefix';
import { Field, fieldClass } from '@/lib/form-ui';
import type { HubGoal } from '@/lib/hub';
import { toast } from 'sonner';

const PRIORITY_OPTS: { key: string; label: string; color: string; onColor: string }[] = [
  { key: 'low', label: 'Low', color: '#71717a', onColor: '#ffffff' },
  { key: 'normal', label: 'Normal', color: '#a1a1aa', onColor: '#18181b' },
  { key: 'high', label: 'High', color: '#FFB547', onColor: '#1A1A1F' },
  { key: 'urgent', label: 'Urgent', color: '#FF4757', onColor: '#ffffff' },
];

const REVIEWER_OPTS = [
  { key: 'temper', label: 'Temper', desc: 'code quality' },
  { key: 'loki', label: 'Loki', desc: 'adversarial' },
  { key: 'crucible', label: 'Crucible', desc: 'pressure test' },
  { key: 'aegis', label: 'Aegis', desc: 'security' },
  { key: 'architect', label: 'Architect', desc: 'design & arch' },
  { key: 'oracle', label: 'Oracle', desc: 'strategic analysis' },
];

const TARGET_OPTS: { key: 'diff' | 'branch' | 'pr'; label: string }[] = [
  { key: 'diff', label: 'Diff' },
  { key: 'branch', label: 'Branch' },
  { key: 'pr', label: 'PR' },
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

  // Review-specific state
  const [kind, setKind] = useState<'coding' | 'review'>('coding');
  const [reviewer, setReviewer] = useState('temper');
  const [targetType, setTargetType] = useState<'diff' | 'branch' | 'pr'>('diff');
  const [targetValue, setTargetValue] = useState('');
  const [reviewDiff, setReviewDiff] = useState('');
  const [reviewContext, setReviewContext] = useState('');
  const [targetError, setTargetError] = useState<string | null>(null);

  const projectPrefix = derivePrefix(workspaceSlug);
  const activeGoals = goals.filter((g) => g.status === 'active');

  function reset() {
    setTitle('');
    setPriority('normal');
    setGoalId('');
    setTitleError(null);
    setFormError(null);
    setKind('coding');
    setReviewer('temper');
    setTargetType('diff');
    setTargetValue('');
    setReviewDiff('');
    setReviewContext('');
    setTargetError(null);
  }

  function handleModalChange() {
    if (isOpen) reset();
    onOpenChange();
  }

  function validateReview(): boolean {
    if (targetType === 'diff' && !reviewDiff.trim()) {
      setTargetError('Diff content is required.');
      return false;
    }
    if (targetType === 'branch' && !targetValue.trim()) {
      setTargetError('Branch name is required.');
      return false;
    }
    if (targetType === 'pr') {
      if (!targetValue.trim()) {
        setTargetError('PR number is required.');
        return false;
      }
      if (!/^\d+$/.test(targetValue.trim())) {
        setTargetError('PR number must be a positive integer.');
        return false;
      }
    }
    return true;
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setFormError(null);
    setTargetError(null);

    if (!title.trim()) {
      setTitleError('Title is required.');
      return;
    }
    setTitleError(null);

    if (kind === 'review' && !validateReview()) return;

    setIsSubmitting(true);
    try {
      const fd = new FormData();
      fd.set('title', title.trim());
      fd.set('projectPrefix', projectPrefix);
      fd.set('priority', priority);
      if (goalId) fd.set('goalId', goalId);

      if (kind === 'review') {
        fd.set('taskKind', 'review');
        const reviewConfig: Record<string, string> = { reviewer, targetType };
        if (targetType !== 'diff' && targetValue.trim()) {
          reviewConfig['targetValue'] = targetValue.trim();
        }
        fd.set('reviewConfig', JSON.stringify(reviewConfig));
        // description: diff text for diff type, context/focus for branch/PR
        const desc = targetType === 'diff' ? reviewDiff.trim() : reviewContext.trim();
        if (desc) fd.set('description', desc);
      } else {
        const descEl = e.currentTarget.elements.namedItem('description') as HTMLTextAreaElement | null;
        if (descEl?.value.trim()) fd.set('description', descEl.value.trim());
      }

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
                  {kind === 'review'
                    ? 'A review agent analyzes the target and posts findings as a comment.'
                    : 'Forge Master triages it and routes it to an agent.'}
                </p>
              </div>

              {/* Body */}
              <div className="flex flex-col gap-4 px-6 py-5">
                {/* Kind toggle */}
                <div className="flex gap-1 rounded-lg border border-zinc-200 dark:border-zinc-700 p-1">
                  {(['coding', 'review'] as const).map((k) => {
                    const selected = kind === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => { setKind(k); setTargetError(null); setFormError(null); }}
                        disabled={isSubmitting}
                        className={`flex-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-50 ${
                          selected
                            ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                            : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200'
                        }`}
                      >
                        {k === 'coding' ? 'Task' : 'Review'}
                      </button>
                    );
                  })}
                </div>

                {/* Title — always shown */}
                <Field label="Title" htmlFor="task-title" required error={titleError ?? undefined}>
                  <input
                    id="task-title"
                    name="title"
                    autoFocus
                    placeholder={kind === 'review' ? 'What are you reviewing?' : 'What needs doing?'}
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

                {kind === 'coding' ? (
                  /* ---- CODING TASK FIELDS ---- */
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
                ) : (
                  /* ---- REVIEW TASK FIELDS ---- */
                  <>
                    {/* Reviewer */}
                    <Field label="Reviewer" htmlFor="task-reviewer">
                      <select
                        id="task-reviewer"
                        value={reviewer}
                        onChange={(e) => setReviewer(e.target.value)}
                        disabled={isSubmitting}
                        className={fieldClass(false)}
                      >
                        {REVIEWER_OPTS.map((r) => (
                          <option key={r.key} value={r.key}>
                            {r.label} — {r.desc}
                          </option>
                        ))}
                      </select>
                    </Field>

                    {/* Target type */}
                    <div className="flex flex-col gap-1.5">
                      <span className="text-sm font-medium text-zinc-700 dark:text-zinc-200">Target</span>
                      <div className="grid grid-cols-3 gap-1.5">
                        {TARGET_OPTS.map((opt) => {
                          const selected = targetType === opt.key;
                          return (
                            <button
                              key={opt.key}
                              type="button"
                              onClick={() => { setTargetType(opt.key); setTargetValue(''); setTargetError(null); }}
                              disabled={isSubmitting}
                              aria-pressed={selected}
                              className={`rounded-md border px-2 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 ${
                                selected
                                  ? 'border-[#FF6B2B] bg-[#FF6B2B]/10 text-[#FF6B2B]'
                                  : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-zinc-700 dark:text-zinc-300 dark:hover:border-zinc-600'
                              }`}
                            >
                              {opt.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* Target input — conditional */}
                    {targetType === 'diff' && (
                      <Field label="Diff content" htmlFor="review-diff" required error={targetError ?? undefined}>
                        <textarea
                          id="review-diff"
                          placeholder="Paste the output of git diff here."
                          rows={8}
                          value={reviewDiff}
                          onChange={(e) => { setReviewDiff(e.target.value); if (targetError) setTargetError(null); }}
                          disabled={isSubmitting}
                          className={`${fieldClass(!!targetError)} resize-y font-mono text-xs`}
                        />
                      </Field>
                    )}

                    {targetType === 'branch' && (
                      <Field label="Branch name" htmlFor="review-branch" required error={targetError ?? undefined}>
                        <input
                          id="review-branch"
                          placeholder="feature/my-branch"
                          value={targetValue}
                          onChange={(e) => { setTargetValue(e.target.value); if (targetError) setTargetError(null); }}
                          disabled={isSubmitting}
                          className={fieldClass(!!targetError)}
                        />
                      </Field>
                    )}

                    {targetType === 'pr' && (
                      <Field label="PR number" htmlFor="review-pr" required error={targetError ?? undefined}>
                        <input
                          id="review-pr"
                          inputMode="numeric"
                          placeholder="123"
                          value={targetValue}
                          onChange={(e) => { setTargetValue(e.target.value); if (targetError) setTargetError(null); }}
                          disabled={isSubmitting}
                          className={fieldClass(!!targetError)}
                        />
                      </Field>
                    )}

                    {/* Context / focus — branch and PR only */}
                    {targetType !== 'diff' && (
                      <Field label="Context / focus" htmlFor="review-context" hint="Optional notes for the reviewer — what to focus on, known hotspots, etc.">
                        <textarea
                          id="review-context"
                          placeholder="e.g. Focus on auth logic and input validation."
                          rows={3}
                          value={reviewContext}
                          onChange={(e) => setReviewContext(e.target.value)}
                          disabled={isSubmitting}
                          className={`${fieldClass(false)} resize-y`}
                        />
                      </Field>
                    )}
                  </>
                )}

                {/* Priority — always shown */}
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

                {/* Goal link — always shown if active goals exist */}
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
                  {kind === 'review' ? 'Create review' : 'Create task'}
                </button>
              </div>
            </form>
          )}
        </ModalContent>
      </Modal>
    </>
  );
}
