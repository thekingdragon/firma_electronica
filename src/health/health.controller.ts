import { Controller, Get, Inject, ServiceUnavailableException } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_POOL } from '../db/db.module';

@Controller('v1/health')
export class HealthController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  @Get()
  async check(): Promise<{ database: 'up' }> {
    try {
      await this.pool.query('SELECT 1');
      return { database: 'up' };
    } catch {
      throw new ServiceUnavailableException({ database: 'down' });
    }
  }
}
