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
import { createTaskAction } from '@/actions/tasks';
import { derivePrefix } from '@/lib/task-prefix';
import type { HubGoal } from '@/lib/hub';

interface Props {
  workspaceId: string;
  workspaceSlug: string;
  goals: HubGoal[];
}

export function NewTaskButton({ workspaceId, workspaceSlug, goals }: Props) {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const projectPrefix = derivePrefix(workspaceSlug);

  async function handleAction(formData: FormData) {
    const result = await createTaskAction(workspaceId, formData);
    if (!result?.error) {
      onOpenChange();
    }
  }

  const activeGoals = goals.filter((g) => g.status === 'active');

  return (
    <>
      <Button color="primary" onPress={onOpen}>
        New Task
      </Button>

      <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
        <ModalContent>
          {(onClose) => (
            <form action={handleAction}>
              <ModalHeader>Create Task</ModalHeader>
              <ModalBody className="flex flex-col gap-4">
                <input type="hidden" name="projectPrefix" value={projectPrefix} />
                <Input label="Title" name="title" placeholder="Task title" isRequired />
                <Textarea
                  label="Description"
                  name="description"
                  placeholder="Optional description"
                  minRows={2}
                />
                {activeGoals.length > 0 && (
                  <Select label="Link to goal" name="goalId" placeholder="None">
                    {activeGoals.map((goal) => (
                      <SelectItem key={goal.id}>
                        {goal.title}
                      </SelectItem>
                    ))}
                  </Select>
                )}
              </ModalBody>
              <ModalFooter>
                <Button variant="light" onPress={onClose}>
                  Cancel
                </Button>
                <Button color="primary" type="submit">
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
