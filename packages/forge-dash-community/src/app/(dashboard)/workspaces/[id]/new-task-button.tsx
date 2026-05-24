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
import { createTaskAction } from '@/actions/tasks';

export function NewTaskButton({ workspaceId }: { workspaceId: string }) {
  const { isOpen, onOpen, onOpenChange } = useDisclosure();

  async function handleAction(formData: FormData) {
    const result = await createTaskAction(workspaceId, formData);
    if (!result?.error) {
      onOpenChange();
    }
  }

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
                <Input label="Title" name="title" placeholder="Task title" isRequired />
                <Input
                  label="Project Prefix"
                  name="projectPrefix"
                  placeholder="fl"
                  description="2-6 lowercase letters"
                  isRequired
                />
                <Textarea
                  label="Description"
                  name="description"
                  placeholder="Optional description"
                  minRows={2}
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
