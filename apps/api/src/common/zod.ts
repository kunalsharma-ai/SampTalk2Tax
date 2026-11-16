import { BadRequestException, PipeTransform } from '@nestjs/common';
import { z, ZodType } from 'zod';

export class ZodPipe<T extends ZodType> implements PipeTransform {
  constructor(private readonly schema: T) {}
  transform(value: unknown): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        error: 'VALIDATION_FAILED',
        message: 'Request validation failed',
        issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      });
    }
    return result.data;
  }
}

/** OpenAPI schema object for a zod schema (used with @ApiBody / @ApiQuery). */
export function openApi(schema: ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  return json;
}

export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const decimalString = z.string().regex(/^\d{1,18}(\.\d{1,10})?$/, 'Expected a non-negative decimal string, e.g. "1250.00"');
export const uuid = z.uuid();
