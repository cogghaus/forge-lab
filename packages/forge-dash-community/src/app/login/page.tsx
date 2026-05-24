'use client';

import { Button, Card, CardBody, CardHeader, Input } from '@heroui/react';
import { useActionState, useState } from 'react';
import { loginAction } from '@/actions/auth';

const initialState = { error: undefined as string | undefined };

export default function LoginPage() {
  const [state, action, pending] = useActionState(loginAction, initialState);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="flex flex-col gap-1 pb-0">
          <h1 className="text-xl font-bold">Forge Lab</h1>
          <p className="text-sm text-default-500">
            Access is by invitation only. Contact your admin for credentials.
          </p>
        </CardHeader>
        <CardBody>
          <form action={action} className="flex flex-col gap-4">
            {state.error && (
              <p className="rounded-lg bg-danger-50 px-3 py-2 text-sm text-danger">
                {state.error}
              </p>
            )}
            {process.env.NODE_ENV === 'development' && (
              <button
                type="button"
                onClick={() => { setEmail('dev@forge-lab.local'); setPassword('devpassword123'); }}
                className="rounded-lg bg-default-100 px-3 py-2 text-left text-xs text-default-500 font-mono hover:bg-default-200 transition-colors cursor-pointer"
              >
                dev: dev@forge-lab.local / devpassword123
              </button>
            )}
            <Input
              label="Email"
              name="email"
              type="email"
              placeholder="you@example.com"
              isRequired
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
            <Input
              label="Password"
              name="password"
              type="password"
              placeholder="Password"
              isRequired
              value={password}
              onChange={e => setPassword(e.target.value)}
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
