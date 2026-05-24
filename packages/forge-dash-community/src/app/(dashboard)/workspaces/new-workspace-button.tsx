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
import { useState } from 'react';
import { createWorkspaceAction } from '@/actions/workspaces';

export function NewWorkspaceButton() {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const [error, setError] = useState<string | null>(null);

  async function handleAction(formData: FormData) {
    setError(null);
    const result = await createWorkspaceAction(formData);
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

  return (
    <>
      <Button color="primary" onPress={onOpen}>
        New Workspace
      </Button>

      <Modal isOpen={isOpen} onOpenChange={handleOpenChange}>
        <ModalContent>
          {(onClose) => (
            <form action={handleAction}>
              <ModalHeader>Create Workspace</ModalHeader>
              <ModalBody className="flex flex-col gap-4">
                <Input label="Name" name="name" placeholder="My Project" isRequired />
                <Input
                  label="Slug"
                  name="slug"
                  placeholder="my-project"
                  description="Lowercase letters, numbers, hyphens"
                  isRequired
                />
                <Textarea
                  label="Description"
                  name="description"
                  placeholder="Optional description"
                  minRows={2}
                />
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
