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
import { createGoalAction } from '@/actions/goals';
import type { HubGoal } from '@/lib/hub';

interface Props {
  workspaceId: string;
  goals: HubGoal[];
}

export function NewGoalButton({ workspaceId, goals }: Props) {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const [error, setError] = useState<string | null>(null);

  async function handleAction(formData: FormData) {
    setError(null);
    const result = await createGoalAction(workspaceId, formData);
    if (result?.error) {
      setError(result.error);
    } else {
      onOpenChange();
    }
  }

  function handleOpenChange(open: boolean) {
    if (!open) setError(null);
    onOpenChange();
  }

  const activeGoals = goals.filter((g) => g.status === 'active');

  return (
    <>
      <Button color="primary" onPress={onOpen}>
        New Goal
      </Button>

      <Modal isOpen={isOpen} onOpenChange={handleOpenChange}>
        <ModalContent>
          {(onClose) => (
            <form action={handleAction}>
              <ModalHeader>Create Goal</ModalHeader>
              <ModalBody className="flex flex-col gap-4">
                <Input label="Title" name="title" placeholder="Goal title" isRequired />
                <Textarea
                  label="Description"
                  name="description"
                  placeholder="Optional description"
                  minRows={2}
                />
                {activeGoals.length > 0 && (
                  <Select
                    label="Parent Goal"
                    name="parentId"
                    placeholder="None (top-level goal)"
                  >
                    {activeGoals.map((g) => (
                      <SelectItem key={g.id} textValue={g.title}>
                        {g.title}
                      </SelectItem>
                    ))}
                  </Select>
                )}
                {error && <p className="text-danger text-sm">{error}</p>}
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
