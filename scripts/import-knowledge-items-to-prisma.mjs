import { PrismaClient } from "@prisma/client";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mapKnowledgeItemToPrismaInput } from "./knowledge-item-prisma-mapper.mjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");

async function main() {
  const dataPath = process.argv[2] || path.join(root, "data", "knowledge-items.json");
  const raw = await readFile(dataPath, "utf8");
  const items = JSON.parse(raw);
  if (!Array.isArray(items)) throw new Error(`${dataPath} must contain an array`);

  const prisma = new PrismaClient();
  let imported = 0;
  try {
    for (const item of items) {
      const input = mapKnowledgeItemToPrismaInput(item);
      await prisma.libraryItem.upsert({
        where: { id: input.id },
        create: input,
        update: input,
      });
      imported += 1;
    }
  } finally {
    await prisma.$disconnect();
  }

  console.log(`Imported ${imported} library items from ${dataPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
