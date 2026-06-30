import { AnalysisResult } from "@/types";
import { createClient } from "@/lib/supabase-server";

export async function saveProject(input: {
  userId?: string;
  originalScript: string;
  result: AnalysisResult;
}) {
  const supabase = await createClient();
  if (!supabase || !input.userId) return { saved: false, reason: "Supabase or user not configured" };

  const { data: project, error } = await supabase
    .from("projects")
    .insert({
      user_id: input.userId,
      title: input.result.title,
      original_script: input.originalScript,
      optimized_script: input.result.optimizedScript,
      content_type: input.result.contentType,
      style: input.result.style,
      duration: input.result.duration,
      status: "draft",
    })
    .select("id")
    .single();

  if (error || !project) return { saved: false, reason: error?.message || "Project insert failed" };

  const shots = input.result.storyboard.map((shot) => ({
    project_id: project.id,
    shot_number: shot.shotNumber,
    scene: shot.scene,
    visual: shot.visual,
    shot_type: shot.shotType,
    camera_movement: shot.cameraMovement,
    emotion: shot.emotion,
    transition: shot.transition,
    first_frame_prompt: shot.firstFramePrompt,
    video_prompt: shot.videoPrompt,
    last_frame_prompt: shot.lastFramePrompt,
    negative_prompt: shot.negativePrompt,
  }));

  const { error: shotError } = await supabase.from("storyboard_shots").insert(shots);
  if (shotError) return { saved: false, reason: shotError.message };
  return { saved: true, projectId: project.id };
}
