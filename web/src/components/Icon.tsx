import type { CSSProperties } from "react";

// Minimal line-icon set (stroke-based, currentColor) — replaces emoji across the UI.
const ICONS: Record<string, string[]> = {
  flame: ["M12 2C9.5 5 7 7.5 7 12a5 5 0 0 0 10 0c0-2-1-3.5-2-5 0 1.5-.7 2.3-1.5 2.5C13.8 7 13 4 12 2Z"],
  sparkles: [
    "M12 3l1.8 5.2 5.2 1.8-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3Z",
    "M19 14l.7 2 2 .7-2 .7L19 20l-.7-2-2-.7 2-.7L19 14Z",
  ],
  "file-text": ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5", "M9 9h2", "M9 13h6", "M9 17h6"],
  box: [
    "M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z",
    "M3.3 7 12 12l8.7-5",
    "M12 22V12",
  ],
  "circle-check": ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M8.5 12.5l2.5 2.5 4.5-5"],
  send: ["M22 2 11 13", "M22 2 15 22l-4-9-9-4 20-7Z"],
  sliders: ["M4 8h9", "M19 8h1", "M14 8a2 2 0 1 0 4 0 2 2 0 1 0-4 0", "M4 16h1", "M11 16h9", "M6 16a2 2 0 1 0 4 0 2 2 0 1 0-4 0"],
  globe: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M2 12h20", "M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20Z"],
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18", "M6 6l12 12"],
  refresh: ["M21 2v6h-6", "M3 12a9 9 0 0 1 15-6.7L21 8", "M3 22v-6h6", "M21 12a9 9 0 0 1-15 6.7L3 16"],
  download: ["M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4", "M7 10l5 5 5-5", "M12 15V3"],
  trash: ["M3 6h18", "M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2", "M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6", "M10 11v6", "M14 11v6"],
  "external-link": ["M15 3h6v6", "M10 14 21 3", "M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"],
  copy: ["M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1Z", "M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"],
  terminal: ["m4 17 6-6-6-6", "M12 19h8"],
  play: ["M6 4l14 8-14 8V4Z"],
  file: ["M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z", "M14 3v5h5"],
  code: ["M9 8 5 12l4 4", "M15 8l4 4-4 4"],
  pencil: ["M17 3a2.83 2.83 0 0 1 4 4L7.5 20.5 3 21l.5-4.5L17 3Z"],
  eye: ["M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z", "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"],
  undo: ["M3 7v6h6", "M21 17a9 9 0 0 0-15-6.7L3 13"],
  key: ["M5 9a4 4 0 1 0 8 0 4 4 0 1 0-8 0", "M11.8 11.8 20 20", "M17 17l2-2", "M14 14l2-2"],
  lock: ["M5 11h14a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-8a1 1 0 0 1 1-1Z", "M8 11V7a4 4 0 0 1 8 0v4"],
  layers: ["M12 2 2 7l10 5 10-5-10-5Z", "M2 17l10 5 10-5", "M2 12l10 5 10-5"],
  "arrow-right": ["M5 12h14", "M13 6l6 6-6 6"],
  clock: ["M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Z", "M12 7v5l3 2"],
  radar: ["M19.07 4.93a10 10 0 1 0 .01 14.14", "M15.54 8.46a5 5 0 1 0 .01 7.07", "M12 12 16.5 7.5", "M12 12h.01"],
};

export function Icon({
  name, size = 16, className, style, fill,
}: { name: string; size?: number; className?: string; style?: CSSProperties; fill?: boolean }) {
  const paths = ICONS[name] || [];
  return (
    <svg
      width={size} height={size} viewBox="0 0 24 24"
      fill={fill ? "currentColor" : "none"} stroke="currentColor"
      strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round"
      className={className} style={style} aria-hidden="true"
    >
      {paths.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}
