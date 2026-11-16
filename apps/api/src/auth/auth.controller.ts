import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { DISPLAY_DATE_FORMAT_CODES, isTimeZone, LANGUAGE_CODES, NUMBER_FORMAT_CODES } from '@talk2tax/accounting-engine';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { openApi, ZodPipe } from '../common/zod';
import { AuthService } from './auth.service';
import { AuthUser, CurrentSession, CurrentUser, Public } from './decorators';
import { AuthRateLimit } from './rate-limit';
import { ClientMeta, SessionsService } from './sessions.service';

const RegisterBody = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(256),
});
const LoginBody = z.object({ email: z.email().max(254), password: z.string().min(1).max(256) });
const RefreshBody = z.object({ refreshToken: z.string().min(1).max(200) });
const PreferencesBody = z
  .object({
    language: z.enum(LANGUAGE_CODES),
    numberFormat: z.enum(NUMBER_FORMAT_CODES),
    dateFormat: z.enum(DISPLAY_DATE_FORMAT_CODES),
    timeZone: z.string().trim().max(64).refine(isTimeZone, 'Choose a time zone such as Asia/Kolkata or Europe/London').nullable(),
  })
  .strict();
const PasswordBody = z.object({ currentPassword: z.string().min(1).max(256), newPassword: z.string().min(1).max(256) });

function meta(req: Request): ClientMeta {
  const ua = req.headers['user-agent'];
  return { ip: req.ip ?? null, userAgent: typeof ua === 'string' ? ua : null };
}

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @AuthRateLimit()
  @Post('register')
  @ApiBody({ schema: openApi(RegisterBody) })
  register(@Body(new ZodPipe(RegisterBody)) body: z.infer<typeof RegisterBody>, @Req() req: Request) {
    return this.auth.register(body, meta(req));
  }

  @Public()
  @AuthRateLimit()
  @Post('login')
  @HttpCode(200)
  @ApiBody({ schema: openApi(LoginBody) })
  login(@Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>, @Req() req: Request) {
    return this.auth.login(body, meta(req));
  }

  /** Swap a refresh token for a new access token and (usually) a new refresh token. */
  @Public()
  @AuthRateLimit()
  @Post('refresh')
  @HttpCode(200)
  @ApiBody({ schema: openApi(RefreshBody) })
  refresh(@Body(new ZodPipe(RefreshBody)) body: z.infer<typeof RefreshBody>, @Req() req: Request) {
    return this.sessions.refresh(body.refreshToken, meta(req));
  }

  /** Sign out with a refresh token; works when the access token has already expired. Always 204. */
  @Public()
  @AuthRateLimit()
  @Post('logout')
  @HttpCode(204)
  @ApiBody({ schema: openApi(RefreshBody) })
  async logout(@Body(new ZodPipe(RefreshBody)) body: z.infer<typeof RefreshBody>) {
    await this.sessions.signOutWithRefreshToken(body.refreshToken);
  }

  @Get('me')
  @ApiBearerAuth()
  async me(@CurrentUser() user: AuthUser) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId: user.id },
      include: { org: { select: { id: true, name: true, isDemo: true, functionalCurrency: true, timeZone: true } } },
      orderBy: { createdAt: 'asc' },
    });
    const preferences = await this.preferences(user.id);
    return { user, preferences, organizations: memberships.map((m) => ({ ...m.org, role: m.role })) };
  }

  private async preferences(userId: string) {
    const u = await this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { language: true, numberFormat: true, dateFormat: true, timeZone: true } });
    return u;
  }

  /** My interface language and how numbers, dates and times are shown to me. Time zone null = each organisation's own. */
  @Put('me/preferences')
  @ApiBearerAuth()
  @ApiBody({ schema: openApi(PreferencesBody) })
  async savePreferences(@CurrentUser() user: AuthUser, @Body(new ZodPipe(PreferencesBody)) body: z.infer<typeof PreferencesBody>) {
    await this.prisma.user.update({ where: { id: user.id }, data: body });
    return this.preferences(user.id);
  }

  @Get('sessions')
  @ApiBearerAuth()
  listSessions(@CurrentUser() user: AuthUser, @CurrentSession() sid: string) {
    return this.sessions.list(user.id, sid);
  }

  @Delete('sessions/current')
  @ApiBearerAuth()
  @HttpCode(204)
  async signOutCurrent(@CurrentUser() user: AuthUser, @CurrentSession() sid: string) {
    await this.sessions.signOut({ userId: user.id, sessionId: sid });
  }

  @Delete('sessions/:sessionId')
  @ApiBearerAuth()
  @HttpCode(204)
  async revokeSession(@CurrentUser() user: AuthUser, @Param('sessionId', new ParseUUIDPipe()) sessionId: string) {
    await this.sessions.revokeOne(user.id, sessionId);
  }

  /** Sign out every other device. */
  @Post('sessions/revoke-others')
  @ApiBearerAuth()
  @HttpCode(200)
  async revokeOthers(@CurrentUser() user: AuthUser, @CurrentSession() sid: string) {
    return { signedOut: await this.sessions.revokeOthers(null, user.id, sid, 'signed_out_elsewhere') };
  }

  @Put('password')
  @ApiBearerAuth()
  @ApiBody({ schema: openApi(PasswordBody) })
  changePassword(@CurrentUser() user: AuthUser, @CurrentSession() sid: string, @Body(new ZodPipe(PasswordBody)) body: z.infer<typeof PasswordBody>) {
    return this.auth.changePassword(user.id, sid, body);
  }
}
