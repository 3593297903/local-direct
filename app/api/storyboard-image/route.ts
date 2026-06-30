import { NextResponse } from "next/server";
import { z } from "zod";
import { checkRateLimit, rateLimitKey } from "@/lib/rate-limit";
import { createRequestId, durationSince, logger } from "@/lib/logger";

const ShotSchema = z.object({
  shotNumber: z.number(),
  scene: z.string(),
  visual: z.string(),
  shotType: z.string(),
  cameraMovement: z.string(),
  emotion: z.string(),
  transition: z.string(),
  videoPrompt: z.string(),
  negativePrompt: z.string(),
});

const RequestSchema = z.object({
  title: z.string().default("AI 视频分镜图"),
  style: z.string().default("电影感铅笔分镜草图"),
  storyboard: z.array(ShotSchema).min(1).max(8),
});

type ImageRequest = z.infer<typeof RequestSchema>;

function getEnv(name: string, fallback = "") {
  return process.env[name] || fallback;
}

function normalizeGeminiImageModel(model: string) {
  if (!model || model === "gemini-2.5-flash-image-preview") return "gemini-2.5-flash-image";
  return model;
}

function buildStoryboardPrompt(input: ImageRequest) {
  const panelCount = input.storyboard.length;
  const panelChecklist = input.storyboard
    .map((shot) => `- Row ${shot.shotNumber}: must contain ONLY shot ${shot.shotNumber}, labeled 镜头${shot.shotNumber}`)
    .join("\n");
  const shots = input.storyboard
    .map((shot) =>
      [
        `Panel ${shot.shotNumber} / 镜头${shot.shotNumber}`,
        `Scene: ${shot.scene}`,
        `Visual action: ${shot.visual}`,
        `Shot size and angle: ${shot.shotType}`,
        `Camera movement implied by composition: ${shot.cameraMovement}`,
        `Mood: ${shot.emotion}`,
        `Transition intent: ${shot.transition}`,
        `Video prompt reference: ${shot.videoPrompt}`,
        `Avoid: ${shot.negativePrompt}`,
      ].join("\n")
    )
    .join("\n\n");

  return `
Create ONE tall vertical storyboard sheet, like a professional hand-drawn film storyboard.

Non-negotiable panel count:
- The storyboard has exactly ${panelCount} shots, so the final image MUST have exactly ${panelCount} separate panels.
- Draw the canvas as exactly ${panelCount} equal-height horizontal rows before illustrating anything.
- Do NOT merge two shots into one panel.
- Do NOT create fewer than ${panelCount} panels.
- Do NOT create extra panels.
- Every row must be separated by a thick, straight, full-width black horizontal divider.
- The row order must be top to bottom: ${input.storyboard.map((shot) => `镜头${shot.shotNumber}`).join(" → ")}.
- Checklist:
${panelChecklist}

Visual style:
- grayscale pencil sketch, cinematic storyboard, rich hand-drawn cross hatching, realistic people and environments
- dramatic lighting, clear foreground/midground/background, rain/noir atmosphere when relevant
- each panel must be a real illustrated scene, not an infographic, not a text card, not abstract lines
- no UI, no website screenshot, no watermark, no captions, no large body text
- the only allowed text in the image is a small white label at the top-left of each panel: 镜头1, 镜头2, 镜头3...

Layout:
- exactly ${panelCount} wide horizontal panels stacked vertically in one image
- all panels should have the same height and fill the full width
- thick black dividers between panels
- each panel fills the full width and has detailed illustrated content
- each panel must match the same-numbered shot below
- preserve consistent character identity, clothing, age, props, setting direction, and lighting across panels

Title/context: ${input.title}
Overall tone: ${input.style}

Storyboard shots:
${shots}
`.trim();
}

function buildSinglePanelPrompt(input: ImageRequest, shot: ImageRequest["storyboard"][number]) {
  return `
Create ONE single storyboard panel for shot ${shot.shotNumber}.

This request must produce exactly one illustrated scene, not a multi-panel sheet.

Visual style:
- grayscale pencil sketch, cinematic storyboard, rich hand-drawn cross hatching, realistic people and environments
- dramatic lighting, clear foreground/midground/background, rain/noir atmosphere when relevant
- no UI, no website screenshot, no watermark, no captions, no large body text
- the only allowed text in the image is a small white label at the top-left: 镜头${shot.shotNumber}

Panel requirements:
- horizontal cinematic frame, 16:9 composition
- fill the full image with this one shot only
- preserve character identity, clothing, age, props, setting direction, and lighting from the whole storyboard context
- do not include any other numbered panels
- do not split the image into multiple rows

Title/context: ${input.title}
Overall tone: ${input.style}

Shot ${shot.shotNumber}:
Scene: ${shot.scene}
Visual action: ${shot.visual}
Shot size and angle: ${shot.shotType}
Camera movement implied by composition: ${shot.cameraMovement}
Mood: ${shot.emotion}
Transition intent: ${shot.transition}
Video prompt reference: ${shot.videoPrompt}
Avoid: ${shot.negativePrompt}
`.trim();
}

function svgEscape(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function makeMockStoryboard(input: ImageRequest) {
  const panelWidth = 960;
  const panelHeight = 360;
  const height = panelHeight * input.storyboard.length;
  const panels = input.storyboard
    .map((shot, index) => {
      const y = index * panelHeight;
      const text = svgEscape(shot.visual.slice(0, 68));
      const mood = svgEscape(`${shot.shotType} / ${shot.cameraMovement} / ${shot.emotion}`.slice(0, 42));
      return `
        <g transform="translate(0 ${y})">
          <rect x="0" y="0" width="${panelWidth}" height="${panelHeight}" fill="#d8d4ca"/>
          <rect x="0" y="0" width="${panelWidth}" height="${panelHeight}" fill="url(#grain)" opacity="0.36"/>
          <rect x="0" y="0" width="${panelWidth}" height="${panelHeight}" fill="none" stroke="#111" stroke-width="8"/>
          <rect x="18" y="16" width="142" height="56" fill="#f3f0e8" stroke="#111" stroke-width="3"/>
          <text x="38" y="54" fill="#111" font-size="32" font-weight="700">镜头${shot.shotNumber}</text>
          <path d="M260 300 C380 110 580 110 710 300" fill="none" stroke="#1d1d1d" stroke-width="4" opacity="0.8"/>
          <path d="M330 110 C410 70 530 70 615 110" fill="none" stroke="#1d1d1d" stroke-width="3" opacity="0.65"/>
          <path d="M220 260 L760 120" stroke="#1d1d1d" stroke-width="3" opacity="0.35"/>
          <path d="M210 130 L790 275" stroke="#1d1d1d" stroke-width="2" opacity="0.24"/>
          <text x="205" y="188" fill="#222" font-size="26" font-weight="700">${text}</text>
          <text x="205" y="232" fill="#333" font-size="22">${mood}</text>
        </g>`;
    })
    .join("");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth}" height="${height}" viewBox="0 0 ${panelWidth} ${height}">
      <defs>
        <pattern id="grain" width="18" height="18" patternUnits="userSpaceOnUse">
          <path d="M0 18 L18 0 M-4 10 L10 -4 M8 22 L22 8" stroke="#111" stroke-width="1" opacity="0.18"/>
        </pattern>
      </defs>
      ${panels}
    </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function makeMockStoryboardPanel(shot: ImageRequest["storyboard"][number]) {
  const panelWidth = 960;
  const panelHeight = 540;
  const text = svgEscape(shot.visual.slice(0, 68));
  const mood = svgEscape(`${shot.shotType} / ${shot.cameraMovement} / ${shot.emotion}`.slice(0, 42));
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${panelWidth}" height="${panelHeight}" viewBox="0 0 ${panelWidth} ${panelHeight}">
      <defs>
        <pattern id="grain" width="18" height="18" patternUnits="userSpaceOnUse">
          <path d="M0 18 L18 0 M-4 10 L10 -4 M8 22 L22 8" stroke="#111" stroke-width="1" opacity="0.18"/>
        </pattern>
      </defs>
      <rect x="0" y="0" width="${panelWidth}" height="${panelHeight}" fill="#d8d4ca"/>
      <rect x="0" y="0" width="${panelWidth}" height="${panelHeight}" fill="url(#grain)" opacity="0.36"/>
      <rect x="0" y="0" width="${panelWidth}" height="${panelHeight}" fill="none" stroke="#111" stroke-width="8"/>
      <rect x="18" y="16" width="142" height="56" fill="#f3f0e8" stroke="#111" stroke-width="3"/>
      <text x="38" y="54" fill="#111" font-size="32" font-weight="700">镜头${shot.shotNumber}</text>
      <path d="M260 430 C380 170 580 170 710 430" fill="none" stroke="#1d1d1d" stroke-width="4" opacity="0.8"/>
      <path d="M330 160 C410 90 530 90 615 160" fill="none" stroke="#1d1d1d" stroke-width="3" opacity="0.65"/>
      <path d="M220 380 L760 140" stroke="#1d1d1d" stroke-width="3" opacity="0.35"/>
      <path d="M210 150 L790 420" stroke="#1d1d1d" stroke-width="2" opacity="0.24"/>
      <text x="205" y="250" fill="#222" font-size="26" font-weight="700">${text}</text>
      <text x="205" y="294" fill="#333" font-size="22">${mood}</text>
    </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function makeSheetFromPanelImages(panels: Array<{ shotNumber: number; imageUrl: string }>) {
  const width = 1024;
  const panelHeight = 576;
  const divider = 16;
  const height = panels.length * panelHeight + Math.max(0, panels.length - 1) * divider;
  const images = panels
    .map((panel, index) => {
      const y = index * (panelHeight + divider);
      return `
        <g transform="translate(0 ${y})">
          <rect x="0" y="0" width="${width}" height="${panelHeight}" fill="#050816"/>
          <image href="${svgEscape(panel.imageUrl)}" x="0" y="0" width="${width}" height="${panelHeight}" preserveAspectRatio="xMidYMid slice"/>
          <rect x="0" y="0" width="${width}" height="${panelHeight}" fill="none" stroke="#050505" stroke-width="8"/>
          <rect x="18" y="16" width="130" height="48" fill="#f3f0e8" stroke="#111" stroke-width="3"/>
          <text x="34" y="49" fill="#111" font-size="28" font-weight="700">镜头${panel.shotNumber}</text>
        </g>`;
    })
    .join("");
  const dividers = panels.slice(1)
    .map((_, index) => {
      const y = (index + 1) * panelHeight + index * divider;
      return `<rect x="0" y="${y}" width="${width}" height="${divider}" fill="#050505"/>`;
    })
    .join("");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect x="0" y="0" width="${width}" height="${height}" fill="#050505"/>
      ${images}
      ${dividers}
    </svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function findImageFromOpenAICompatible(data: any) {
  const first = data?.data?.[0];
  if (first?.b64_json) return `data:image/png;base64,${first.b64_json}`;
  if (first?.url) return first.url;
  return "";
}

function findImageFromOpenRouter(data: any) {
  const message = data?.choices?.[0]?.message;
  const images = message?.images || message?.image_urls;
  const fromImages = images?.[0]?.image_url?.url || images?.[0]?.url;
  if (fromImages) return fromImages;

  const content = Array.isArray(message?.content) ? message.content : [];
  for (const part of content) {
    const imageUrl = part?.image_url?.url || part?.imageUrl?.url || part?.url;
    if (imageUrl) return imageUrl;
  }
  return "";
}

function findImageFromGemini(data: any) {
  const parts = data?.candidates?.[0]?.content?.parts || [];
  for (const part of parts) {
    const inlineData = part?.inlineData || part?.inline_data;
    if (inlineData?.data) return `data:${inlineData.mimeType || inlineData.mime_type || "image/png"};base64,${inlineData.data}`;
  }
  return "";
}

async function callOpenAICompatible(prompt: string) {
  const apiKey = getEnv("IMAGE_API_KEY");
  if (!apiKey) throw new Error("Missing IMAGE_API_KEY");

  const baseUrl = getEnv("IMAGE_API_BASE_URL", "https://api.openai.com/v1").replace(/\/$/, "");
  const endpoint = getEnv("IMAGE_API_ENDPOINT", "/images/generations");
  const model = getEnv("IMAGE_MODEL", "gpt-image-1");
  const size = getEnv("IMAGE_SIZE", "1024x1536");

  const res = await fetch(`${baseUrl}${endpoint.startsWith("/") ? endpoint : `/${endpoint}`}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({ model, prompt, size, n: 1 }),
  });

  if (!res.ok) throw new Error(`Image request failed: ${res.status} ${await res.text()}`);
  const imageUrl = findImageFromOpenAICompatible(await res.json());
  if (!imageUrl) throw new Error("Image provider returned no image");
  return imageUrl;
}

async function callOpenRouter(prompt: string) {
  const apiKey = getEnv("IMAGE_API_KEY");
  if (!apiKey) throw new Error("Missing IMAGE_API_KEY");

  const baseUrl = getEnv("IMAGE_API_BASE_URL", "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const model = normalizeGeminiImageModel(getEnv("IMAGE_MODEL", "google/gemini-2.5-flash-image"));

  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      "HTTP-Referer": getEnv("NEXT_PUBLIC_APP_URL", "http://localhost:3000"),
      "X-Title": getEnv("NEXT_PUBLIC_APP_NAME", "AI Video Director"),
    },
    body: JSON.stringify({
      model,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) throw new Error(`OpenRouter image request failed: ${res.status} ${await res.text()}`);
  const imageUrl = findImageFromOpenRouter(await res.json());
  if (!imageUrl) throw new Error("OpenRouter returned no image");
  return imageUrl;
}

async function callGemini(prompt: string) {
  const apiKey = getEnv("IMAGE_API_KEY");
  if (!apiKey) throw new Error("Missing IMAGE_API_KEY");

  const model = normalizeGeminiImageModel(getEnv("IMAGE_MODEL", "gemini-2.5-flash-image"));
  const baseUrl = getEnv("IMAGE_API_BASE_URL", "https://generativelanguage.googleapis.com/v1beta").replace(/\/$/, "");

  const res = await fetch(`${baseUrl}/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { responseModalities: ["IMAGE", "TEXT"] },
    }),
  });

  if (!res.ok) throw new Error(`Gemini image request failed: ${res.status} ${await res.text()}`);
  const imageUrl = findImageFromGemini(await res.json());
  if (!imageUrl) throw new Error("Gemini returned no image");
  return imageUrl;
}

async function callImageProvider(prompt: string, provider: string) {
  if (provider === "mock") return makeMockStoryboardPanel({
    shotNumber: 1,
    scene: "",
    visual: prompt,
    shotType: "单镜头",
    cameraMovement: "固定",
    emotion: "参考",
    transition: "无",
    videoPrompt: prompt,
    negativePrompt: "",
  });
  if (provider === "openrouter") return callOpenRouter(prompt);
  if (provider === "gemini") return callGemini(prompt);
  return callOpenAICompatible(prompt);
}

async function ensureDataUrl(imageUrl: string) {
  if (imageUrl.startsWith("data:")) return imageUrl;

  const res = await fetch(imageUrl);
  if (!res.ok) throw new Error(`Failed to download generated image: ${res.status}`);

  const contentType = res.headers.get("content-type") || "image/png";
  const buffer = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buffer.toString("base64")}`;
}

function friendlyImageError(error: any) {
  const message = String(error?.message || error || "");
  if (/429|RESOURCE_EXHAUSTED|quota|rate.?limit/i.test(message)) {
    return "真实生图接口额度不足或被限流。请稍后重试，或换 OpenAI / OpenRouter / Qwen 的 key。";
  }
  if (/API_KEY|401|403|permission|unauthorized|forbidden/i.test(message)) {
    return "真实生图接口认证失败。请检查 .env.local 里的 IMAGE_API_KEY 和供应商配置。";
  }
  if (/not found|404|model/i.test(message)) {
    return "真实生图模型不可用。请检查 .env.local 里的 IMAGE_MODEL。";
  }
  return "真实生图接口暂时失败。请检查接口配置，或稍后重试。";
}

export async function POST(request: Request) {
  const requestId = createRequestId("storyboard_image");
  const startedAt = Date.now();
  const route = "/api/storyboard-image";
  try {
    logger.info("api_request_started", { requestId, route, method: "POST" });
    const rateLimit = checkRateLimit({
      key: rateLimitKey(request, "storyboard-image"),
      limit: Number(process.env.IMAGE_RATE_LIMIT_PER_HOUR || 20),
      windowMs: 60 * 60_000,
    });
    if (!rateLimit.allowed) {
      logger.warn("api_request_rate_limited", { requestId, route, resetAt: rateLimit.resetAt });
      return NextResponse.json({ ok: false, error: "参考分镜图生成太频繁，请稍后再试" }, { status: 429 });
    }

    const input = RequestSchema.parse(await request.json());
    const prompt = buildStoryboardPrompt(input);
    const provider = getEnv("IMAGE_PROVIDER", "mock").trim().toLowerCase();
    const fallbackToMock = getEnv("IMAGE_FALLBACK_TO_MOCK", "false").toLowerCase() === "true";
    logger.info("storyboard_image_generation_started", {
      requestId,
      route,
      provider,
      panelCount: input.storyboard.length,
      fallbackToMock,
    });

    let imageUrl = "";
    let warning = "";
    let panelImages: Record<number, string> = {};

    try {
      if (provider === "mock") {
        const panels = input.storyboard.map((shot) => ({
          shotNumber: shot.shotNumber,
          imageUrl: makeMockStoryboardPanel(shot),
        }));
        panelImages = Object.fromEntries(panels.map((panel) => [panel.shotNumber, panel.imageUrl]));
        imageUrl = makeSheetFromPanelImages(panels);
      } else {
        const panels: Array<{ shotNumber: number; imageUrl: string }> = [];

        for (const shot of input.storyboard) {
          const panelPrompt = buildSinglePanelPrompt(input, shot);
          panels.push({
            shotNumber: shot.shotNumber,
            imageUrl: await ensureDataUrl(await callImageProvider(panelPrompt, provider)),
          });
        }

        panelImages = Object.fromEntries(panels.map((panel) => [panel.shotNumber, panel.imageUrl]));
        imageUrl = makeSheetFromPanelImages(panels);
      }
    } catch (error: any) {
      if (!fallbackToMock) throw new Error(friendlyImageError(error));
      logger.warn("storyboard_image_provider_fallback", {
        requestId,
        route,
        provider,
        error,
      });
      const panels = input.storyboard.map((shot) => ({
        shotNumber: shot.shotNumber,
        imageUrl: makeMockStoryboardPanel(shot),
      }));
      panelImages = Object.fromEntries(panels.map((panel) => [panel.shotNumber, panel.imageUrl]));
      imageUrl = makeSheetFromPanelImages(panels);
      warning = friendlyImageError(error);
    }

    logger.info("api_request_completed", {
      requestId,
      route,
      durationMs: durationSince(startedAt),
      provider: warning ? "mock-fallback" : provider,
      panelCount: input.storyboard.length,
      warning: Boolean(warning),
    });
    return NextResponse.json({
      ok: true,
      imageUrl: await ensureDataUrl(imageUrl),
      panels: panelImages,
      prompt,
      provider: warning ? "mock-fallback" : provider,
      warning,
      panelCount: input.storyboard.length,
    });
  } catch (error: any) {
    logger.error("api_request_failed", {
      requestId,
      route,
      durationMs: durationSince(startedAt),
      error,
    });
    return NextResponse.json(
      { ok: false, error: error?.message || "Failed to generate storyboard image" },
      { status: 400 }
    );
  }
}
