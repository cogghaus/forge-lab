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
import { toast } from 'sonner';

export function NewWorkspaceButton() {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function handleAction(formData: FormData) {
    setError(null);
    setIsSubmitting(true);
    try {
      const result = await createWorkspaceAction(formData);
      if (result?.error) {
        setError(result.error);
        toast.error(result.error);
      } else {
        toast.success('Workspace created');
        onOpenChange();
      }
    } finally {
      setIsSubmitting(false);
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
