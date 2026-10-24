import { Body, Controller, HttpCode, Post, Req, Res } from '@nestjs/common';
import type { IncomingMessage, ServerResponse } from 'node:http';
import QRCode from 'qrcode';
import { z } from 'zod';
import { domainError } from '../common/domain-error.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { Authenticated, Public } from './access.decorators.js';
import { CurrentPrincipal } from './access.guard.js';
import { AuthRateLimitService } from './auth-rate-limit.service.js';
import { NativeAuthService } from './native-auth.service.js';
import { PasswordWorkLimitError } from './native-credentials.js';
import { clearCookie, readCookie, serializeCookie, SESSION_COOKIE } from './cookies.js';
import { sha256Hex } from './crypto.js';
import type { Principal } from './principal.js';

const CHALLENGE_COOKIE = 'ayvo_auth';
const password = z
  .string()
  .min(1)
  .max(1024)
  .refine((v) => Buffer.byteLength(v, 'utf8') <= 1024);
const newPassword = password.refine((v) => [...v].length >= 12);
const email = z
  .email()
  .max(254)
  .transform((v) => v.trim().toLowerCase());
const loginSchema = z.object({ email, password, next: z.string().max(2048).optional() }).strict();
const actionSchema = z.object({ token: z.string().length(43), password: newPassword }).strict();
const codeSchema = z.object({ code: z.string().min(1).max(64) }).strict();
const resetSchema = z.object({ email }).strict();
const replaceSchema = z.object({ password, code: z.string().min(1).max(64) }).strict();
const denied = () =>
  domainError(401, 'INVALID_LOGIN', 'Přihlášení se nezdařilo. Zkontrolujte údaje.');

@Controller('auth/native')
export class NativeAuthController {
  constructor(
    private readonly auth: NativeAuthService,
    private readonly limits: AuthRateLimitService,
  ) {}

  @Post('password')
  @Public()
  @HttpCode(200)
  async password(
    @Body(new ZodValidationPipe(loginSchema)) body: z.infer<typeof loginSchema>,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    await this.limit(req, res, body.email);
    const result = await this.expensive(
      () => this.auth.beginLogin(body.email, body.password, body.next),
      res,
    );
    if (!result) throw denied();
    this.challenge(res, result.token, 300);
    return { step: 'MFA' };
  }

  @Post('activate')
  @Public()
  @HttpCode(200)
  async activate(
    @Body(new ZodValidationPipe(actionSchema)) body: z.infer<typeof actionSchema>,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    await this.limit(req, res);
    const result = await this.expensive(
      () => this.auth.beginAction('ENROLL', body.token, body.password),
      res,
    );
    if (!result?.enrollmentUri)
      throw domainError(
        400,
        'INVALID_LINK',
        'Odkaz už neplatí. Požádejte správce o novou pozvánku.',
      );
    this.challenge(res, result.token, 900);
    return {
      step: 'ENROLL_MFA',
      qrDataUrl: await QRCode.toDataURL(result.enrollmentUri, {
        errorCorrectionLevel: 'M',
        width: 256,
      }),
      setupKey: new URL(result.enrollmentUri).searchParams.get('secret'),
    };
  }

  @Post('forgot-password')
  @Public()
  @HttpCode(200)
  async forgotPassword(
    @Body(new ZodValidationPipe(resetSchema)) body: z.infer<typeof resetSchema>,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    await this.limit(req, res, body.email);
    await this.auth.requestPasswordReset(body.email);
    res.setHeader('Cache-Control', 'no-store');
    return { message: 'Pokud má tento e-mail aktivní účet, pošleme odkaz na obnovu hesla.' };
  }

  @Post('reset-password')
  @Public()
  @HttpCode(200)
  async resetPassword(
    @Body(new ZodValidationPipe(actionSchema)) body: z.infer<typeof actionSchema>,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    await this.limit(req, res);
    const result = await this.expensive(
      () => this.auth.beginAction('RESET_PASSWORD', body.token, body.password),
      res,
    );
    if (!result) throw domainError(400, 'INVALID_LINK', 'Odkaz už neplatí. Vyžádejte si nový.');
    this.challenge(res, result.token, 900);
    return { step: 'MFA' };
  }

  @Post('mfa')
  @Public()
  @HttpCode(200)
  async mfa(
    @Body(new ZodValidationPipe(codeSchema)) body: z.infer<typeof codeSchema>,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    res.setHeader('Cache-Control', 'no-store');
    const token = readCookie(req, CHALLENGE_COOKIE);
    await this.limit(req, res, (await this.auth.challengeAccount(token)) ?? undefined);
    const result = await this.auth.complete(token, body.code.trim());
    if (result.kind === 'denied')
      throw domainError(
        401,
        'INVALID_MFA',
        'Kód neplatí nebo vypršel. Zkuste nový kód, případně se přihlaste znovu.',
      );
    const cookies = [clearCookie(CHALLENGE_COOKIE)];
    if (result.kind === 'reset') {
      cookies.push(clearCookie(SESSION_COOKIE));
      res.setHeader('Set-Cookie', cookies);
      return { step: 'PASSWORD_RESET', nextPath: '/login?password_reset=1' };
    }
    cookies.push(serializeCookie(SESSION_COOKIE, result.token, result.maxAgeSeconds));
    res.setHeader('Set-Cookie', cookies);
    return {
      step: 'DONE',
      nextPath: result.nextPath,
      ...(result.recoveryCodes ? { recoveryCodes: result.recoveryCodes } : {}),
    };
  }

  @Post('replace-mfa')
  @Authenticated()
  @HttpCode(200)
  async replaceMfa(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(replaceSchema)) body: z.infer<typeof replaceSchema>,
    @Req() req: IncomingMessage,
    @Res({ passthrough: true }) res: ServerResponse,
  ) {
    await this.limit(req, res, principal.userId);
    const result = await this.expensive(
      () => this.auth.beginMfaReplacement(principal.userId, body.password, body.code.trim()),
      res,
    );
    if (!result) throw denied();
    this.challenge(res, result.token, 900);
    return {
      step: 'ENROLL_MFA',
      qrDataUrl: await QRCode.toDataURL(result.enrollmentUri, {
        errorCorrectionLevel: 'M',
        width: 256,
      }),
      setupKey: new URL(result.enrollmentUri).searchParams.get('secret'),
    };
  }

  private challenge(res: ServerResponse, token: string, seconds: number): void {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Set-Cookie', serializeCookie(CHALLENGE_COOKIE, token, seconds));
  }

  private async limit(req: IncomingMessage, res: ServerResponse, account?: string): Promise<void> {
    res.setHeader('Cache-Control', 'no-store');
    // Separate account keys thwart distributed guessing; no raw email is stored in Redis.
    const decisions = [await this.limits.hit('login', `native-ip:${this.limits.clientIp(req)}`)];
    if (account)
      decisions.push(
        await this.limits.hit('callback_failure', `native-account:${sha256Hex(account)}`),
      );
    const decision = decisions.find((value) => !value.allowed);
    if (decision) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      throw domainError(
        decision.unavailable ? 503 : 429,
        decision.unavailable ? 'AUTH_UNAVAILABLE' : 'RATE_LIMITED',
        'Přihlášení je dočasně omezené. Zkuste to za chvíli.',
      );
    }
  }

  private async expensive<T>(operation: () => Promise<T>, res: ServerResponse): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof PasswordWorkLimitError) {
        res.setHeader('Retry-After', '2');
        throw domainError(503, 'AUTH_UNAVAILABLE', 'Přihlášení je vytížené. Zkuste to za chvíli.');
      }
      throw error;
    }
  }
}
