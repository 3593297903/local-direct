import { createHmac, randomInt, randomUUID } from "node:crypto";

export type VerificationChannel = "sms" | "email";
export type VerificationPurpose = "register" | "login" | "reset_password" | "bind_email";

export function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

export function normalizePhone(value: string) {
  return value.trim().replace(/\s+/g, "");
}

export function normalizeIdentifier(value: string) {
  const trimmed = value.trim();
  return trimmed.includes("@") ? normalizeEmail(trimmed) : normalizePhone(trimmed);
}

export function inferChannelFromIdentifier(value: string): VerificationChannel {
  return value.trim().includes("@") ? "email" : "sms";
}

export function createNumericCode(length = 6) {
  const max = 10 ** length;
  return randomInt(0, max).toString().padStart(length, "0");
}

export function createCaptchaAnswer(length = 5) {
  const alphabet = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
  let answer = "";
  for (let index = 0; index < length; index += 1) {
    answer += alphabet[randomInt(0, alphabet.length)];
  }
  return answer;
}

export function createCodeHash(value: string, secret: string) {
  return createHmac("sha256", secret).update(value.trim().toUpperCase()).digest("hex");
}

export function createCaptchaSvgDataUrl(answer: string) {
  const letters = answer
    .split("")
    .map((letter, index) => {
      const x = 24 + index * 24;
      const y = 37 + (index % 2 === 0 ? -2 : 3);
      const rotate = index % 2 === 0 ? -8 : 7;
      return `<text x="${x}" y="${y}" transform="rotate(${rotate} ${x} ${y})">${letter}</text>`;
    })
    .join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="54" viewBox="0 0 160 54"><rect width="160" height="54" rx="12" fill="#07111f"/><path d="M12 34 C45 8 75 50 148 18" stroke="#67e8f9" stroke-opacity=".35" stroke-width="2" fill="none"/><path d="M10 17 H150 M16 43 H144" stroke="#a78bfa" stroke-opacity=".18"/><g fill="#ecfeff" font-family="Consolas, monospace" font-size="24" font-weight="800" letter-spacing="3">${letters}</g></svg>`;
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

export function createCaptchaChallenge(secret: string) {
  const answer = createCaptchaAnswer();
  return {
    captchaId: randomUUID(),
    answerHash: createCodeHash(answer, secret),
    image: createCaptchaSvgDataUrl(answer),
  };
}
