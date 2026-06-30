import { IsEmail, IsIn, IsOptional, IsString, MinLength } from "class-validator";

export class RegisterDto {
  @IsEmail()
  email!: string;

  @IsString()
  phone!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @MinLength(8)
  confirmPassword!: string;

  @IsString()
  smsCode!: string;
}

export class LoginDto {
  @IsString()
  identifier!: string;

  @IsString()
  @MinLength(8)
  password!: string;
}

export class SendCodeDto {
  @IsString()
  target!: string;

  @IsIn(["sms", "email"])
  channel!: "sms" | "email";

  @IsIn(["register", "login", "reset_password", "bind_email"])
  purpose!: "register" | "login" | "reset_password" | "bind_email";

  @IsOptional()
  @IsString()
  captchaId?: string;

  @IsOptional()
  @IsString()
  captchaAnswer?: string;
}

export class ResetPasswordDto {
  @IsString()
  identifier!: string;

  @IsString()
  code!: string;

  @IsString()
  @MinLength(8)
  password!: string;

  @IsString()
  @MinLength(8)
  confirmPassword!: string;
}
