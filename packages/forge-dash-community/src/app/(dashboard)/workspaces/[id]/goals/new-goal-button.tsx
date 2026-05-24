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
import { resolveSelection } from '@/lib/form-fields';
import type { HubGoal } from '@/lib/hub';

interface Props {
  workspaceId: string;
  goals: HubGoal[];
}

export function NewGoalButton({ workspaceId, goals }: Props) {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [parentId, setParentId] = useState('');

  async function handleAction(formData: FormData) {
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await createGoalAction(workspaceId, formData);
      if (result?.error) {
        setError(result.error);
      } else {
        onOpenChange();
      }
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleOpenChange(open: boolean) {
    if (!open) {
      setError(null);
      setParentId('');
    }
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
                {parentId && <input type="hidden" name="parentId" value={parentId} />}
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
                    placeholder="None (top-level goal)"
                    onSelectionChange={(keys) => setParentId(resolveSelection(keys, ''))}
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
