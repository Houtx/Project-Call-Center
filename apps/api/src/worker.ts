import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { CallReconciliationService } from './mobile/reconciliation.service';

const logger = new Logger('Worker');

function waitForNextRun(signal: AbortSignal, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }

    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener('abort', finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    signal.addEventListener('abort', finish, { once: true });
  });
}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.createApplicationContext(AppModule, {
    logger: ['log', 'warn', 'error'],
  });
  const reconciliation = app.get(CallReconciliationService);
  const shutdownController = new AbortController();
  let running = true;
  const shutdown = () => {
    running = false;
    shutdownController.abort();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);

  logger.log('Call reconciliation worker started');
  while (running) {
    try {
      let count: number;
      do {
        count = await reconciliation.reconcileExpired();
      } while (count === 500 && running);
      await reconciliation.housekeeping();
    } catch (error) {
      logger.error(error instanceof Error ? error.stack : String(error));
    }
    await waitForNextRun(shutdownController.signal, 60_000);
  }
  await app.close();
}

void bootstrap();
