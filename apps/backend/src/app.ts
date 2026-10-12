import 'reflect-metadata';
import {
  ArgumentsHost, Body, Catch, Controller, ExceptionFilter, Get, Headers,
  Inject, Module, Patch, Post, Query, Sse, type MessageEvent,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Observable } from 'rxjs';
import {
  ValidationError, validateCount, type BatchResponse, type Policy,
} from '@resilience/contracts';
import { ConflictError, Engine, ProxyError } from './engine';

@Catch(ValidationError, ConflictError, ProxyError)
class LabErrorFilter implements ExceptionFilter {
  catch(error: Error, host: ArgumentsHost) {
    const status = error instanceof ValidationError ? 400 : error instanceof ConflictError ? 409 : 502;
    host.switchToHttp().getResponse().status(status).json({ statusCode: status, message: error.message });
  }
}

@Controller('api')
class ApiController {
  constructor(@Inject(Engine) private readonly engine: Engine) {}
  @Get('health') health() { return { ok: true, state: this.engine.state }; }
  @Get('config') config() { return this.engine.policy; }
  @Patch('config') patchConfig(@Body() body: unknown) { return this.engine.configure(body); }
  @Post('config') postConfig(@Body() body: unknown) { return this.engine.configure(body); }
  @Get('snapshot') async snapshot() {
    await this.engine.refreshExternal();
    return this.engine.snapshot();
  }
  @Get('external') async external() {
    const snapshot = await this.engine.refreshExternal();
    if (!snapshot) throw new ProxyError('External API unavailable');
    return snapshot.config;
  }
  @Patch('external') patchExternal(@Body() body: unknown) { return this.engine.configureExternal(body); }
  @Post('reset') reset() { return this.engine.reset(); }
  @Post('requests') async requests(@Body() body: unknown): Promise<BatchResponse> {
    const count = validateCount(body);
    return { results: await Promise.all(Array.from({ length: count }, () => this.engine.run())) };
  }
  @Sse('events') events(
    @Headers('last-event-id') lastEventId?: string,
    @Query('cursor') cursor?: string,
  ): Observable<MessageEvent> {
    if (cursor !== undefined && typeof cursor !== 'string') throw new ValidationError('cursor must be a string');
    // Browser reconnection header takes precedence over the original URL cursor.
    return this.engine.events(lastEventId || cursor);
  }
}

export interface BackendOptions { externalUrl?: string; policy?: Policy }
export async function createBackend(options: BackendOptions = {}) {
  const engine = new Engine(options.externalUrl ?? process.env.EXTERNAL_API_URL ?? 'http://localhost:3002', options.policy);
  @Module({ controllers: [ApiController], providers: [{ provide: Engine, useValue: engine }] })
  class AppModule {}
  const app = await NestFactory.create(AppModule, { logger: false });
  app.useGlobalFilters(new LabErrorFilter());
  app.enableShutdownHooks();
  await app.init();
  return { app, engine };
}
