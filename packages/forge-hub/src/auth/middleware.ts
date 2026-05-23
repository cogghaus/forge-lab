import type { onRequestHookHandler, preHandlerHookHandler } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { schema, type WorkspaceRole, rankAtLeast } from '@forge-lab/core';
import type { Db } from '../db/index.js';
import { verifySession } from './sessions.js';
import { hashToken } from './tokens.js';

export interface AuthUser {
  id: string;
  email: string;
  role: 'admin' | 'user';
}

export interface AuthDevice {
  id: string;
  userId: string;
  name: string;
}

export interface AuthWorkspace {
  id: string;
  role: WorkspaceRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
    authDevice?: AuthDevice;
    authWorkspace?: AuthWorkspace;
  }
}

export function populateAuth(db: Db): onRequestHookHandler {
  return async (req) => {
    const cookies = (req as unknown as { cookies?: Record<string, string | undefined> }).cookies;
    const cookieToken = cookies?.['session'];
    if (cookieToken) {
      const session = await verifySession(db, cookieToken);
      if (session) {
        const user = await db
          .select({
            id: schema.users.id,
            email: schema.users.email,
            role: schema.users.role,
          })
          .from(schema.users)
          .where(eq(schema.users.id, session.userId))
          .get();
        if (user) {
          req.authUser = { id: user.id, email: user.email, role: user.role };
        }
      }
    }

    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice(7);
      const tokenHash = hashToken(token);
      const device = await db
        .select({
          id: schema.devices.id,
          userId: schema.devices.userId,
          name: schema.devices.name,
        })
        .from(schema.devices)
        .where(eq(schema.devices.tokenHash, tokenHash))
        .get();
      if (device) {
        req.authDevice = { id: device.id, userId: device.userId, name: device.name };
        await db
          .update(schema.devices)
          .set({ lastSeen: new Date() })
          .where(eq(schema.devices.id, device.id));
      }
    }
  };
}

export const requireUser: preHandlerHookHandler = async (req, reply) => {
  if (!req.authUser) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
};

export const requireDevice: preHandlerHookHandler = async (req, reply) => {
  if (!req.authDevice) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
};

export const requireUserOrDevice: preHandlerHookHandler = async (req, reply) => {
  if (!req.authUser && !req.authDevice) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
};

export function getUser(req: { authUser?: AuthUser }): AuthUser {
  if (!req.authUser) throw new Error('getUser called without requireUser preHandler');
  return req.authUser;
}

export function getDevice(req: { authDevice?: AuthDevice }): AuthDevice {
  if (!req.authDevice) throw new Error('getDevice called without requireDevice preHandler');
  return req.authDevice;
}

export function requireWorkspaceMember(db: Db, role?: WorkspaceRole): preHandlerHookHandler {
  return async (req, reply) => {
    if (!req.authUser) {
      await reply.code(401).send({ error: 'unauthorized' });
      return;
    }
    const params = req.params as Record<string, string>;
    const workspaceId = params['workspaceId'];
    if (!workspaceId) {
      await reply.code(400).send({ error: 'missing_workspace_id' });
      return;
    }
    const member = await db
      .select({ role: schema.workspaceMembers.role })
      .from(schema.workspaceMembers)
      .where(
        and(
          eq(schema.workspaceMembers.workspaceId, workspaceId),
          eq(schema.workspaceMembers.userId, req.authUser.id),
        ),
      )
      .get();
    if (!member) {
      await reply.code(403).send({ error: 'forbidden' });
      return;
    }
    if (role && !rankAtLeast(member.role, role)) {
      await reply.code(403).send({ error: 'insufficient_role' });
      return;
    }
    req.authWorkspace = { id: workspaceId, role: member.role };
  };
}

export function getWorkspace(req: { authWorkspace?: AuthWorkspace }): AuthWorkspace {
  if (!req.authWorkspace) throw new Error('getWorkspace called without requireWorkspaceMember preHandler');
  return req.authWorkspace;
}
