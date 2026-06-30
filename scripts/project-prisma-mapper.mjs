export function mapAnalysisResultToProjectCreateInput({ userId, originalScript, result }) {
  if (!userId) throw new Error("userId is required to create a project");
  if (!result?.title) throw new Error("result.title is required to create a project");

  const project = {
    userId,
    title: result.title,
    originalScript: originalScript || "",
    optimizedScript: result.optimizedScript || null,
    contentType: result.contentType || null,
    style: result.style || null,
    duration: result.duration || null,
    status: "draft",
  };

  const shots = Array.isArray(result.storyboard)
    ? result.storyboard.map((shot) => ({
      shotNumber: Number(shot.shotNumber),
      scene: shot.scene || null,
      visual: shot.visual || null,
      shotType: shot.shotType || null,
      cameraMovement: shot.cameraMovement || null,
      emotion: shot.emotion || null,
      transition: shot.transition || null,
      firstFramePrompt: shot.firstFramePrompt || null,
      videoPrompt: shot.videoPrompt || null,
      lastFramePrompt: shot.lastFramePrompt || null,
      negativePrompt: shot.negativePrompt || null,
    }))
    : [];

  return { project, shots };
}

export function mapPrismaProjectToProjectSummary(project) {
  return {
    id: project.id,
    title: project.title,
    content_type: project.contentType || null,
    style: project.style || null,
    duration: project.duration || null,
    status: project.status,
    created_at: project.createdAt instanceof Date ? project.createdAt.toISOString() : project.createdAt,
  };
}
