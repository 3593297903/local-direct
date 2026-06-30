"use client";

import { motion } from "framer-motion";
import { useState } from "react";
import { KnowledgeItem } from "@/types";

type PlaybackMode = "auto" | "hover";

function posterUrlFor(item: KnowledgeItem | undefined, isVideo: boolean) {
  if (!item || !isVideo) return "";
  if (item.posterUrl) return item.posterUrl;
  if (!item.previewUrl) return "";
  return item.previewUrl.replace(/^\/previews\/(.+)\.(mp4|webm)$/i, "/previews/posters/$1.jpg");
}

export function PreviewAnimation({
  item,
  type = "camera",
  playback = "auto",
}: {
  item?: KnowledgeItem;
  type?: KnowledgeItem["previewType"];
  playback?: PlaybackMode;
}) {
  const [isHovering, setIsHovering] = useState(false);
  const [posterFailed, setPosterFailed] = useState(false);
  const previewUrl = item?.previewUrl;
  const previewMimeType = item?.previewMimeType || "";
  const isVideo = previewMimeType.startsWith("video/") || /\.(mp4|webm)$/i.test(previewUrl || "");
  const isImage = previewMimeType.startsWith("image/") || /\.(jpg|jpeg|png|webp|gif)$/i.test(previewUrl || "");
  const posterUrl = posterUrlFor(item, isVideo);
  const shouldPlayVideo = playback === "auto" || isHovering;
  const shouldShowPoster = playback === "hover" && isVideo && posterUrl && !posterFailed && !shouldPlayVideo;
  const shouldShowFallback = !previewUrl || (isVideo && playback === "hover" && !shouldPlayVideo && (!posterUrl || posterFailed));

  return (
    <div
      className="preview-grid relative aspect-[16/9] w-full overflow-hidden rounded-t-xl bg-slate-950"
      onMouseEnter={() => setIsHovering(true)}
      onMouseLeave={() => setIsHovering(false)}
      onFocus={() => setIsHovering(true)}
      onBlur={() => setIsHovering(false)}
    >
      {shouldShowPoster && (
        <img
          src={posterUrl}
          alt={item?.name || "预览封面"}
          loading="lazy"
          onError={() => setPosterFailed(true)}
          className="absolute inset-0 h-full w-full object-cover"
        />
      )}
      {previewUrl && isVideo && shouldPlayVideo && (
        <video src={previewUrl} className="absolute inset-0 h-full w-full object-cover" autoPlay muted loop playsInline preload="none" />
      )}
      {previewUrl && isImage && !isVideo && (
        <img src={previewUrl} alt={item?.name || "预览"} className="absolute inset-0 h-full w-full object-cover" />
      )}

      {shouldShowFallback && (
        <>
          {type === "shadow" && (
            <motion.div
              className="absolute top-0 h-full w-1/2 bg-black/90 blur-sm"
              animate={{ left: ["-60%", "120%"] }}
              transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
          {type === "hand" && (
            <motion.div
              className="absolute bottom-[-24px] left-1/2 h-36 w-28 -translate-x-1/2 rounded-t-full bg-cyan-100/70 shadow-2xl"
              animate={{ scale: [0.55, 1.45, 0.55], y: [35, -12, 35] }}
              transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
          {type === "flare" && (
            <motion.div
              className="absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white blur-xl"
              animate={{ scale: [0.2, 5, 0.2], opacity: [0.2, 0.95, 0.2] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
          {type === "eye" && (
            <motion.div
              className="absolute left-1/2 top-1/2 h-16 w-32 -translate-x-1/2 -translate-y-1/2 rounded-[50%] border border-white/50 bg-white/15"
              animate={{ scale: [0.8, 1.15, 0.8] }}
              transition={{ duration: 1.8, repeat: Infinity }}
            >
              <motion.div
                className="absolute left-1/2 top-1/2 h-9 w-9 -translate-x-1/2 -translate-y-1/2 rounded-full bg-cyan-300/80"
                animate={{ scale: [0.8, 1.25, 0.8] }}
                transition={{ duration: 1.8, repeat: Infinity }}
              />
            </motion.div>
          )}
          {type === "door" && (
            <motion.div
              className="absolute left-1/2 top-6 h-28 w-20 origin-left -translate-x-1/2 rounded-md border border-cyan-200/45 bg-slate-950/80"
              animate={{ rotateY: [0, -55, 0] }}
              transition={{ duration: 2.2, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
          {type === "whip" && (
            <motion.div
              className="absolute inset-0 bg-gradient-to-r from-transparent via-cyan-100/60 to-transparent"
              animate={{ x: ["-120%", "120%"] }}
              transition={{ duration: 1.1, repeat: Infinity, ease: "easeInOut" }}
            />
          )}
          {type === "camera" && (
            <motion.div
              className="absolute left-1/2 top-1/2 h-20 w-20 -translate-x-1/2 -translate-y-1/2 rounded-full border border-cyan-100/40 bg-cyan-100/10"
              animate={{ scale: [0.9, 1.1, 0.9] }}
              transition={{ duration: 2.4, repeat: Infinity }}
            />
          )}
        </>
      )}
    </div>
  );
}
