import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '@fieldcore/database';
import { projectMembers, projects } from '@fieldcore/database';
import type { AuthConfig } from './auth/config.js';
import { requireAuth } from './auth/middleware.js';

const addMemberSchema = z.object({
  userId: z.string().uuid(),
  role: z.enum(['OWNER', 'MEMBER']).default('MEMBER'),
});

/**
 * Registers project membership lifecycle management routes.
 *
 * Supported application workflows:
 * - POST /projects/:projectId/members: Adds a user to project_members (caller must belong to project)
 * - GET  /projects/:projectId/members: Lists members of a project (caller must belong to project)
 */
export function registerProjectMemberRoutes(
  app: FastifyInstance,
  db: Database,
  config: AuthConfig
): void {
  // Add member to project
  app.post<{
    Params: { projectId: string };
    Body: { userId: string; role?: 'OWNER' | 'MEMBER' };
  }>(
    '/projects/:projectId/members',
    { preHandler: requireAuth(config, db) },
    async (request, reply) => {
      const { projectId } = request.params;
      const callerUserId = request.auth!.sub;

      // 1. Verify target project exists
      const [project] = await db
        .select({ id: projects.id })
        .from(projects)
        .where(eq(projects.id, projectId))
        .limit(1);

      if (!project) {
        return reply.status(404).send({
          error: 'Not Found',
          code: 'PROJECT_NOT_FOUND',
          message: `Project ${projectId} does not exist.`,
        });
      }

      // 2. Authorize caller: Caller must belong to project to manage/add members
      const [callerMembership] = await db
        .select({ role: projectMembers.role })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, callerUserId)
          )
        )
        .limit(1);

      if (!callerMembership) {
        return reply.status(403).send({
          error: 'Forbidden',
          code: 'UNAUTHORIZED_PROJECT_ACCESS',
          message: 'Caller is not a member of this project.',
        });
      }

      // 3. Validate body payload
      const parseResult = addMemberSchema.safeParse(request.body);
      if (!parseResult.success) {
        return reply.status(400).send({
          error: 'Validation failed',
          details: parseResult.error.errors,
        });
      }

      const { userId, role } = parseResult.data;

      // 4. Check if membership already exists (idempotency)
      const [existingMembership] = await db
        .select()
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, userId)
          )
        )
        .limit(1);

      if (existingMembership) {
        return reply.status(200).send({
          success: true,
          member: existingMembership,
        });
      }

      // 5. Insert new project membership
      const memberId = randomUUID();
      const nowIso = new Date().toISOString();

      await db.insert(projectMembers).values({
        id: memberId,
        projectId,
        userId,
        role,
        createdAt: nowIso,
      });

      return reply.status(201).send({
        success: true,
        member: {
          id: memberId,
          projectId,
          userId,
          role,
          createdAt: nowIso,
        },
      });
    }
  );

  // List members of project
  app.get<{ Params: { projectId: string } }>(
    '/projects/:projectId/members',
    { preHandler: requireAuth(config, db) },
    async (request, reply) => {
      const { projectId } = request.params;
      const callerUserId = request.auth!.sub;

      // Verify caller is a member
      const [callerMembership] = await db
        .select({ id: projectMembers.id })
        .from(projectMembers)
        .where(
          and(
            eq(projectMembers.projectId, projectId),
            eq(projectMembers.userId, callerUserId)
          )
        )
        .limit(1);

      if (!callerMembership) {
        return reply.status(403).send({
          error: 'Forbidden',
          code: 'UNAUTHORIZED_PROJECT_ACCESS',
          message: 'Caller is not a member of this project.',
        });
      }

      const members = await db
        .select()
        .from(projectMembers)
        .where(eq(projectMembers.projectId, projectId));

      return reply.status(200).send({ members });
    }
  );
}
