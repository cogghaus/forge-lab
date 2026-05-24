'use client';

import { Button, Card, CardBody, CardHeader, Input } from '@heroui/react';
import { useActionState } from 'react';
import { loginAction } from '@/actions/auth';

const initialState = { error: undefined as string | undefined };

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, initialState);

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="flex flex-col gap-1 pb-0">
          <h1 className="text-xl font-bold">Forge Lab</h1>
          <p className="text-sm text-default-500">Sign in to your account</p>
        </CardHeader>
        <CardBody>
          <form action={action} className="flex flex-col gap-4">
            {state.error && (
              <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger">
                {state.error}
              </p>
            )}
            <Input
              label="Email"
              name="email"
              type="email"
              placeholder="admin@example.com"
              isRequired
            />
            <Input
              label="Password"
              name="password"
              type="password"
              placeholder="Password"
              isRequired
            />
            <Button type="submit" color="primary" fullWidth isLoading={pending}>
              Sign in
            </Button>
          </form>
        </CardBody>
      </Card>
    </div>
  );
}
