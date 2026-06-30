import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const keyLength = 64;

export async function hashPassword(password: string) {
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  const salt = randomBytes(16).toString("base64url");
  const derivedKey = (await scrypt(password, salt, keyLength)) as Buffer;
  return `scrypt$${salt}$${Buffer.from(derivedKey).toString("base64url")}`;
}

export async function verifyPassword(password: string, storedHash: string | null | undefined) {
  const [algorithm, salt, hash] = String(storedHash || "").split("$");
  if (algorithm !== "scrypt" || !salt || !hash) return false;

  const storedBuffer = Buffer.from(hash, "base64url");
  const derivedKey = (await scrypt(password, salt, storedBuffer.length)) as Buffer;
  const derivedBuffer = Buffer.from(derivedKey);
  if (storedBuffer.length !== derivedBuffer.length) return false;
  return timingSafeEqual(storedBuffer, derivedBuffer);
}
