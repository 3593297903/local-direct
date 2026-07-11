export function shouldPublishProjectVersionMemory(status: string | null | undefined) {
  return String(status || "draft").trim().toLowerCase() !== "needs_review";
}
