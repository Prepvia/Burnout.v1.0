"""Draws the extension icons (16, 32, 48, 128 px): a real-looking lit match, standing on the
PrepVia slate-black rounded square. A pine stick with grain, a grainy red head charred at the top
with a glowing ember line, and a match flame with a yellow core whose glow lights the square.
Rendered with light and shading (numpy), not flat shapes. `python scripts/make_icons.py`."""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
TOP, BOTTOM = (23, 32, 43), (10, 14, 20)  # #17202B -> #0A0E14 (PrepVia slate)
LINE = (42, 53, 68)  # #2A3544


# ── small tools ─────────────────────────────────────────────────────────────
def _box(a: np.ndarray, r: int, axis: int) -> np.ndarray:
    if r < 1:
        return a
    pad = [(0, 0), (0, 0)]
    pad[axis] = (r + 1, r)
    c = np.cumsum(np.pad(a, pad, mode="edge"), axis=axis, dtype=np.float64)
    out = c[2 * r + 1:] - c[:-2 * r - 1] if axis == 0 else c[:, 2 * r + 1:] - c[:, :-2 * r - 1]
    return (out / (2 * r + 1)).astype(np.float32)


def blur(a: np.ndarray, sigma: float) -> np.ndarray:
    """Gaussian blur (three box passes)."""
    if sigma < 0.5:
        return a
    r = max(1, int(round((math.sqrt(12 * sigma * sigma / 3 + 1) - 1) / 2)))
    for _ in range(3):
        a = _box(_box(a, r, 0), r, 1)
    return a


def mask_of(s: int, draw) -> np.ndarray:
    im = Image.new("L", (s, s), 0)
    draw(ImageDraw.Draw(im))
    return np.asarray(im, dtype=np.float32) / 255.0


def smooth_noise(s: int, cells: int, rng) -> np.ndarray:
    """Value noise in [0, 1]: a small random grid scaled up smoothly."""
    g = (rng.random((cells, cells)) * 255).astype(np.uint8)
    return np.asarray(Image.fromarray(g).resize((s, s), Image.BICUBIC), dtype=np.float32) / 255.0


def bezier(p0, p1, p2, n=28):
    return [((1 - t) ** 2 * p0[0] + 2 * (1 - t) * t * p1[0] + t ** 2 * p2[0],
             (1 - t) ** 2 * p0[1] + 2 * (1 - t) * t * p1[1] + t ** 2 * p2[1]) for t in (i / n for i in range(n + 1))]


def drop(cx: float, cy: float, r: float, height: float, lean: float) -> list:
    """A flame outline: round bottom (circle at cx, cy), tip `height` above it."""
    tip = (cx + lean, cy - height)
    arc = [(cx + r * math.cos(math.radians(a)), cy + r * math.sin(math.radians(a))) for a in range(-12, 193, 6)]
    right = bezier(tip, (cx + r * 1.12 + lean * 0.3, cy - height * 0.40), arc[0])
    left = bezier(arc[-1], (cx - r * 1.04 + lean * 0.4, cy - height * 0.47), tip)
    return right + arc + left


def over(img: np.ndarray, color, alpha: np.ndarray) -> np.ndarray:
    a = np.clip(alpha, 0, 1)[..., None]
    return img * (1 - a) + np.asarray(color, np.float32) * a


# ── the match ───────────────────────────────────────────────────────────────
def icon(px: int) -> Image.Image:
    scale = 4 if px <= 128 else 2
    s = px * scale
    rng = np.random.default_rng(7)
    Y, X = (np.mgrid[0:s, 0:s].astype(np.float32) + 0.5) / s
    P = lambda x, y: (x * s, y * s)  # noqa: E731
    tiny, small = px < 32, px < 48

    cx = 0.5
    hw = 0.085 if tiny else 0.072 if small else 0.062  # half the stick's width
    hx, hy = cx, 0.42  # head center
    hrx, hry = hw * 1.66, hw * 2.15
    y_bot = 0.915

    # background: the slate square, lit by the flame from above
    img = np.asarray(TOP, np.float32) * (1 - Y[..., None]) + np.asarray(BOTTOM, np.float32) * Y[..., None]
    fx, fy = cx + 0.004, hy - hry - 0.08  # middle of the flame
    d = np.sqrt((X - fx) ** 2 + ((Y - fy) * 0.85) ** 2)
    img += np.asarray((255, 125, 45), np.float32) * (np.exp(-(d / 0.30) ** 2) * 0.30)[..., None]

    # the stick, standing, its bottom end cut square
    stick = mask_of(s, lambda dw: dw.rounded_rectangle([*P(cx - hw, hy), *P(cx + hw, y_bot)], radius=s * hw * 0.18, fill=255))
    fib = np.asarray(Image.fromarray((rng.random((1, max(8, s // 3))) * 255).astype(np.uint8)).resize((s, s), Image.BICUBIC),
                     dtype=np.float32) / 255.0
    wav = smooth_noise(s, 6, rng)
    grain = np.take_along_axis(fib, np.clip((np.arange(s)[None, :] + (wav - 0.5) * s * 0.02).astype(int), 0, s - 1), axis=1)
    wood = np.asarray((240, 208, 156), np.float32) * (0.84 + 0.20 * grain[..., None]) * (0.95 + 0.08 * smooth_noise(s, 9, rng)[..., None])
    wood *= (1 - 0.18 * np.clip((Y - (y_bot - 0.012)) / 0.012, 0, 1))[..., None]  # the end grain at the bottom

    # the head: a slightly lumpy bulb, red coating with grain, charred where it burns
    lump = rng.uniform(-1, 1, 9)

    def head_shape(dw: ImageDraw.ImageDraw):
        pts = []
        for i in range(72):
            a = 2 * math.pi * i / 72
            k = 1 + 0.035 * sum(lump[j] * math.sin((j + 2) * a + j) for j in range(3)) / 3
            pts.append(P(hx + hrx * k * math.sin(a), hy - hry * k * math.cos(a)))
        dw.polygon(pts, fill=255)
    head = mask_of(s, head_shape)
    speck = np.asarray(Image.fromarray((rng.random((s // 2 + 1, s // 2 + 1)) * 255).astype(np.uint8)).resize((s, s), Image.BILINEAR),
                       dtype=np.float32) / 255.0
    red = np.asarray((176, 32, 24), np.float32) * (0.86 + 0.18 * speck[..., None])
    red = red * (1 - 0.25 * np.clip((Y - hy - hry * 0.55) / (hry * 0.4), 0, 1))[..., None]  # thinner coat at the bottom
    yc = hy - hry * 0.45 + (smooth_noise(s, 7, rng) - 0.5) * hry * 0.18  # where the char ends
    char = np.clip((yc - Y) / (hry * 0.10) + 0.5, 0, 1)
    soot = np.asarray((36, 24, 21), np.float32) * (0.75 + 0.5 * speck[..., None])
    head_alb = red * (1 - char[..., None]) + soot * char[..., None]
    ember = np.exp(-((Y - yc) / (hry * 0.07)) ** 2) * head  # glowing line between char and coat

    # shading: a soft height map from the shapes, lit by the flame above and a cool fill light
    H = blur(stick, s * 0.022) * stick * 0.55 * (1 - head) + blur(head, s * 0.045) * head * 1.25
    H += (grain - 0.5) * 0.02 * stick + (speck - 0.5) * 0.018 * head
    gy, gx = np.gradient(H * s * 0.05)
    n = np.stack([-gx, -gy, np.ones_like(H)], -1)
    n /= np.linalg.norm(n, axis=-1, keepdims=True)
    Lf = np.stack([fx - X, fy - Y, np.full_like(X, 0.22) - H * 0.05], -1)
    dist = np.linalg.norm(Lf, axis=-1, keepdims=True)
    Lf /= dist
    flame_i = 2.1 / (1 + (dist[..., 0] / 0.34) ** 2)
    fill = np.asarray((-0.45, -0.30, 0.84), np.float32)
    fill /= np.linalg.norm(fill)
    diff_f = np.clip((n * Lf).sum(-1), 0, 1) * flame_i
    diff_c = np.clip((n * fill).sum(-1), 0, 1) * 0.48
    light = (0.26 + diff_f[..., None] * np.asarray((1.0, 0.72, 0.45), np.float32)
             + diff_c[..., None] * np.asarray((0.70, 0.78, 0.95), np.float32))
    hv = Lf + np.asarray((0, 0, 1), np.float32)
    hv /= np.linalg.norm(hv, axis=-1, keepdims=True)
    spec = np.clip((n * hv).sum(-1), 0, 1) ** 28 * flame_i * 0.55 * head * (1 - char)

    # under the head the stick sits in its shadow; under the stick, a soft shadow on the ground
    ao = 1 - 0.38 * np.exp(-((Y - (hy + hry * 0.88)) / 0.03) ** 2) * stick * (1 - head)
    shadow = mask_of(s, lambda dw: dw.ellipse([*P(cx - 0.10, y_bot - 0.010), *P(cx + 0.10, y_bot + 0.020)], fill=255))
    img *= (1 - blur(shadow, s * 0.014) * 0.55)[..., None]
    img = img * (1 - stick[..., None]) + (wood * light * ao[..., None]) * stick[..., None]
    head_lit = head_alb * light + spec[..., None] * np.asarray((255, 220, 190), np.float32)
    img = img * (1 - head[..., None]) + head_lit * head[..., None]
    glow_col = np.asarray((255, 120, 35), np.float32)
    img += glow_col * (ember * 0.85)[..., None]
    img += glow_col * blur(ember, s * 0.01)[..., None] * 0.6

    # the flame: a soft glow, the orange body, a yellow core
    bx, by = cx + 0.002, hy - hry * 0.92
    fr = hrx * (1.05 if small else 0.98)
    fh = 0.25 if not small else 0.23
    outer = mask_of(s, lambda dw: dw.polygon([P(*p) for p in drop(bx, by, fr, fh, 0.010)], fill=255))
    mid = mask_of(s, lambda dw: dw.polygon([P(*p) for p in drop(bx, by + 0.012, fr * 0.68, fh * 0.70, 0.007)], fill=255))
    core = mask_of(s, lambda dw: dw.polygon([P(*p) for p in drop(bx, by + 0.022, fr * 0.36, fh * 0.36, 0.003)], fill=255))
    tip_t = np.clip((by - Y) / fh, 0, 1)
    img += np.asarray((255, 130, 40), np.float32) * (blur(outer, s * 0.07) * 0.55)[..., None]
    so = blur(outer, s * 0.010) * (0.92 - 0.35 * tip_t)
    body = np.asarray((255, 172, 58), np.float32) * (1 - tip_t[..., None]) + np.asarray((255, 92, 26), np.float32) * tip_t[..., None]
    img = img * (1 - so[..., None]) + body * so[..., None]
    img = over(img, (255, 212, 96), blur(mid, s * 0.010) * 0.92)
    img = over(img, (255, 247, 222), blur(core, s * 0.008) * 0.96)
    img = np.clip(img, 0, 255)

    # the rounded square, its thin outline, and nothing outside it
    radius = int(s * 0.24)
    sq = mask_of(s, lambda dw: dw.rounded_rectangle([0, 0, s - 1, s - 1], radius=radius, fill=255))
    if not tiny:
        w = max(2, int(s * 0.025))
        ring = mask_of(s, lambda dw: dw.rounded_rectangle([w // 2, w // 2, s - 1 - w // 2, s - 1 - w // 2], radius=radius, outline=255, width=w))
        img = over(img, LINE, ring)
    rgba = np.dstack([img, sq * 255]).astype(np.uint8)
    return Image.fromarray(rgba, "RGBA").resize((px, px), Image.LANCZOS)


if __name__ == "__main__":
    OUT.mkdir(parents=True, exist_ok=True)
    for px in (16, 32, 48, 128):
        icon(px).save(OUT / f"icon{px}.png")
    print("icons in", OUT)
