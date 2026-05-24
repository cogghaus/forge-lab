'use client';

import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  useDisclosure,
} from '@heroui/react';
import { useRef } from 'react';
import { createWorkspaceAction } from '@/actions/workspaces';

export function NewWorkspaceButton() {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const formRef = useRef<HTMLFormElement>(null);

  async function handleAction(formData: FormData) {
    const result = await createWorkspaceAction(formData);
    if (!result?.error) {
      onOpenChange();
    }
  }

  return (
    <>
      <Button color="primary" onPress={onOpen}>
        New Workspace
      </Button>

      <Modal isOpen={isOpen} onOpenChange={onOpenChange}>
        <ModalContent>
          {(onClose) => (
            <form action={handleAction} ref={formRef}>
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
