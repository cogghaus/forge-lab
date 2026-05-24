'use client';

import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Select,
  SelectItem,
  Textarea,
  useDisclosure,
} from '@heroui/react';
import { useState } from 'react';
import { createTaskAction } from '@/actions/tasks';
import { derivePrefix } from '@/lib/task-prefix';
import { resolveSelection } from '@/lib/form-fields';
import type { HubGoal } from '@/lib/hub';
import { toast } from 'sonner';

interface Props {
  workspaceId: string;
  workspaceSlug: string;
  goals: HubGoal[];
}

export function NewTaskButton({ workspaceId, workspaceSlug, goals }: Props) {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [priority, setPriority] = useState('normal');
  const [goalId, setGoalId] = useState('');
  const projectPrefix = derivePrefix(workspaceSlug);

  async function handleAction(formData: FormData) {
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await createTaskAction(workspaceId, formData);
      if (result?.error) {
        setError(result.error);
        toast.error(result.error);
      } else {
        toast.success('Task created');
        onOpenChange();
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleOpenChange(open: boolean) {
    if (!open) {
      setError(null);
      setPriority('normal');
      setGoalId('');
    }
    onOpenChange();
  }

  const activeGoals = goals.filter((g) => g.status === 'active');

  return (
    <>
      <Button color="primary" onPress={onOpen}>
        New Task
      </Button>

      <Modal isOpen={isOpen} onOpenChange={handleOpenChange}>
        <ModalContent>
          {(onClose) => (
            <form action={handleAction}>
              <ModalHeader>Create Task</ModalHeader>
              <ModalBody className="flex flex-col gap-4">
                <input type="hidden" name="projectPrefix" value={projectPrefix} />
                <input type="hidden" name="priority" value={priority} />
                {goalId && <input type="hidden" name="goalId" value={goalId} />}
                <Input label="Title" name="title" placeholder="Task title" isRequired />
                <Textarea
                  label="Description"
                  name="description"
                  placeholder="Optional description"
                  minRows={2}
                />
                <Select
                  label="Priority"
                  defaultSelectedKeys={['normal']}
                  onSelectionChange={(keys) => setPriority(resolveSelection(keys, 'normal'))}
                >
                  <SelectItem key="low">Low</SelectItem>
                  <SelectItem key="normal">Normal</SelectItem>
                  <SelectItem key="high">High</SelectItem>
                  <SelectItem key="urgent">Urgent</SelectItem>
                </Select>
                {activeGoals.length > 0 && (
                  <Select
                    label="Link to goal"
                    placeholder="None"
                    onSelectionChange={(keys) => setGoalId(resolveSelection(keys, ''))}
                  >
                    {activeGoals.map((goal) => (
                      <SelectItem key={goal.id}>
                        {goal.title}
                      </SelectItem>
                    ))}
                  </Select>
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
