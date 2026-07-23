function positiveInteger(value, fallback) {
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric > 0 ? numeric : fallback;
}

function durationSeconds(value, fallback = 15) {
  const numeric = Number.parseFloat(String(value ?? ""));
  return Number.isFinite(numeric) && numeric > 0 ? Math.min(15, numeric) : fallback;
}

function nonEmptyArray(value) {
  return Array.isArray(value) && value.length > 0;
}

function deterministicShotBeats(segmentIndex, shotCount, duration) {
  const shotDuration = duration / shotCount;
  return Array.from({ length: shotCount }, (_, offset) => ({
    shotNumber: offset + 1,
    timeRange: `${Number((offset * shotDuration).toFixed(2))}s-${Number(((offset + 1) * shotDuration).toFixed(2))}s`,
    beat: `Segment ${segmentIndex} test event beat ${offset + 1}`,
    visualFocus: `Segment ${segmentIndex} deterministic visual ${offset + 1}`,
  }));
}

export function withAuthoritativeRenderContract(segment, dependencies) {
  const { normalizeSegmentContract, compileSegmentContractForPrompt } = dependencies || {};
  if (typeof normalizeSegmentContract !== "function" || typeof compileSegmentContractForPrompt !== "function") {
    throw new TypeError("Authoritative Render fixture requires explicit Contract dependencies");
  }
  if (!segment || typeof segment !== "object") {
    throw new TypeError("Authoritative Render fixture requires a segment object");
  }

  const originalContract = segment.segmentContract && typeof segment.segmentContract === "object"
    ? structuredClone(segment.segmentContract)
    : {};
  const segmentIndex = positiveInteger(segment.episodeIndex, 0);
  if (!segmentIndex) throw new TypeError("Authoritative Render fixture requires a positive episodeIndex");

  const sourceText = String(segment.script ?? "").trim() || `Segment ${segmentIndex} deterministic source text.`;
  const title = String(segment.title ?? "").trim() || `Segment ${segmentIndex}`;
  const shotCount = positiveInteger(segment.shotCount, positiveInteger(originalContract.shotCount, 4));
  const resolvedDuration = durationSeconds(
    originalContract.durationSeconds ?? originalContract.duration ?? segment.duration,
    15,
  );
  const requiredEvents = nonEmptyArray(originalContract.requiredEvents)
    ? structuredClone(originalContract.requiredEvents)
    : [`Preserve segment ${segmentIndex} deterministic source event`];
  const requiredShotBeats = nonEmptyArray(originalContract.requiredShotBeats)
    ? structuredClone(originalContract.requiredShotBeats)
    : deterministicShotBeats(segmentIndex, shotCount, resolvedDuration);

  const {
    sourceHash: _staleSourceHash,
    contractHash: _staleContractHash,
    ...contractFields
  } = originalContract;
  const contract = normalizeSegmentContract({
    ...contractFields,
    segmentIndex,
    title,
    sourceText,
    durationSeconds: resolvedDuration,
    shotCount,
    requiredEvents,
    requiredShotBeats,
  }, {
    segmentIndex,
    fallbackTitle: title,
    fallbackSourceText: sourceText,
    fallbackDurationSeconds: resolvedDuration,
    fallbackShotCount: shotCount,
  });
  const compiledContract = compileSegmentContractForPrompt(contract);
  if (compiledContract.status !== "ready" && compiledContract.status !== "compacted") {
    throw new Error(
      `Authoritative Render fixture could not compile segment ${segmentIndex}: ${compiledContract.status}`,
    );
  }

  return {
    ...structuredClone(segment),
    shotCount: contract.shotCount,
    segmentContract: contract,
    compiledContract,
  };
}

export function withAuthoritativeRenderPackInput(input, dependencies) {
  if (!input || typeof input !== "object" || !Array.isArray(input.segments)) {
    throw new TypeError("Authoritative Render fixture requires a pack input with segments");
  }
  return {
    ...structuredClone(input),
    segments: input.segments.map((segment) => withAuthoritativeRenderContract(segment, dependencies)),
  };
}
