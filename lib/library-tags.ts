export function formatDisplayTag(tag: string) {
  return tag.startsWith("#") ? tag : `#${tag}`;
}

export function formatDisplayTags(tags: string[], fallback: string) {
  const visible = tags.length ? tags : [fallback];
  return visible.map(formatDisplayTag).join(" ");
}
