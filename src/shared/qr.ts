// A QR code for a short piece of text (a link), drawn as a square of dark and light modules.
// Byte mode at error-correction level M, versions 1 to 10: up to 213 bytes, which is more than the
// phone page's link needs. Written here rather than brought in: it is one screen of arithmetic, and
// the app has no other use for a QR library.

/** Per version (index 0 is version 1), at level M: error-correction bytes per block, then [blocks, data bytes in each] groups. */
const BLOCKS: ReadonlyArray<{ ec: number; groups: ReadonlyArray<readonly [number, number]> }> = [
  { ec: 10, groups: [[1, 16]] },
  { ec: 16, groups: [[1, 28]] },
  { ec: 26, groups: [[1, 44]] },
  { ec: 18, groups: [[2, 32]] },
  { ec: 24, groups: [[2, 43]] },
  { ec: 16, groups: [[4, 27]] },
  { ec: 18, groups: [[4, 31]] },
  { ec: 22, groups: [[2, 38], [2, 39]] },
  { ec: 22, groups: [[3, 36], [2, 37]] },
  { ec: 26, groups: [[4, 43], [1, 44]] },
];

/** Where the small alignment squares sit, per version. */
const ALIGNMENT: ReadonlyArray<readonly number[]> = [[], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];

/** Multiplication in the field the error correction is worked in (GF(256), polynomial 0x11D). */
function multiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

/** The Reed-Solomon error-correction bytes for one block of data. */
function errorCorrection(data: readonly number[], count: number): number[] {
  const divisor: number[] = new Array<number>(count).fill(0);
  divisor[count - 1] = 1;
  let root = 1;
  for (let i = 0; i < count; i += 1) {
    for (let j = 0; j < count; j += 1) {
      divisor[j] = multiply(divisor[j], root);
      if (j + 1 < count) divisor[j] ^= divisor[j + 1];
    }
    root = multiply(root, 2);
  }
  const rest: number[] = new Array<number>(count).fill(0);
  for (const byte of data) {
    const factor = byte ^ (rest.shift() ?? 0);
    rest.push(0);
    for (let i = 0; i < count; i += 1) rest[i] ^= multiply(divisor[i], factor);
  }
  return rest;
}

/** The text's bytes with their header and padding, then split into blocks, each followed by its error correction, interleaved. */
function codewords(bytes: Uint8Array, version: number): number[] {
  const { ec, groups } = BLOCKS[version - 1];
  const capacity = groups.reduce((sum, [blocks, size]) => sum + blocks * size, 0);
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const byte of bytes) push(byte, 8);
  push(0, Math.min(4, capacity * 8 - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacity * 8; pad ^= 0xec ^ 0x11) push(pad, 8);
  const data: number[] = [];
  for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((byte, bit) => (byte << 1) | bit, 0));

  const blocks: Array<{ data: number[]; ec: number[] }> = [];
  let at = 0;
  for (const [count, size] of groups) {
    for (let i = 0; i < count; i += 1) {
      const part = data.slice(at, at + size);
      at += size;
      blocks.push({ data: part, ec: errorCorrection(part, ec) });
    }
  }
  const out: number[] = [];
  const longest = Math.max(...blocks.map((block) => block.data.length));
  for (let i = 0; i < longest; i += 1) for (const block of blocks) if (i < block.data.length) out.push(block.data[i]);
  for (let i = 0; i < ec; i += 1) for (const block of blocks) out.push(block.ec[i]);
  return out;
}

/** How easy a finished code is to misread, by the standard's four rules: the mask with the least is used. */
function penalty(modules: boolean[][]): number {
  const size = modules.length;
  let score = 0;
  const lines: boolean[][] = [...modules, ...modules.map((_, x) => modules.map((row) => row[x]))];
  const finder = [true, false, true, true, true, false, true, false, false, false, false];
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i += 1) {
      if (i < size && line[i] === line[i - 1]) run += 1;
      else {
        if (run >= 5) score += run - 2;
        run = 1;
      }
    }
    for (let i = 0; i + finder.length <= size; i += 1) {
      if (finder.every((dark, j) => line[i + j] === dark)) score += 40;
      if (finder.every((dark, j) => line[i + finder.length - 1 - j] === dark)) score += 40;
    }
  }
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (modules[y][x]) dark += 1;
      if (x + 1 < size && y + 1 < size && modules[y][x] === modules[y][x + 1] && modules[y][x] === modules[y + 1][x] && modules[y][x] === modules[y + 1][x + 1]) score += 3;
    }
  }
  return score + Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10;
}

const MASKS: ReadonlyArray<(x: number, y: number) => boolean> = [
  (x, y) => (x + y) % 2 === 0,
  (_x, y) => y % 2 === 0,
  (x) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

/**
 * The QR code for `text`: rows of modules, true where one is dark. Null when the text is too long
 * for the sizes drawn here (more than 213 bytes).
 */
export function qrCode(text: string): boolean[][] | null {
  const bytes = new TextEncoder().encode(text);
  const version = BLOCKS.findIndex(({ groups }, index) => bytes.length <= groups.reduce((sum, [blocks, size]) => sum + blocks * size, 0) - (index + 1 < 10 ? 2 : 3)) + 1;
  if (!version) return null;
  const size = 17 + 4 * version;
  const modules: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  /** The modules that are part of the code's own frame, not of the data: masks leave them alone. */
  const fixed: boolean[][] = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
  const set = (x: number, y: number, dark: boolean) => {
    modules[y][x] = dark;
    fixed[y][x] = true;
  };

  // The dotted lines between the corner squares.
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  // The three corner squares, each with its light border.
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx;
        const y = cy + dy;
        const ring = Math.max(Math.abs(dx), Math.abs(dy));
        if (x >= 0 && x < size && y >= 0 && y < size) set(x, y, ring !== 2 && ring !== 4);
      }
    }
  }
  // The small squares, everywhere but on the corner ones.
  const spots = ALIGNMENT[version - 1];
  spots.forEach((cx, i) => {
    spots.forEach((cy, j) => {
      const last = spots.length - 1;
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy += 1) for (let dx = -2; dx <= 2; dx += 1) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    });
  });
  // The version, twice, from version 7 up.
  if (version >= 7) {
    let rest = version;
    for (let i = 0; i < 12; i += 1) rest = (rest << 1) ^ ((rest >>> 11) * 0x1f25);
    const bits = (version << 12) | rest;
    for (let i = 0; i < 18; i += 1) {
      const dark = ((bits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  /** The error-correction level and the mask, twice, beside the corner squares. */
  const format = (mask: number) => {
    // Level M is 00, so the five bits are the mask alone.
    let rest = mask;
    for (let i = 0; i < 10; i += 1) rest = (rest << 1) ^ ((rest >>> 9) * 0x537);
    const bits = ((mask << 10) | rest) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) === 1;
    for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
    set(8, 7, bit(6));
    set(8, 8, bit(7));
    set(7, 8, bit(8));
    for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
    set(8, size - 8, true);
  };
  // Reserved before the data goes in, so the data keeps clear of it.
  format(0);

  // The data, in two-module columns from the bottom right, snaking up and down.
  const data = codewords(bytes, version);
  let at = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let step = 0; step < size; step += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const y = ((right + 1) & 2) === 0 ? size - 1 - step : step;
        if (fixed[y][x]) continue;
        // Past the last byte, the few modules left over stay light.
        modules[y][x] = at < data.length * 8 && ((data[at >>> 3] >>> (7 - (at & 7))) & 1) === 1;
        at += 1;
      }
    }
  }

  const flip = (mask: number) => {
    for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (!fixed[y][x] && MASKS[mask](x, y)) modules[y][x] = !modules[y][x];
  };
  let best = 0;
  let least = Number.POSITIVE_INFINITY;
  for (let mask = 0; mask < MASKS.length; mask += 1) {
    flip(mask);
    format(mask);
    const score = penalty(modules);
    if (score < least) {
      least = score;
      best = mask;
    }
    flip(mask);
  }
  flip(best);
  format(best);
  return modules;
}

/** The dark modules as one SVG path, a unit square each, for a `viewBox` of the code's size plus its quiet border. */
export function qrPath(modules: readonly (readonly boolean[])[], border = 4): string {
  let path = "";
  modules.forEach((row, y) => {
    for (let x = 0; x < row.length; x += 1) {
      if (!row[x]) continue;
      let end = x;
      while (end + 1 < row.length && row[end + 1]) end += 1;
      path += `M${x + border},${y + border}h${end - x + 1}v1h-${end - x + 1}z`;
      x = end;
    }
  });
  return path;
}
