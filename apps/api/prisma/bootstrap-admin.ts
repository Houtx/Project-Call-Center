import { PrismaClient, Role, UserStatus } from '@prisma/client';
import * as argon2 from 'argon2';

const prisma = new PrismaClient();

async function main(): Promise<void> {
  const username = (process.env.ADMIN_USERNAME ?? 'admin').trim().toLowerCase();
  const displayName = (process.env.ADMIN_DISPLAY_NAME ?? '系统管理员').trim();
  const password = process.env.ADMIN_INITIAL_PASSWORD;
  if (!password || password.length < 12) {
    throw new Error('ADMIN_INITIAL_PASSWORD must contain at least 12 characters');
  }

  const existing = await prisma.user.findUnique({ where: { username } });
  if (existing) {
    if (existing.role !== Role.ADMIN) {
      throw new Error(`Username ${username} already exists and is not an administrator`);
    }
    console.info(`Administrator ${username} already exists; password was not changed.`);
    return;
  }

  await prisma.user.create({
    data: {
      username,
      displayName,
      passwordHash: await argon2.hash(password, { type: argon2.argon2id }),
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
    },
  });
  console.info(`Created initial administrator ${username}. Change the password after first login.`);
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => prisma.$disconnect());
