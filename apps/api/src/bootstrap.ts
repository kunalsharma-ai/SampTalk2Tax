import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './config';

export async function createApp(config: AppConfig, opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), { logger: opts.logger === false ? false : undefined });
  // Bank statement files are sent as JSON text; allow up to ~3 MB (5,000 lines is far below this).
  app.useBodyParser('json', { limit: '3mb' });
  // Attachments are uploaded as raw bytes. The limit sits above the 5 MB file cap so the
  // service can answer with a clear FILE_TOO_LARGE error for files a little over it.
  app.useBodyParser('raw', { limit: '6mb', type: ['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'application/octet-stream'] });
  app.use(helmet());
  app.enableCors({ origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: false });
  app.enableShutdownHooks();
  const doc = new DocumentBuilder()
    .setTitle('Sampledge Talk2Tax API')
    .setDescription('Accounting foundation: auth, organizations, chart of accounts, fiscal periods, journals, reports, audit trail, receivables, payables, banking, attachments, approvals.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, doc), { jsonDocumentUrl: 'docs/openapi.json' });
  return app;
}
