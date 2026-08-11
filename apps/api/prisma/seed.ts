import {
  BatchStatus,
  CustomerStatus,
  PrismaClient,
  Role,
  UserStatus,
} from '@prisma/client';
import * as argon2 from 'argon2';
import {
  createCipheriv,
  createHmac,
  randomBytes,
} from 'node:crypto';

const prisma = new PrismaClient();

interface EncryptedPhone {
  phoneCiphertext: Uint8Array<ArrayBuffer>;
  phoneIv: Uint8Array<ArrayBuffer>;
  phoneTag: Uint8Array<ArrayBuffer>;
  phoneHash: string;
  phoneMasked: string;
}

function readKey(name: 'PHONE_ENCRYPTION_KEY' | 'PHONE_HASH_KEY'): Buffer {
  const encoded = process.env[name];
  if (!encoded) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`${name} is required when seeding production`);
    }
    return createHmac('sha256', 'development-only')
      .update('call-center-local-key')
      .digest();
  }

  const key = Buffer.from(encoded, 'base64');
  if (key.length !== 32) {
    throw new Error(`${name} must be a base64-encoded 32 byte key`);
  }
  return key;
}

const encryptionKey = readKey('PHONE_ENCRYPTION_KEY');
const hashKey = readKey('PHONE_HASH_KEY');

function protectPhone(e164Phone: string): EncryptedPhone {
  const phoneIv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, phoneIv);
  const phoneCiphertext = Buffer.concat([
    cipher.update(e164Phone, 'utf8'),
    cipher.final(),
  ]);
  const localNumber = e164Phone.replace(/^\+86/, '');

  return {
    phoneCiphertext: new Uint8Array(phoneCiphertext),
    phoneIv: new Uint8Array(phoneIv),
    phoneTag: new Uint8Array(cipher.getAuthTag()),
    phoneHash: createHmac('sha256', hashKey).update(e164Phone).digest('hex'),
    phoneMasked: `${localNumber.slice(0, 3)}****${localNumber.slice(-4)}`,
  };
}

async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19_456,
    timeCost: 2,
    parallelism: 1,
  });
}

function requiredSeedPassword(name: 'SEED_ADMIN_PASSWORD' | 'SEED_AGENT_PASSWORD'): string {
  const value = process.env[name]?.trim();
  if (!value || value.startsWith('replace-with-') || value.length < 12) {
    throw new Error(`${name} must be explicitly set to a password of at least 12 characters`);
  }
  return value;
}

async function main(): Promise<void> {
  const adminPassword = await hashPassword(requiredSeedPassword('SEED_ADMIN_PASSWORD'));
  const agentPassword = await hashPassword(requiredSeedPassword('SEED_AGENT_PASSWORD'));

  const admin = await prisma.user.upsert({
    where: { username: (process.env.ADMIN_USERNAME ?? 'admin').toLowerCase() },
    create: {
      username: (process.env.ADMIN_USERNAME ?? 'admin').toLowerCase(),
      displayName: '系统管理员',
      passwordHash: adminPassword,
      role: Role.ADMIN,
      status: UserStatus.ACTIVE,
    },
    update: {
      displayName: '系统管理员',
      role: Role.ADMIN,
    },
  });

  await Promise.all(
    [
      { username: 'agent001', displayName: '演示坐席一' },
      { username: 'agent002', displayName: '演示坐席二' },
    ].map((agent) =>
      prisma.user.upsert({
        where: { username: agent.username },
        create: {
          ...agent,
          passwordHash: agentPassword,
          role: Role.AGENT,
          status: UserStatus.ACTIVE,
        },
        update: {
          displayName: agent.displayName,
          role: Role.AGENT,
        },
      }),
    ),
  );

  const batch = await prisma.batch.upsert({
    where: { code: 'DEMO-001' },
    create: {
      code: 'DEMO-001',
      name: '演示客户批次',
      description: '本地开发种子数据',
      status: BatchStatus.ACTIVE,
      createdById: admin.id,
    },
    update: {
      name: '演示客户批次',
      description: '本地开发种子数据',
      status: BatchStatus.ACTIVE,
      archivedAt: null,
    },
  });

  const sampleCustomers = [
    {
      name: '演示客户甲',
      phone: '+8613800001001',
      province: '江苏',
      city: '南京',
      carrier: '中国移动',
      tags: ['演示', '新客户'],
    },
    {
      name: '演示客户乙',
      phone: '+8613900001002',
      province: '江苏',
      city: '苏州',
      carrier: '中国联通',
      tags: ['演示'],
    },
    {
      name: '演示客户丙',
      phone: '+8618900001003',
      province: '上海',
      city: '上海',
      carrier: '中国电信',
      tags: ['演示'],
    },
  ];

  for (const customer of sampleCustomers) {
    const encrypted = protectPhone(customer.phone);
    await prisma.customer.upsert({
      where: { phoneHash: encrypted.phoneHash },
      create: {
        batchId: batch.id,
        createdById: admin.id,
        name: customer.name,
        ...encrypted,
        province: customer.province,
        city: customer.city,
        carrier: customer.carrier,
        tags: customer.tags,
        status: CustomerStatus.AVAILABLE,
      },
      update: {
        batchId: batch.id,
        name: customer.name,
        province: customer.province,
        city: customer.city,
        carrier: customer.carrier,
        tags: customer.tags,
      },
    });
  }

  await prisma.mobileAppPolicy.upsert({
    where: { id: 'android' },
    create: {
      id: 'android',
      minimumVersionCode: 1,
      latestVersionCode: 1,
      forceUpgrade: false,
      maxCallAttempts: 2,
    },
    update: {},
  });

  console.info('Seeded admin, 2 agents, demo batch, and 3 encrypted customers.');
}

main()
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
