#!/usr/bin/env python3
"""Generate the BossBar demo atlas (512x128 RGBA) with deterministic pixel art.

Run from HanShuWebUI:
    python3 scripts/make-bossbar-demo-atlas.py

The output lives at:
    demo-projects/bossbar-demo/assets/ui/bossbar/atlas.png

Every UV rectangle is kept at exactly the protocol coordinates.  All pixels not
covered by one of those rectangles stay fully transparent.
"""

from __future__ import annotations

import math
import struct
from pathlib import Path

from PIL import Image, ImageChops, ImageFilter

# ---------------------------------------------------------------------------
# Fixed layout contract
# ---------------------------------------------------------------------------

WIDTH, HEIGHT = 512, 128

TRACK = (0, 0, 64, 16)
FILL = (64, 0, 192, 16)
TRAIL = (256, 0, 192, 16)
SHIELD = (448, 0, 64, 16)
EMBLEM = (0, 16, 64, 64)
FRAME = (64, 16, 64, 32)
FLAME_XS = (0, 128, 256, 384)
FLAME_Y = 80
FLAME_W, FLAME_H = 128, 48
FLAME_REGIONS = tuple((x, FLAME_Y, FLAME_W, FLAME_H) for x in FLAME_XS)

ROOT = Path(__file__).resolve().parent.parent
OUT_PATH = ROOT / "demo-projects" / "bossbar-demo" / "assets" / "ui" / "bossbar" / "atlas.png"

# A fixed seed is used for every procedural placement (scratches, flecks, sparks
# and grain).  The stable splitmix-style hash below avoids shared generator state,
# so edits in one region cannot shift another region.
SEED = 0xB055BA5

TRANSPARENT = (0, 0, 0, 0)


# ---------------------------------------------------------------------------
# Small colour / noise helpers
# ---------------------------------------------------------------------------


def _u8(value: float | int) -> int:
    return max(0, min(255, int(round(value))))


def rgba(r: int, g: int, b: int, a: int = 255) -> tuple[int, int, int, int]:
    return (_u8(r), _u8(g), _u8(b), _u8(a))


def mix(c1, c2, t: float) -> tuple[int, int, int, int]:
    """Linear mix of two RGBA colours, including their alpha."""
    t = max(0.0, min(1.0, t))
    return (
        _u8(c1[0] + (c2[0] - c1[0]) * t),
        _u8(c1[1] + (c2[1] - c1[1]) * t),
        _u8(c1[2] + (c2[2] - c1[2]) * t),
        _u8(c1[3] + (c2[3] - c1[3]) * t),
    )


def shade(c, factor: float, alpha: int | None = None) -> tuple[int, int, int, int]:
    return rgba(c[0] * factor, c[1] * factor, c[2] * factor, c[3] if alpha is None else alpha)


def add_light(c, amount: float, warm: tuple[int, int, int] = (255, 236, 178)) -> tuple[int, int, int, int]:
    """Add light toward a warm colour while preserving alpha."""
    return (
        _u8(c[0] + (warm[0] - c[0]) * amount),
        _u8(c[1] + (warm[1] - c[1]) * amount),
        _u8(c[2] + (warm[2] - c[2]) * amount),
        c[3],
    )


def hash01(x: int, y: int, salt: int = 0) -> float:
    """Stable 32-bit pixel hash; deterministic across Python versions."""
    n = (x * 0x9E3779B1 + y * 0x85EBCA77 + salt * 0xC2B2AE3D + SEED) & 0xFFFFFFFF
    n ^= n >> 15
    n = (n * 0x2545F491) & 0xFFFFFFFF
    n ^= n >> 13
    n = (n * 0x27D4EB2F) & 0xFFFFFFFF
    n ^= n >> 16
    return n / 0xFFFFFFFF


def signed_noise(x: int, y: int, salt: int = 0) -> float:
    return hash01(x, y, salt) * 2.0 - 1.0


# ---------------------------------------------------------------------------
# Track: 64x16, fully opaque dark-red stone/iron channel.
# ---------------------------------------------------------------------------


TRACK_ROWS = (
    (10, 2, 3),
    (23, 5, 5),
    (39, 8, 8),
    (53, 10, 10),
    (62, 12, 11),
    (58, 11, 10),
    (52, 10, 9),
    (47, 9, 8),
    (41, 8, 7),
    (36, 7, 6),
    (31, 6, 6),
    (26, 5, 5),
    (21, 4, 4),
    (16, 3, 3),
    (12, 2, 3),
    (8, 1, 2),
)


def build_track() -> Image.Image:
    img = Image.new("RGBA", (64, 16), TRANSPARENT)
    px = img.load()

    # Deterministic hairline scratches.  They are deliberately low contrast and
    # mostly vertical so horizontal stretching does not turn them into bands.
    scratches: list[tuple[int, int, int, bool]] = []
    for i in range(13):
        sx = 4 + int(hash01(i, 1, 70) * 56)
        sy = int(hash01(i, 2, 70) * 13)
        length = 2 + int(hash01(i, 3, 70) * 4)
        bright = hash01(i, 4, 70) > 0.72
        scratches.append((sx, sy, length, bright))

    for y in range(16):
        base = TRACK_ROWS[y]
        for x in range(64):
            # Softly darken the two ends.  The centre stays readable dark red.
            d = min(x, 63 - x)
            vignette = 0.57 + 0.43 * min(1.0, (d / 10.0) ** 0.7)
            factor = vignette

            # A little inner bevel and a near-black frame.
            if y == 0 or y == 15:
                factor *= 0.44
            elif y == 1 or y == 14:
                factor *= 0.78

            # Fine grain, plus a few darker stone flecks.
            n = signed_noise(x, y, 11) * 4.0
            if hash01(x, y, 12) < 0.055:
                n -= 5.0 + hash01(x, y, 13) * 8.0
            elif hash01(x, y, 14) < 0.012:
                n += 3.0

            # Two tiny warm reflections near the middle rows.
            if y in (5, 6) and 8 <= x <= 55:
                n += 1.5

            color = rgba(base[0] * factor + n, base[1] * factor + n * 0.45, base[2] * factor + n * 0.35)
            px[x, y] = color

    for sx, sy, length, bright in scratches:
        for k in range(length):
            y = sy + k
            if not (1 <= y <= 14):
                continue
            current = px[sx, y]
            if bright:
                col = rgba(current[0] * 1.22 + 8, current[1] * 1.12 + 3, current[2] * 1.1 + 2)
            else:
                col = rgba(current[0] * 0.68, current[1] * 0.72, current[2] * 0.72)
            px[sx, y] = col

    # Make sure the protocol's fully-opaque invariant always holds.
    for y in range(16):
        for x in range(64):
            r, g, b, _ = px[x, y]
            px[x, y] = (r, g, b, 255)
    return img


# ---------------------------------------------------------------------------
# Fill: 192x16, #ED242C -> #FF6A3D with diagonal sheen and dark grain.
# ---------------------------------------------------------------------------


FILL_START = (0xED, 0x24, 0x2C)
FILL_END = (0xFF, 0x6A, 0x3D)
FILL_SHADE = (1.08, 1.11, 1.10, 1.06, 1.02, 1.00, 0.99, 0.98, 0.97, 0.96, 0.95, 0.93, 0.91, 0.87, 0.80, 0.64)


def build_fill() -> Image.Image:
    img = Image.new("RGBA", (192, 16), TRANSPARENT)
    px = img.load()
    for y in range(16):
        for x in range(192):
            base = mix(rgba(*FILL_START), rgba(*FILL_END), x / 191.0)
            c = shade(base, FILL_SHADE[y])

            # Bright, deliberately diagonal sheen.  Two broad swaths and one
            # hard 1px leading highlight keep it legible after 3x stretching.
            d = x - 2.6 * y
            for centre, width, strength in ((30.0, 15.0, 0.13), (126.0, 17.0, 0.11), (198.0, 10.0, 0.08)):
                delta = d - centre
                if -width <= delta <= width:
                    amount = strength * (1.0 - abs(delta) / width) ** 1.35
                    c = add_light(c, amount, (255, 230, 174))
                if -1.5 <= delta <= 1.5:
                    c = add_light(c, 0.10, (255, 246, 220))

            # Warm bevel at the top, deep shade at the bottom.
            if y == 0:
                c = add_light(c, 0.08)
            elif y == 1:
                c = add_light(c, 0.12)
            if y == 14:
                c = shade(c, 0.88)
            elif y == 15:
                c = shade(c, 0.68)

            # Darkened grain; always opaque.
            n = signed_noise(x, y, 31) * 5.5
            if hash01(x, y, 32) < 0.10:
                n -= 5.0 + hash01(x, y, 33) * 11.0
            elif hash01(x, y, 34) < 0.025:
                n += 3.0
            c = rgba(c[0] + n, c[1] + n * 0.55, c[2] + n * 0.3, 255)
            px[x, y] = c
    return img


# ---------------------------------------------------------------------------
# Trail: 192x16, amber, deliberately darker / dirtier than the fill.
# ---------------------------------------------------------------------------


TRAIL_START = (0xFF, 0xB3, 0x49)
TRAIL_END = (0xD9, 0x7A, 0x24)
TRAIL_SHADE = (1.10, 1.10, 1.06, 1.02, 0.99, 0.97, 0.95, 0.92, 0.89, 0.86, 0.82, 0.78, 0.72, 0.66, 0.57, 0.44)
# The lagging trail must sit visibly below the main fill in value.  The global
# factor burns the amber down while the ragged highlight still catches light.
TRAIL_DARKEN = 0.70


def build_trail() -> Image.Image:
    img = Image.new("RGBA", (192, 16), TRANSPARENT)
    px = img.load()

    # A fixed set of charred pinpricks; some are 2px to survive minification.
    flecks = []
    for i in range(30):
        fx = 2 + int(hash01(i, 20, 80) * 188)
        fy = 1 + int(hash01(i, 21, 80) * 14)
        size = 1 + (1 if hash01(i, 22, 80) > 0.70 else 0)
        flecks.append((fx, fy, size))

    for y in range(16):
        for x in range(192):
            base = mix(rgba(*TRAIL_START), rgba(*TRAIL_END), x / 191.0)
            c = shade(base, TRAIL_SHADE[y])

            # Coarse low-frequency mottling makes the trail read as worn metal.
            mottle = signed_noise(x // 3, y // 2, 41) * 8.0
            n = signed_noise(x, y, 42) * 6.0 + mottle
            if hash01(x, y, 43) < 0.13:
                n -= 7.0 + hash01(x, y, 44) * 12.0
            c = rgba(
                (c[0] + n) * TRAIL_DARKEN,
                (c[1] + n * 0.65) * TRAIL_DARKEN,
                (c[2] + n * 0.28) * TRAIL_DARKEN,
                255,
            )
            px[x, y] = c

    for fx, fy, size in flecks:
        for yy in range(fy, min(16, fy + size)):
            for xx in range(fx, min(192, fx + size)):
                c = px[xx, yy]
                px[xx, yy] = rgba(c[0] * 0.52, c[1] * 0.50, c[2] * 0.48, 255)

    # Crisp rough top highlight, broken in a few places.
    for x in range(192):
        if hash01(x, 50, 80) < 0.18:
            continue
        c = px[x, 0]
        px[x, 0] = add_light(c, 0.38, (255, 224, 144))
    # Keep the bottom row dark and opaque.
    for x in range(192):
        c = px[x, 15]
        px[x, 15] = shade(c, 0.55, 255)
    return img


# ---------------------------------------------------------------------------
# Shield: 64x16, #4FC3F7 cyan energy.
# ---------------------------------------------------------------------------


SHIELD_ROWS = (
    (5, 17, 25),
    (10, 38, 54),
    (20, 72, 98),
    (31, 111, 145),
    (46, 153, 190),
    (79, 195, 247),
    (102, 215, 255),
    (120, 228, 255),
    (109, 221, 255),
    (91, 205, 246),
    (71, 177, 219),
    (52, 137, 174),
    (35, 99, 130),
    (22, 67, 92),
    (12, 41, 58),
    (6, 21, 31),
)


def build_shield() -> Image.Image:
    img = Image.new("RGBA", (64, 16), TRANSPARENT)
    px = img.load()
    for y in range(16):
        base = SHIELD_ROWS[y]
        for x in range(64):
            c = rgba(*base)

            # Large soft cyan bands across the length.
            band = 0.5 + 0.5 * math.cos((x / 64.0) * math.tau * 2.0 + 0.8)
            c = shade(c, 0.94 + 0.12 * band)

            # Narrow vertical energy runes.  They survive the horizontal stretch
            # as brighter panels instead of disappearing into a flat bar.
            for cx, width, strength in ((9, 2, 0.22), (30, 1, 0.18), (47, 2, 0.16), (61, 1, 0.12)):
                if abs(x - cx) <= width:
                    c = add_light(c, strength, (218, 249, 255))

            # A cold diagonal lattice, very subtle so the bar still reads as one
            # solid shield rather than striped candy.
            if (x + 2 * y) % 21 in (0, 1) and 2 <= y <= 13:
                c = add_light(c, 0.10, (190, 240, 255))

            # Top and bottom metal-dark rims.
            if y == 0:
                c = shade(c, 0.42)
            elif y == 1:
                c = shade(c, 0.72)
            elif y == 15:
                c = shade(c, 0.52)
            elif y == 14:
                c = shade(c, 0.76)

            if y in (6, 7, 8):
                c = add_light(c, 0.08, (226, 252, 255))
            c = rgba(c[0], c[1], c[2], 255)
            px[x, y] = c
    return img


# ---------------------------------------------------------------------------
# Emblem: 64x64, four-way symmetric gold/red medallion with a flame sigil.
# ---------------------------------------------------------------------------


def emblem_ring_color(dx: float, dy: float, r: float, theta: float):
    if r > 30.2:
        return TRANSPARENT
    if r > 29.2:
        return rgba(38, 9, 7, 255)
    if r > 26.9:
        # 8-lobed highlight pattern; cos(4*theta) is invariant under both mirror
        # axes and 90 degree rotation.
        metallic = 0.92 + 0.12 * math.cos(4.0 * theta)
        outer = mix(rgba(255, 226, 143), rgba(204, 126, 31), (r - 26.9) / 2.3)
        return rgba(outer[0] * metallic, outer[1] * metallic, outer[2] * metallic, 255)
    if r > 26.1:
        return rgba(116, 61, 16, 255)
    if r > 25.2:
        return rgba(92, 13, 15, 255)
    if r > 24.4:
        return rgba(206, 132, 36, 255)
    if r > 23.9:
        return rgba(54, 13, 10, 255)
    return None


def build_emblem() -> Image.Image:
    img = Image.new("RGBA", (64, 64), TRANSPARENT)
    px = img.load()

    for y in range(64):
        for x in range(64):
            dx = x + 0.5 - 32.0
            dy = y + 0.5 - 32.0
            r = math.hypot(dx, dy)
            theta = math.atan2(dy, dx)
            ring = emblem_ring_color(dx, dy, r, theta)
            if ring is not None:
                px[x, y] = ring
                continue
            if r > 23.9:
                continue

            # Deep red enamel, brighter toward the centre.  The tiny grain uses
            # absolute coordinates so the medallion remains exactly 4-way
            # symmetric.
            t = min(1.0, r / 23.9)
            base = mix(rgba(118, 18, 20), rgba(43, 7, 8), t ** 0.82)
            grain = signed_noise(int(abs(dx)), int(abs(dy)), 101) * 2.7
            # Subtle enamel rings add depth without introducing directional light.
            ring_tone = 2.2 * math.cos(r * 1.1)
            px[x, y] = rgba(base[0] + grain + ring_tone, base[1] + grain * 0.45, base[2] + grain * 0.35, 255)

    # Four small gold cardinal studs on the ring, plus four ruby diagonal pins.
    # The even-sized blocks are placed on pixel centres 31.5 / 31.5 so mirroring
    # is exact: e.g. x=31,32 mirrors to x=32,31.
    for sx, sy in ((31, 3), (59, 31), (31, 59), (3, 31)):
        for oy in range(2):
            for ox in range(2):
                xx, yy = sx + ox, sy + oy
                if 0 <= xx < 64 and 0 <= yy < 64:
                    px[xx, yy] = rgba(255, 239, 173, 255)
    for sx, sy in ((12, 12), (50, 12), (12, 50), (50, 50)):
        for oy in range(2):
            for ox in range(2):
                xx, yy = sx + ox, sy + oy
                if 0 <= xx < 64 and 0 <= yy < 64:
                    px[xx, yy] = rgba(234, 49, 48, 255)
        # One-pixel dark rim all the way around the 2x2 pin; four points were
        # not enough to preserve mirror symmetry at the block corners.
        for xx in range(sx - 1, sx + 3):
            for yy in (sy - 1, sy + 2):
                if 0 <= xx < 64 and 0 <= yy < 64:
                    px[xx, yy] = rgba(74, 12, 11, 255)
        for yy in range(sy - 1, sy + 3):
            for xx in (sx - 1, sx + 2):
                if 0 <= xx < 64 and 0 <= yy < 64:
                    px[xx, yy] = rgba(74, 12, 11, 255)

    # Build one flame petal, then mirror/rotate it into a four-tongued sigil.
    # The waists/bulges give the four cardinal tongues a fire-lick silhouette
    # while keeping the whole medallion exactly four-way symmetric.
    profile = (2, 3, 4, 4, 3, 4, 5, 6, 6, 4, 3, 4, 4, 3, 3, 2, 2, 1, 1, 1)
    top = Image.new("L", (64, 64), 0)
    tpx = top.load()
    for d, half_width in enumerate(profile):
        y = 31 - d
        for x in range(32 - half_width, 32 + half_width):
            if 0 <= x < 64 and 0 <= y < 64:
                tpx[x, y] = 255

    petal = ImageChops.lighter(top, top.transpose(Image.Transpose.FLIP_TOP_BOTTOM))
    petal = ImageChops.lighter(petal, petal.transpose(Image.Transpose.ROTATE_90))
    petal = petal.filter(ImageFilter.MaxFilter(3))  # close 1px seams at the joins

    dark = petal.filter(ImageFilter.MaxFilter(7))   # 3px expansion
    gold = petal.filter(ImageFilter.MaxFilter(5))   # 2px expansion
    rim = petal
    core = petal.filter(ImageFilter.MinFilter(3))   # 1px erosion

    dark_px = dark.load()
    gold_px = gold.load()
    rim_px = rim.load()
    core_px = core.load()
    for y in range(64):
        for x in range(64):
            if dark_px[x, y] == 0:
                continue
            dx = x + 0.5 - 32.0
            dy = y + 0.5 - 32.0
            r = math.hypot(dx, dy)

            if gold_px[x, y] == 0:
                px[x, y] = rgba(38, 8, 6, 255)
            elif rim_px[x, y] == 0:
                # Gold outline: a thin dark outer edge and a warm inner bevel.
                if r > 20.0:
                    px[x, y] = rgba(252, 206, 102, 255)
                else:
                    px[x, y] = rgba(205, 128, 32, 255)
            elif core_px[x, y] == 0:
                px[x, y] = rgba(170, 55, 12, 255)
            else:
                fire_t = min(1.0, r / 18.0)
                fire = mix(rgba(255, 250, 190), rgba(255, 88, 17), fire_t ** 1.25)
                # Symmetric hot grain inside the flame body.
                sparkle = signed_noise(int(abs(dx) * 2), int(abs(dy) * 2), 102) * 8.0
                if hash01(int(abs(dx) * 2), int(abs(dy) * 2), 103) > 0.84:
                    sparkle += 12.0
                px[x, y] = rgba(fire[0] + sparkle, fire[1] + sparkle * 0.55, fire[2] + sparkle * 0.2, 255)

    # A compact white-hot centre.
    for y in range(30, 34):
        for x in range(30, 34):
            if px[x, y][3] > 0:
                px[x, y] = rgba(255, 251, 222, 255)

    # Two or three extra embers per quadrant, mirrored exactly.
    for ex, ey in ((17, 17), (18, 17), (17, 18), (46, 17), (45, 17), (46, 18),
                   (17, 46), (18, 46), (17, 45), (46, 46), (45, 46), (46, 45)):
        if px[ex, ey][3] == 0:
            px[ex, ey] = rgba(255, 184, 66, 255)

    # Sanity: the circular edge must be transparent in the four corners.
    for x, y in ((0, 0), (63, 0), (0, 63), (63, 63)):
        assert px[x, y][3] == 0
    return img


# ---------------------------------------------------------------------------
# Frame: 64x32 nine-slice trim.  8px corners, 8px edges, transparent centre.
# ---------------------------------------------------------------------------


FRAME_K = rgba(33, 7, 5, 255)       # near-black outline
FRAME_H = rgba(255, 224, 132, 255)  # bright gold bevel
FRAME_G = rgba(211, 137, 36, 255)   # gold
FRAME_D = rgba(151, 82, 22, 255)    # dark gold
FRAME_R = rgba(122, 26, 23, 255)    # dark red inlay
FRAME_B = rgba(83, 24, 12, 255)     # bronze shadow

FRAME_EDGE = (FRAME_K, FRAME_H, FRAME_G, FRAME_D, FRAME_R, FRAME_G, FRAME_B, FRAME_K)

# 8x8 top-left ornament.  The last column matches the top edge, the last row
# matches the left edge, so the corners visually lock into the stretched sides.
FRAME_CORNER = (
    "KKKKKKKK",
    "KHHHHHHH",
    "KHGgggGG",
    "KHGhRRgD",
    "KHgRRRgR",
    "KHgrRRgG",
    "KGGgggGb",
    "KHGDRGbK",
)

FRAME_CORNER_COLORS = {
    "K": FRAME_K,
    "H": FRAME_H,
    "G": FRAME_G,
    "D": FRAME_D,
    "R": FRAME_R,
    "B": FRAME_B,
    "b": FRAME_B,
    "g": rgba(96, 45, 14, 255),
    "h": rgba(255, 115, 86, 255),
    "r": rgba(91, 10, 15, 255),
}


def build_frame() -> Image.Image:
    img = Image.new("RGBA", (64, 32), TRANSPARENT)
    px = img.load()

    # Top and bottom 8px rails: uniform along the stretch axis by construction.
    for y in range(8):
        c = FRAME_EDGE[y]
        for x in range(8, 56):
            px[x, y] = c
            px[x, 31 - y] = c

    # Left and right 8px rails: also uniform along their stretch axis.
    for x in range(8):
        c = FRAME_EDGE[x]
        for y in range(8, 24):
            px[x, y] = c
            px[63 - x, y] = c

    # Paste the 8x8 corner ornament, mirrored into all four corners.
    for corner_x, corner_y, flip_x, flip_y in (
        (0, 0, False, False),
        (56, 0, True, False),
        (0, 24, False, True),
        (56, 24, True, True),
    ):
        for ly in range(8):
            src_y = 7 - ly if flip_y else ly
            for lx in range(8):
                src_x = 7 - lx if flip_x else lx
                ch = FRAME_CORNER[src_y][src_x]
                px[corner_x + lx, corner_y + ly] = FRAME_CORNER_COLORS[ch]

    # The centre must be perfectly transparent.
    for y in range(8, 24):
        for x in range(8, 56):
            px[x, y] = TRANSPARENT

    # Light corner ridge accents: one pixel each, four-way symmetric.
    for x, y in ((1, 1), (62, 1), (1, 30), (62, 30)):
        px[x, y] = rgba(255, 246, 192, 255)
    return img


# ---------------------------------------------------------------------------
# Flame: four 128x48 cyclic frames.  The same periodic field is sampled with a
# phase offset of 32px per frame, so frame 3 -> frame 0 continues the motion.
# ---------------------------------------------------------------------------


FLAME_PHASE_STEP = 32
FLAME_BED_HEIGHT = 11.0
# (centre_x, height, base_half_width, lean)
BACK_TONGUES = (
    (8, 41, 10, 7),
    (35, 28, 8, -5),
    (62, 39, 11, 4),
    (93, 33, 9, -7),
    (120, 24, 6, 3),
)
FRONT_TONGUES = (
    (2, 27, 7, 4),
    (25, 21, 5, -3),
    (52, 32, 9, 5),
    (77, 19, 5, 2),
    (104, 29, 8, -4),
    (124, 16, 4, 2),
)
FLAME_SPARKS = (
    (7, 9, 2, 235),
    (23, 17, 1, 210),
    (41, 6, 2, 245),
    (58, 14, 1, 225),
    (74, 11, 2, 215),
    (93, 5, 1, 245),
    (108, 20, 2, 205),
    (119, 13, 1, 230),
)


def flame_mask(specs: tuple[tuple[int, int, int, int], ...], shift: float) -> list[list[int]]:
    """Build a wrapped 128x48 flame coverage map.

    Each tongue is a curved, tapered finger.  The lower bed stays continuous so
    the strip reads as fire attached to the bar; the fingers supply the licks.
    """
    mask = [[0] * 48 for _ in range(128)]

    # Ragged ember bed along the bottom edge.
    for x in range(128):
        t = x / 128.0
        h = (
            FLAME_BED_HEIGHT
            + 2.6 * math.sin(math.tau * t * 3.0 + 1.1)
            + 1.9 * math.sin(math.tau * t * 7.0 + 0.3)
            + 1.0 * math.sin(math.tau * t * 13.0 + 2.0)
        )
        top = int(round(47 - h))
        for y in range(max(0, top), 48):
            mask[x][y] = 240

    for centre, height, base_width, lean in specs:
        for c in (centre - 128, centre, centre + 128):
            top = max(0, int(47 - height))
            for y in range(top, 48):
                p = (47 - y) / height
                if p > 1.0:
                    continue
                half_width = base_width * (1.0 - p) ** 0.80 + 0.55
                cx = c + lean * (p ** 1.35) + shift
                for x in range(max(0, int(cx - half_width) - 1), min(128, int(cx + half_width) + 2)):
                    dx = abs((x + 0.5) - cx)
                    if dx > half_width:
                        continue
                    # Jagged one-pixel side bites keep the silhouette hand-made.
                    if p > 0.18 and dx > half_width - 0.9 and hash01(x, y, 11) > 0.40:
                        continue
                    edge = 0.70 + 0.30 * (1.0 - dx / max(0.6, half_width))
                    value = min(255, int(255.0 * (1.0 - 0.45 * p) * edge))
                    if value > mask[x][y]:
                        mask[x][y] = value
    return mask


def flame_colour(p: float, front: bool, heat: float) -> tuple[int, int, int]:
    # p=0 at the wick, p=1 at the tip.  The two layers use separate ramps so the
    # back fire reads as deep embers and the front fingers stay hot and golden.
    if front:
        stops = (
            (0.00, (255, 232, 153)),
            (0.22, (255, 198, 72)),
            (0.48, (255, 145, 28)),
            (0.72, (255, 88, 14)),
            (1.00, (218, 42, 5)),
        )
    else:
        stops = (
            (0.00, (255, 161, 49)),
            (0.24, (239, 91, 14)),
            (0.55, (188, 42, 7)),
            (0.80, (128, 23, 4)),
            (1.00, (82, 13, 3)),
        )
    p = max(0.0, min(1.0, p))
    col = stops[-1][1]
    for i in range(len(stops) - 1):
        if stops[i][0] <= p <= stops[i + 1][0]:
            a, ca = stops[i]
            b, cb = stops[i + 1]
            f = (p - a) / max(1e-9, b - a)
            col = (
                _u8(ca[0] + (cb[0] - ca[0]) * f),
                _u8(ca[1] + (cb[1] - ca[1]) * f),
                _u8(ca[2] + (cb[2] - ca[2]) * f),
            )
            break
    lift = int((heat - 0.5) * (14 if front else 8))
    return (
        max(0, min(255, col[0] + lift)),
        max(0, min(255, col[1] + lift)),
        max(0, min(255, col[2] + lift)),
    )


def flame_layer(specs: tuple[tuple[int, int, int, int], ...], shift: float, front: bool) -> Image.Image:
    mask = flame_mask(specs, shift)
    img = Image.new("RGBA", (128, 48), TRANSPARENT)
    px = img.load()
    for x in range(128):
        top = 0
        while top < 48 and mask[x][top] == 0:
            top += 1
        local_h = max(1.0, 47 - top + 1.0)
        for y in range(top, 48):
            value = mask[x][y]
            if value <= 0:
                continue
            p = (47 - y) / local_h
            heat = 0.5 + 0.5 * math.sin(math.tau * (2.3 * x / 128.0 + y / 14.0) + 1.0)
            colour = flame_colour(p, front, heat)
            a = value
            if not front:
                a = int(a * 0.92)
            # Tip fade happens over the final eight rows only, so the flame body
            # stays saturated while its very top disappears into transparency.
            if y < top + 7:
                a = int(a * ((y - top + 0.5) / 7.5) ** 0.90)
            a = int(a * (0.90 + 0.10 * (0.5 + 0.5 * signed_noise(x, y, 51))))
            a = max(0, min(255, (a // 16) * 16))
            if a < 24:
                continue
            px[x, y] = (colour[0], colour[1], colour[2], a)
    return img


def build_flame_base() -> Image.Image:
    img = Image.new("RGBA", (128, 48), TRANSPARENT)
    img.alpha_composite(flame_layer(BACK_TONGUES, -2.0, front=False))
    img.alpha_composite(flame_layer(FRONT_TONGUES, 0.0, front=True))

    # Bright embers float above the tongues.  They live in the same cyclic base
    # field and therefore travel with the fire.
    for sx, sy, size, alpha in FLAME_SPARKS:
        for oy in range(size):
            for ox in range(size):
                x = (sx + ox) % 128
                y = sy + oy
                if 0 <= y < 48 and img.getpixel((x, y))[3] == 0:
                    img.putpixel((x, y), (255, 183, 57, alpha))

    # No flame content on the top row: the strip dissolves into transparency.
    for x in range(128):
        img.putpixel((x, 0), TRANSPARENT)
    return img


def build_flame_frames() -> list[Image.Image]:
    base = build_flame_base()
    # Exact cyclic translation by one quarter of the 128px period per frame.
    # frame 3 -> frame 0 therefore advances by 32px just like every other step.
    return [ImageChops.offset(base, -(i * FLAME_PHASE_STEP), 0) for i in range(4)]


# ---------------------------------------------------------------------------
# Assembly and verification
# ---------------------------------------------------------------------------


def paste_region(atlas: Image.Image, region: Image.Image, box: tuple[int, int, int, int]) -> None:
    x, y, w, h = box
    assert region.size == (w, h), (region.size, box)
    atlas.alpha_composite(region, (x, y))


def png_header(path: Path) -> tuple[int, int, int, int, int]:
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    length = struct.unpack(">I", data[8:12])[0]
    assert data[12:16] == b"IHDR" and length == 13
    width, height, bit_depth, colour_type, compression, filter_method, interlace = struct.unpack(">IIBBBBB", data[16:29])
    return width, height, bit_depth, colour_type, interlace


def verify(path: Path, frames: list[Image.Image]) -> None:
    w, h, depth, ctype, interlace = png_header(path)
    assert (w, h, depth, ctype, interlace) == (512, 128, 8, 6, 0), (w, h, depth, ctype, interlace)

    im = Image.open(path)
    im.load()
    assert im.mode == "RGBA" and im.size == (512, 128)
    px = im.load()

    opaque_regions = (TRACK, FILL, TRAIL, SHIELD)
    for x, y, rw, rh in opaque_regions:
        for yy in range(y, y + rh):
            for xx in range(x, x + rw):
                assert px[xx, yy][3] == 255, ("opaque region has transparency", (xx, yy))
        assert any(px[xx, yy][:3] != (0, 0, 0) for yy in range(y, y + rh) for xx in range(x, x + rw))

    # Emblem: transparent corners, opaque ring, visible centre, exact 4-way
    # mirror symmetry.
    ex, ey, ew, eh = EMBLEM
    assert px[ex, ey][3] == 0 and px[ex + ew - 1, ey][3] == 0
    assert px[ex + ew // 2, ey + eh // 2][3] == 255
    assert any(px[ex + xx, ey + yy][3] == 0 for yy in range(eh) for xx in range(ew))
    assert any(px[ex + xx, ey + yy][3] > 0 for yy in range(eh) for xx in range(ew))
    emblem = im.crop((ex, ey, ex + ew, ey + eh))
    for mirror in (
        emblem.transpose(Image.Transpose.FLIP_LEFT_RIGHT),
        emblem.transpose(Image.Transpose.FLIP_TOP_BOTTOM),
    ):
        assert emblem.tobytes() == mirror.tobytes(), "emblem must be four-way symmetric"

    # Frame: all centre pixels transparent, all corners visibly decorated, and
    # every edge rail constant along its stretch direction.
    fx, fy, fw, fh = FRAME
    for yy in range(fy + 8, fy + 24):
        for xx in range(fx + 8, fx + 56):
            assert px[xx, yy][3] == 0, ("frame centre is not transparent", (xx, yy))
    for cx, cy in ((fx, fy), (fx + fw - 1, fy), (fx, fy + fh - 1), (fx + fw - 1, fy + fh - 1)):
        assert px[cx, cy][3] == 255
    assert any(px[fx + xx, fy + yy][3] == 0 for yy in range(fh) for xx in range(fw))
    for row in range(8):
        assert len({px[fx + xx, fy + row] for xx in range(8, 56)}) == 1, "top rail seam"
        assert len({px[fx + xx, fy + 31 - row] for xx in range(8, 56)}) == 1, "bottom rail seam"
    for col in range(8):
        assert len({px[fx + col, fy + yy] for yy in range(8, 24)}) == 1, "left rail seam"
        assert len({px[fx + 63 - col, fy + yy] for yy in range(8, 24)}) == 1, "right rail seam"

    # Flame frames: present, transparent at the very top, four distinct frames.
    frame_bytes = []
    for i, (rx, ry, rw, rh) in enumerate(FLAME_REGIONS):
        assert im.crop((rx, ry, rx + rw, ry + rh)).getbbox() is not None
        assert all(px[rx + xx, ry][3] == 0 for xx in range(rw))
        assert any(px[rx + xx, ry + yy][3] > 0 for yy in range(rh) for xx in range(rw))
        frame_bytes.append(im.crop((rx, ry, rx + rw, ry + rh)).tobytes())
    assert len(set(frame_bytes)) == 4, "flame frames must be distinct"
    for i, frame in enumerate(frames):
        shifted = ImageChops.offset(frames[0], -(i * FLAME_PHASE_STEP), 0)
        assert frame.tobytes() == shifted.tobytes(), "flame frames must be exact cyclic shifts"

    # Every byte outside the seven protocol rectangles is fully transparent.
    allowed = (TRACK, FILL, TRAIL, SHIELD, EMBLEM, FRAME) + FLAME_REGIONS
    mask = Image.new("L", (512, 128), 0)
    mpx = mask.load()
    for ax, ay, aw, ah in allowed:
        for yy in range(ay, ay + ah):
            for xx in range(ax, ax + aw):
                mpx[xx, yy] = 255
    for yy in range(128):
        for xx in range(512):
            if mpx[xx, yy] == 0:
                assert px[xx, yy][3] == 0, ("unused atlas pixel is not transparent", (xx, yy))

    # The four frames are exact cyclic shifts, so frame 3 -> frame 0 advances by
    # the same amount as every other transition.
    diffs = []
    for i in range(4):
        a = frames[i].tobytes()
        b = frames[(i + 1) % 4].tobytes()
        diff = sum(abs(x - y) for x, y in zip(a, b)) / 255.0
        diffs.append(diff)
    spread = max(diffs) - min(diffs)
    assert spread <= 0.01, ("flame loop is uneven", diffs)

    print(f"verified PNG {path.stat().st_size} bytes")
    print(f"  header: {w}x{h} depth={depth} colour_type={ctype} interlace={interlace}")
    print(f"  opaque bar rects: {len(opaque_regions)}; transparent frame centre: yes")
    print(f"  flame frame pixel-diff spread: {spread:.2f} (loop is cyclic)")


def main() -> None:
    atlas = Image.new("RGBA", (WIDTH, HEIGHT), TRANSPARENT)

    paste_region(atlas, build_track(), TRACK)
    paste_region(atlas, build_fill(), FILL)
    paste_region(atlas, build_trail(), TRAIL)
    paste_region(atlas, build_shield(), SHIELD)
    paste_region(atlas, build_emblem(), EMBLEM)
    paste_region(atlas, build_frame(), FRAME)

    frames = build_flame_frames()
    for flame, region in zip(frames, FLAME_REGIONS):
        paste_region(atlas, flame, region)

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    atlas.save(OUT_PATH, format="PNG", compress_level=9)
    verify(OUT_PATH, frames)

    print(f"wrote {OUT_PATH}")
    print(f"  size {atlas.size[0]}x{atlas.size[1]} RGBA")
    print("  regions: track, fill, trail, shield, emblem, frame, flame x4")


if __name__ == "__main__":
    main()
