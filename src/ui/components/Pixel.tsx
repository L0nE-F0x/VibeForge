import { useMemo } from "react";
import { mark, scatter, shade, wordmark, type Art } from "../../shared/pixel.js";

// Pixel art in the Omarchy manner. Shades come from CSS (--px-0 … --px-3, derived from the
// theme's accents), so the art follows whichever Omarchy theme is active.

function PixelArt({ art, px, label, className }: { art: Art; px: number; label?: string; className?: string }) {
  return (
    <svg
      className={className}
      width={art.width * px}
      height={art.height * px}
      viewBox={`0 0 ${art.width} ${art.height}`}
      shapeRendering="crispEdges"
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      {art.cells.map((cell) => (
        <rect key={`${cell.x}.${cell.y}`} x={cell.x} y={cell.y} width={1} height={1} className={`px-s${shade(cell.y, art.height)}`} />
      ))}
    </svg>
  );
}

export function PixelWordmark({ px = 5, className }: { px?: number; className?: string }) {
  const art = useMemo(() => wordmark(), []);
  return <PixelArt art={art} px={px} label="VibeForge" className={className} />;
}

export function PixelMark({ px = 2, className }: { px?: number; className?: string }) {
  const art = useMemo(() => mark(), []);
  return <PixelArt art={art} px={px} className={className} />;
}

/**
 * Loose accent pixels, thickest along one edge and thinning out: the drift of squares
 * around Omarchy's hero. Purely decorative.
 */
export function PixelField({ cols, rows, cell = 14, size = 8, from = "right", seed = 11, className }: {
  cols: number;
  rows: number;
  cell?: number;
  size?: number;
  from?: "right" | "left" | "bottom";
  seed?: number;
  className?: string;
}) {
  const cells = useMemo(
    () =>
      scatter(
        cols,
        rows,
        (x, y) => {
          const edge = from === "right" ? x / (cols - 1) : from === "left" ? 1 - x / (cols - 1) : y / (rows - 1);
          // Thick at the edge, thinning out, with a little noise so it never looks like a gradient.
          return Math.min(0.85, Math.max(0, edge - 0.3) ** 1.6 * 1.25);
        },
        seed,
      ),
    [cols, rows, from, seed],
  );
  return (
    <svg className={className} width={cols * cell} height={rows * cell} aria-hidden shapeRendering="crispEdges">
      {cells.map((item) => (
        <rect key={`${item.x}.${item.y}`} x={item.x * cell} y={item.y * cell} width={size} height={size} className="px-drift" opacity={item.strength} />
      ))}
    </svg>
  );
}

/**
 * A bar chart built from squares, one column per value: the block charts on Omarchy's stats.
 * The newest column sits on the right and is drawn in the second accent.
 */
export function BlockBars({ values, rows = 6, label }: { values: number[]; rows?: number; label?: string }) {
  const max = Math.max(1, ...values);
  return (
    <div className="block-bars" role="img" aria-label={label} style={{ gridTemplateColumns: `repeat(${values.length}, 1fr)` }}>
      {values.map((value, column) => {
        const lit = value === 0 ? 0 : Math.max(1, Math.round((value / max) * rows));
        return (
          <span key={column} className={`block-col${column === values.length - 1 ? " today" : ""}`}>
            {Array.from({ length: rows }, (_, row) => (
              <i key={row} className={rows - row <= lit ? "on" : undefined} />
            ))}
          </span>
        );
      })}
    </div>
  );
}
