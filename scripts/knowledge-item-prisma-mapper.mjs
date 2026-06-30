const frontendToPrismaType = {
  transition: "TRANSITION",
  shot: "SHOT",
  camera_movement: "CAMERA_MOVEMENT",
  style: "STYLE",
  storyboard_formula: "STORYBOARD_FORMULA",
};

const prismaToFrontendType = Object.fromEntries(
  Object.entries(frontendToPrismaType).map(([frontend, prisma]) => [prisma, frontend]),
);

const typeRank = {
  transition: 0,
  shot: 1,
  camera_movement: 2,
  style: 3,
  storyboard_formula: 4,
};

export function toPrismaKnowledgeType(type) {
  const value = frontendToPrismaType[type];
  if (!value) throw new Error(`Unsupported knowledge type: ${type}`);
  return value;
}

export function toFrontendKnowledgeType(type) {
  const value = prismaToFrontendType[type];
  if (!value) throw new Error(`Unsupported Prisma knowledge type: ${type}`);
  return value;
}

export function mapKnowledgeItemToPrismaInput(item) {
  return {
    id: String(item.id),
    type: toPrismaKnowledgeType(item.type),
    category: String(item.category || ""),
    name: String(item.name || ""),
    description: String(item.description || ""),
    prompt: String(item.prompt || ""),
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    genre: item.genre || null,
    order: Number.isFinite(Number(item.order)) ? Number(item.order) : 0,
    stability: Number.isFinite(Number(item.stability)) ? Number(item.stability) : 90,
    useCase: item.useCase || null,
    avoid: item.avoid || null,
    previewUrl: item.previewUrl || null,
    previewMimeType: item.previewMimeType || null,
    posterUrl: item.posterUrl || null,
    previewType: item.previewType || null,
  };
}

export function mapPrismaLibraryItemToKnowledgeItem(item) {
  return {
    id: item.id,
    type: toFrontendKnowledgeType(item.type),
    category: item.category,
    name: item.name,
    description: item.description,
    prompt: item.prompt,
    tags: Array.isArray(item.tags) ? item.tags : [],
    genre: item.genre || undefined,
    stability: item.stability,
    order: item.order || undefined,
    useCase: item.useCase || "",
    avoid: item.avoid || undefined,
    previewUrl: item.previewUrl || undefined,
    previewMimeType: item.previewMimeType || undefined,
    posterUrl: item.posterUrl || undefined,
    previewType: item.previewType || undefined,
  };
}

function orderValue(item, fallback) {
  const order = Number(item.order);
  return Number.isFinite(order) && order > 0 ? order : fallback + 1;
}

export function sortLibraryItemsForApi(items) {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftRank = typeRank[left.item.type] ?? 99;
      const rightRank = typeRank[right.item.type] ?? 99;
      if (leftRank !== rightRank) return leftRank - rightRank;
      const leftOrder = orderValue(left.item, left.index);
      const rightOrder = orderValue(right.item, right.index);
      if (leftOrder !== rightOrder) return leftOrder - rightOrder;
      return left.index - right.index;
    })
    .map(({ item }) => item);
}

export function filterLibraryItemsForApi(items, { q = "", type = "" } = {}) {
  const query = String(q || "").trim().toLowerCase();
  return sortLibraryItemsForApi(
    items.filter((item) => {
      const typeMatch = !type || item.type === type;
      if (!query) return typeMatch;
      const haystack = [
        item.name,
        item.category,
        item.genre || "",
        item.description,
        item.prompt,
        Array.isArray(item.tags) ? item.tags.join(" ") : "",
      ]
        .join(" ")
        .toLowerCase();
      return typeMatch && haystack.includes(query);
    }),
  );
}
