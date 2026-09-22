#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
生成扩展图标（16/32/48/128）。

刻意不依赖 Pillow —— 装个图像库只为了画四个纯色方块不划算。
这里直接手写 PNG 字节流（IHDR + IDAT + IEND，zlib 压缩），
像素用 4 倍超采样再降采样，这样圆角和斜线的边缘不会有锯齿。

图形：蓝色渐变圆角方块 + 白色对勾。
"""

import struct
import zlib
import os

OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "extension", "icons")
SIZES = (16, 32, 48, 128)
SS = 4  # 超采样倍数

# 品牌色（和刷题站的 --brand 保持一致）
C_TOP = (0x4F, 0x8B, 0xFF)
C_BOTTOM = (0x2A, 0x5F, 0xD8)
WHITE = (0xFF, 0xFF, 0xFF)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def rounded_rect_alpha(x, y, size, radius):
    """点 (x, y) 在圆角矩形内的覆盖率（0 或 1，超采样后自然变成抗锯齿）。"""
    r = radius
    if x < 0 or y < 0 or x >= size or y >= size:
        return 0
    # 四个角区域做圆形裁剪
    cx = min(max(x, r), size - 1 - r)
    cy = min(max(y, r), size - 1 - r)
    dx = x - cx
    dy = y - cy
    return 1 if (dx * dx + dy * dy) <= r * r else 0


def dist_to_segment(px, py, ax, ay, bx, by):
    vx, vy = bx - ax, by - ay
    wx, wy = px - ax, py - ay
    denom = vx * vx + vy * vy
    t = 0.0 if denom == 0 else max(0.0, min(1.0, (wx * vx + wy * vy) / denom))
    cx, cy = ax + t * vx, ay + t * vy
    return ((px - cx) ** 2 + (py - cy) ** 2) ** 0.5


def check_alpha(x, y, size):
    """白色对勾的覆盖率。两段线段叠加，按距离做 1px 羽化。"""
    s = size
    # 对勾三个控制点（按图标尺寸归一化）
    p1 = (0.28 * s, 0.53 * s)
    p2 = (0.44 * s, 0.69 * s)
    p3 = (0.74 * s, 0.35 * s)
    thick = max(0.075 * s, 1.0)
    d = min(dist_to_segment(x, y, *p1, *p2), dist_to_segment(x, y, *p2, *p3))
    if d <= thick - 0.5:
        return 1.0
    if d >= thick + 0.5:
        return 0.0
    return (thick + 0.5 - d)


def render(size):
    """返回 RGBA 字节串（size*size*4）。"""
    n = size * SS
    radius = n * 0.23
    # 先在超采样网格上算
    hi = bytearray(n * n * 4)
    for yy in range(n):
        for xx in range(n):
            i = (yy * n + xx) * 4
            cover = rounded_rect_alpha(xx + 0.5, yy + 0.5, n, radius)
            if not cover:
                continue
            base = lerp(C_TOP, C_BOTTOM, yy / (n - 1))
            ca = check_alpha(xx + 0.5, yy + 0.5, n)
            r = round(base[0] * (1 - ca) + WHITE[0] * ca)
            g = round(base[1] * (1 - ca) + WHITE[1] * ca)
            b = round(base[2] * (1 - ca) + WHITE[2] * ca)
            hi[i:i + 4] = bytes((r, g, b, 255))

    # 降采样到目标尺寸
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            tr = tg = tb = ta = 0
            for dy in range(SS):
                for dx in range(SS):
                    j = ((y * SS + dy) * n + (x * SS + dx)) * 4
                    a = hi[j + 3]
                    tr += hi[j] * a
                    tg += hi[j + 1] * a
                    tb += hi[j + 2] * a
                    ta += a
            i = (y * size + x) * 4
            if ta == 0:
                out[i:i + 4] = b"\x00\x00\x00\x00"
            else:
                out[i] = round(tr / ta)
                out[i + 1] = round(tg / ta)
                out[i + 2] = round(tb / ta)
                out[i + 3] = round(ta / (SS * SS))
    return bytes(out)


def write_png(path, size, rgba):
    raw = bytearray()
    stride = size * 4
    for y in range(size):
        raw.append(0)  # 每行的 filter type = None
        raw.extend(rgba[y * stride:(y + 1) * stride])

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(bytes(raw), 9))
    png += chunk(b"IEND", b"")

    with open(path, "wb") as f:
        f.write(png)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for s in SIZES:
        p = os.path.join(OUT_DIR, "icon%d.png" % s)
        write_png(p, s, render(s))
        print("wrote", os.path.relpath(p), os.path.getsize(p), "bytes")


if __name__ == "__main__":
    main()
