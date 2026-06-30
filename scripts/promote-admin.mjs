import { PrismaClient } from "@prisma/client";
import { pathToFileURL } from "node:url";

/** Normalize an email (lowercase) or phone (strip spaces) login identifier. */
export function normalizeIdentifier(value) {
  const trimmed = String(value || "").trim();
  return trimmed.includes("@") ? trimmed.toLowerCase() : trimmed.replace(/\s+/g, "");
}

async function main() {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith("--"));
  const revoke = process.argv.includes("--revoke");
  const identifier = normalizeIdentifier(positional[0]);

  if (!identifier) {
    console.error("Usage: node scripts/promote-admin.mjs <email|phone> [--revoke]");
    process.exit(1);
  }

  const role = revoke ? "USER" : "ADMIN";
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findFirst({
      where: { OR: [{ email: identifier }, { phone: identifier }] },
      select: { id: true, email: true, phone: true, role: true },
    });

    if (!user) {
      console.error(`No user found for "${identifier}". Register the account first, then run this again.`);
      process.exit(1);
    }

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: { role },
      select: { id: true, email: true, phone: true, role: true },
    });

    console.log(`Updated ${updated.email || updated.phone} -> role=${updated.role}`);
  } finally {
    await prisma.$disconnect();
  }
}

// Only run main() when invoked directly, so tests can import normalizeIdentifier
// without opening a database connection.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
