import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import type { ProfileBody } from './apiModels.js';
import type { MembershipDb } from './membershipService.js';
import { membershipSnapshot } from './membershipService.js';
import { MembershipError } from './membershipPolicy.js';
import {
  AnimatedAvatarMembershipError, InvalidAvatarError, MAX_AVATAR_BODY_BYTES,
  prepareAvatarBase64, staticAvatarFrame
} from './imageSecurity.js';

interface ProfileDependencies {
  db: MembershipDb;
  membershipEnabled: boolean;
  authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  userId: (request: FastifyRequest) => string;
  transaction: <T>(work: (client: PoolClient) => Promise<T>) => Promise<T>;
  limit: (userId: string) => Promise<void>;
  account: (db: MembershipDb, userId: string) => Promise<unknown>;
}

function error(statusCode: number, code: string, message: string): Error {
  return new MembershipError(statusCode, code, message);
}

export function registerProfileRoutes(app: FastifyInstance, deps: ProfileDependencies): void {
  async function animatedAllowed(db: MembershipDb, userId: string): Promise<boolean> {
    return deps.membershipEnabled && (await membershipSnapshot(db, userId)).benefits.animatedAvatar;
  }

  app.get<{ Params: { userId: string } }>('/v1/avatars/:userId', async (request, reply) => {
    const userId = request.params.userId;
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      throw error(404, 'AVATAR_NOT_FOUND', '头像不存在');
    }
    const result = await deps.db.query<{ avatar_data: Buffer; avatar_mime: string }>(
      'SELECT avatar_data, avatar_mime FROM app_users WHERE id = $1 AND avatar_data IS NOT NULL', [userId]);
    const avatar = result.rows[0];
    if (!avatar) throw error(404, 'AVATAR_NOT_FOUND', '头像不存在');
    let data = avatar.avatar_data;
    let mime = avatar.avatar_mime || 'image/jpeg';
    if (mime === 'image/gif' && !await animatedAllowed(deps.db, userId)) {
      data = await staticAvatarFrame(data);
      mime = 'image/jpeg';
    }
    reply.header('Content-Type', mime);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'no-store');
    return reply.send(data);
  });

  app.post<{ Body: ProfileBody }>('/v1/me/profile',
    { preHandler: deps.authenticate, bodyLimit: MAX_AVATAR_BODY_BYTES }, async request => {
      const userId = deps.userId(request);
      await deps.limit(userId);
      const displayName = typeof request.body?.displayName === 'string' ? request.body.displayName.trim() : '';
      if (!displayName || Array.from(displayName).length > 30 || /[\u0000-\u001f\u007f]/.test(displayName)) {
        throw error(400, 'INVALID_DISPLAY_NAME', '昵称应为 1 至 30 个字符');
      }
      const removeAvatar = request.body?.removeAvatar === true;
      const base64 = request.body?.avatarBase64 ?? '';
      if (typeof base64 !== 'string') throw error(400, 'INVALID_AVATAR', '头像数据格式无效');
      let avatar = null;
      if (!removeAvatar && base64) {
        try {
          avatar = await prepareAvatarBase64(base64.trim(), await animatedAllowed(deps.db, userId),
            request.body?.avatarCrop);
        } catch (cause) {
          if (cause instanceof InvalidAvatarError) throw error(400, 'INVALID_AVATAR', cause.message);
          throw cause;
        }
      }
      await deps.transaction(async client => {
        if (avatar?.mime === 'image/gif') {
          // Recheck after encoding, under the same account lock as membership purchases.
          await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`membership:${userId}`]);
          if (!await animatedAllowed(client, userId)) throw new AnimatedAvatarMembershipError();
        }
        if (removeAvatar) {
          await client.query(`UPDATE app_users SET display_name = $2, avatar_url = '', avatar_data = NULL,
            avatar_mime = NULL, profile_customized = TRUE, updated_at = now() WHERE id = $1`, [userId, displayName]);
        } else if (avatar) {
          await client.query(`UPDATE app_users SET display_name = $2, avatar_url = '', avatar_data = $3,
            avatar_mime = $4, profile_customized = TRUE, updated_at = now() WHERE id = $1`,
          [userId, displayName, avatar.data, avatar.mime]);
        } else {
          await client.query(`UPDATE app_users SET display_name = $2, profile_customized = TRUE,
            updated_at = now() WHERE id = $1`, [userId, displayName]);
        }
      });
      return deps.account(deps.db, userId);
    });
}
