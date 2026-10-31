import { Body, Controller, Get, HttpCode, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { openApi, ZodPipe } from '../common/zod';
import { AuthService } from './auth.service';
import { AuthUser, CurrentUser, Public } from './decorators';

const RegisterBody = z.object({
  email: z.email().max(254),
  name: z.string().trim().min(1).max(120),
  password: z.string().min(1).max(256),
});
const LoginBody = z.object({ email: z.email().max(254), password: z.string().min(1).max(256) });

@ApiTags('auth')
@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaService,
  ) {}

  @Public()
  @Post('register')
  @ApiBody({ schema: openApi(RegisterBody) })
  register(@Body(new ZodPipe(RegisterBody)) body: z.infer<typeof RegisterBody>) {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @ApiBody({ schema: openApi(LoginBody) })
  login(@Body(new ZodPipe(LoginBody)) body: z.infer<typeof LoginBody>) {
    return this.auth.login(body);
  }

  @Get('me')
  @ApiBearerAuth()
  async me(@CurrentUser() user: AuthUser) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId: user.id },
      include: { org: { select: { id: true, name: true, isDemo: true, functionalCurrency: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return { user, organizations: memberships.map((m) => ({ ...m.org, role: m.role })) };
  }
}
