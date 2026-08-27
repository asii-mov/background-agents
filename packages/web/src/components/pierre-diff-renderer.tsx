"use client";

import { preloadHighlighter } from "@pierre/diffs";
import { PatchDiff, type VirtualFileMetrics } from "@pierre/diffs/react";
import { type CSSProperties, useEffect, useState } from "react";
import type { DiffStyle } from "@/hooks/use-session-diff-preferences";

const COMPACT_DIFF_METRICS: VirtualFileMetrics = {
  hunkLineCount: 50,
  lineHeight: 17,
  diffHeaderHeight: 44,
  spacing: 8,
};

const COMPACT_DIFF_STYLE: CSSProperties & Record<`--${string}`, string> = {
  "--diffs-font-size": "11px",
  "--diffs-line-height": "17px",
};

export default function PierreDiffRenderer({
  patch,
  diffStyle,
  wrap,
  themeType,
}: {
  patch: string;
  diffStyle: DiffStyle;
  wrap: boolean;
  themeType: "light" | "dark";
}) {
  const [rendererState, setRendererState] = useState<"loading" | "ready" | "failed">("loading");

  useEffect(() => {
    let active = true;
    preloadHighlighter({
      langs: ["typescript"],
      themes: ["pierre-light", "pierre-dark"],
    }).then(
      () => {
        if (active) setRendererState("ready");
      },
      () => {
        if (active) setRendererState("failed");
      }
    );
    return () => {
      active = false;
    };
  }, []);

  if (rendererState === "loading") {
    return <div className="p-3 text-xs text-muted-foreground">Rendering patch…</div>;
  }

  if (rendererState === "failed") {
    return <pre className="overflow-auto p-3 text-xs whitespace-pre-wrap">{patch}</pre>;
  }

  return (
    <div className="box-border min-w-0 w-full pr-3">
      <PatchDiff
        patch={patch}
        metrics={COMPACT_DIFF_METRICS}
        style={COMPACT_DIFF_STYLE}
        options={{
          diffStyle,
          overflow: wrap ? "wrap" : "scroll",
          themeType,
          hunkSeparators: "line-info",
          expandUnchanged: false,
          disableFileHeader: true,
          stickyHeader: false,
        }}
      />
    </div>
  );
}
