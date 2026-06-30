import { BadRequestException, ConflictException, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import type { User } from "@prisma/client";
import { PrismaService } from "../../prisma/prisma.service";
import { LoginDto, RegisterDto, ResetPasswordDto, SendCodeDto } from "./auth.dto";
import {
  createCaptchaChallenge,
  createCodeHash,
  createNumericCode,
  inferChannelFromIdentifier,
  normalizeEmail,
  normalizeIdentifier,
  normalizePhone,
  type VerificationChannel,
  type VerificationPurpose,
} from "./code-utils";
import { hashPassword, verifyPassword } from "./password";

type PublicUser = Omit<User, "passwordHash" | "note">;
type CaptchaRecord = {
  answerHash: string;
  expiresAt: number;
};

function toPublicUser(user: User): PublicUser {
  const { passwordHash: _passwordHash, note: _note, ...rest } = user;
  return rest;
}

const captchaStore = new Map<string, CaptchaRecord>();
const captchaTtlMs = 3 * 60 * 1000;
const verificationCodeTtlMs = 5 * 60 * 1000;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  generateCaptcha() {
    this.clearExpiredCaptchas();
    const captcha = createCaptchaChallenge(this.codeSecret);
    captchaStore.set(captcha.captchaId, {
      answerHash: captcha.answerHash,
      expiresAt: Date.now() + captchaTtlMs,
    });
    return {
      captchaId: captcha.captchaId,
      image: captcha.image,
      expiresInSeconds: Math.floor(captchaTtlMs / 1000),
    };
  }

  async sendCode(input: SendCodeDto) {
    this.verifyCaptcha(input.captchaId, input.captchaAnswer);

    const target = this.normalizeTarget(input.channel, input.target);
    const code = createNumericCode();
    const codeHash = createCodeHash(code, this.codeSecret);
    await this.prisma.verificationCode.create({
      data: {
        target,
        channel: input.channel,
        purpose: input.purpose,
        codeHash,
        expiresAt: new Date(Date.now() + verificationCodeTtlMs),
      },
    });

    return {
      channel: input.channel,
      target,
      purpose: input.purpose,
      expiresInSeconds: Math.floor(verificationCodeTtlMs / 1000),
      debugCode: this.shouldExposeDebugCode ? code : undefined,
    };
  }

  async register(input: RegisterDto) {
    if (input.password !== input.confirmPassword) {
      throw new BadRequestException("Passwords do not match");
    }

    const email = normalizeEmail(input.email);
    const phone = normalizePhone(input.phone);
    const existing = await this.prisma.user.findFirst({
      where: { OR: [{ email }, { phone }] },
    });
    if (existing) throw new ConflictException("User already exists");

    await this.verifyAndConsumeCode(phone, "sms", "register", input.smsCode);

    const user = await this.prisma.user.create({
      data: {
        email,
        phone,
        passwordHash: await hashPassword(input.password),
      },
    });

    return this.createAuthResponse(user);
  }

  async login(input: LoginDto) {
    const identifier = normalizeIdentifier(input.identifier);
    const user = await this.prisma.user.findFirst({ where: { OR: [{ email: identifier }, { phone: identifier }] } });
    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new UnauthorizedException("Invalid account or password");
    }
    if (user.status === "DISABLED") {
      throw new UnauthorizedException("Account is disabled");
    }

    const activeUser = await this.prisma.user.update({
      where: { id: user.id },
      data: {
        lastLoginAt: new Date(),
        loginCount: { increment: 1 },
      },
    });

    return this.createAuthResponse(activeUser);
  }

  async resetPassword(input: ResetPasswordDto) {
    if (input.password !== input.confirmPassword) {
      throw new BadRequestException("Passwords do not match");
    }

    const channel = inferChannelFromIdentifier(input.identifier);
    const identifier = this.normalizeTarget(channel, input.identifier);
    const user = await this.prisma.user.findFirst({
      where: channel === "email" ? { email: identifier } : { phone: identifier },
    });
    if (!user) throw new UnauthorizedException("Account not found");

    await this.verifyAndConsumeCode(identifier, channel, "reset_password", input.code, user.id);
    const updatedUser = await this.prisma.user.update({
      where: { id: user.id },
      data: { passwordHash: await hashPassword(input.password) },
    });

    return this.createAuthResponse(updatedUser);
  }

  async getCurrentUser(userId: string) {
    const user = await this.prisma.user.findFirst({ where: { id: userId } });
    if (!user) throw new UnauthorizedException("User not found");
    if (user.status === "DISABLED") throw new UnauthorizedException("Account is disabled");
    return toPublicUser(user);
  }

  async createAuthResponse(user: User) {
    const accessToken = await this.jwtService.signAsync({
      sub: user.id,
      role: user.role,
      plan: user.plan,
    });
    return {
      accessToken,
      tokenType: "Bearer",
      user: toPublicUser(user),
    };
  }

  verifyCaptcha(captchaId: string | undefined, captchaAnswer: string | undefined) {
    if (!captchaId || !captchaAnswer) {
      throw new BadRequestException("Image captcha is required");
    }

    const record = captchaStore.get(captchaId);
    captchaStore.delete(captchaId);
    if (!record || record.expiresAt < Date.now()) {
      throw new BadRequestException("Image captcha expired");
    }

    const answerHash = createCodeHash(captchaAnswer, this.codeSecret);
    if (answerHash !== record.answerHash) {
      throw new BadRequestException("Image captcha is incorrect");
    }
  }

  async verifyAndConsumeCode(
    target: string,
    channel: VerificationChannel,
    purpose: VerificationPurpose,
    code: string,
    userId?: string,
  ) {
    const record = await this.prisma.verificationCode.findFirst({
      where: {
        target,
        channel,
        purpose,
        usedAt: null,
        expiresAt: { gt: new Date() },
      },
      orderBy: { createdAt: "desc" },
    });

    if (!record || record.codeHash !== createCodeHash(code, this.codeSecret)) {
      throw new BadRequestException("Verification code is invalid or expired");
    }

    await this.prisma.verificationCode.update({
      where: { id: record.id },
      data: { usedAt: new Date(), userId },
    });
  }

  private normalizeTarget(channel: VerificationChannel, target: string) {
    return channel === "email" ? normalizeEmail(target) : normalizePhone(target);
  }

  private clearExpiredCaptchas() {
    const now = Date.now();
    for (const [captchaId, record] of captchaStore.entries()) {
      if (record.expiresAt < now) captchaStore.delete(captchaId);
    }
  }

  private get codeSecret() {
    return this.configService.get<string>("AUTH_CODE_SECRET") || this.configService.get<string>("JWT_SECRET") || "dev-only-code-secret";
  }

  private get shouldExposeDebugCode() {
    return this.configService.get<string>("AUTH_CODE_DELIVERY") !== "real";
  }
}
