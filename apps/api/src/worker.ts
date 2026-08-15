import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { WorkerModule } from './worker.module';

const logger = new Logger('Worker');

async function bootstrap(): Promise<void> {
  process.env.BACKGROUND_JOBS_ENABLED ??= 'true';
  const app = await NestFactory.createApplicationContext(WorkerModule, {
    logger: ['log', 'warn', 'error'],
  });
  logger.log('Call reconciliation worker started');
  await new Promise<void>((resolve) => {
    const shutdown = () => resolve();
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
  await app.close();
}

void bootstrap();
