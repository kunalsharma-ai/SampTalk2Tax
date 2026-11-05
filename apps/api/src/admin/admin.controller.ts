import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { AuthUser, CurrentUser, RequirePlatform } from '../auth/decorators';
import { openApi, ZodPipe } from '../common/zod';
import { AdminService } from './admin.service';

const Reason = z.object({ reason: z.string().max(500) }).strict();
const Note = z.object({ note: z.string().max(500).optional() }).strict();
const Role = z.object({ platformRole: z.enum(['SUPER_ADMIN', 'SUPPORT']).nullable() }).strict();
const Announcement = z
  .object({
    message: z.string().trim().min(1).max(500),
    tone: z.enum(['INFO', 'WARNING']).default('INFO'),
    startsAt: z.iso.datetime({ offset: true }).optional(),
    endsAt: z.iso.datetime({ offset: true }).nullable().optional(),
  })
  .strict();
const OrgQuery = z.object({ q: z.string().max(200).optional(), status: z.enum(['all', 'active', 'suspended']).default('all') });
const PeopleQuery = z.object({ q: z.string().max(200).optional() });

/** Platform administration. For the people who run Talk2Tax; never an organisation's books. */
@ApiTags('admin')
@ApiBearerAuth()
@Controller('v1/admin')
export class AdminController {
  constructor(private readonly admin: AdminService) {}

  @Get('overview')
  @RequirePlatform('platform.read')
  overview() {
    return this.admin.overview();
  }

  @Get('organisations')
  @RequirePlatform('platform.read')
  organisations(@Query(new ZodPipe(OrgQuery)) q: z.infer<typeof OrgQuery>) {
    return this.admin.organisations(q.q, q.status);
  }

  @Get('organisations/:id')
  @RequirePlatform('platform.read')
  organisation(@Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.organisation(id);
  }

  @Post('organisations/:id/suspend')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Reason) })
  suspend(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(Reason)) body: z.infer<typeof Reason>) {
    return this.admin.suspend(user, id, body.reason);
  }

  @Post('organisations/:id/reinstate')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Note) })
  reinstate(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(Note)) body: z.infer<typeof Note>) {
    return this.admin.reinstate(user, id, body.note);
  }

  @Get('people')
  @RequirePlatform('platform.read')
  people(@Query(new ZodPipe(PeopleQuery)) q: z.infer<typeof PeopleQuery>) {
    return this.admin.people(q.q);
  }

  @Post('people/:id/disable')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Reason) })
  disable(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(Reason)) body: z.infer<typeof Reason>) {
    return this.admin.disable(user, id, body.reason);
  }

  @Post('people/:id/enable')
  @RequirePlatform('platform.manage')
  enable(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.enable(user, id);
  }

  @Post('people/:id/sign-out')
  @RequirePlatform('platform.manage')
  signOut(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.signOut(user, id);
  }

  @Put('people/:id/platform-role')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Role) })
  setRole(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string, @Body(new ZodPipe(Role)) body: z.infer<typeof Role>) {
    return this.admin.setPlatformRole(user, id, body.platformRole);
  }

  @Get('announcements')
  @RequirePlatform('platform.read')
  announcements() {
    return this.admin.announcements();
  }

  @Post('announcements')
  @RequirePlatform('platform.manage')
  @ApiBody({ schema: openApi(Announcement) })
  announce(@CurrentUser() user: AuthUser, @Body(new ZodPipe(Announcement)) body: z.infer<typeof Announcement>) {
    return this.admin.announce(user, body);
  }

  @Post('announcements/:id/withdraw')
  @RequirePlatform('platform.manage')
  withdraw(@CurrentUser() user: AuthUser, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.admin.withdraw(user, id);
  }
}

/** Current announcements, for everyone signed in. */
@ApiTags('announcements')
@ApiBearerAuth()
@Controller('v1/announcements')
export class AnnouncementsController {
  constructor(private readonly admin: AdminService) {}

  @Get()
  current() {
    return this.admin.current();
  }
}
