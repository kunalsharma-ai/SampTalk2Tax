import 'reflect-metadata';
import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { AppConfig } from './config';

export async function createApp(config: AppConfig, opts: { logger?: boolean } = {}): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config), { logger: opts.logger === false ? false : undefined });
  app.use(helmet());
  app.enableCors({ origin: config.CORS_ORIGINS.split(',').map((s) => s.trim()), credentials: false });
  app.enableShutdownHooks();
  const doc = new DocumentBuilder()
    .setTitle('Sampledge Talk2Tax API')
    .setDescription('Accounting foundation: auth, organizations, chart of accounts, fiscal periods, journals, reports, audit trail.')
    .setVersion('0.1.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, doc), { jsonDocumentUrl: 'docs/openapi.json' });
  return app;
}
