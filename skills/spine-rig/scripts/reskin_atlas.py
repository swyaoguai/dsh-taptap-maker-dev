#!/usr/bin/env python3
"""
reskin_atlas.py — 把一张「换皮后的整图」切回部件并重打包图集（spine-rig 工作流）。

场景：角色已经绑好骨（有 skeleton.json + atlas + parts/）。现在用图生图
（Gemini Nano Banana / 中转站 /images/edits 等）对「按原 layout 合成的整图」
换风格，得到 reskin.png。本脚本把 reskin.png 按原 atlas 的区域包围盒切开，
输出新的 parts/ 并重打包成新图集；骨骼与动画**原样复用**（这就是 reskin
工作流的核心价值：换皮不用重新绑骨）。

前提（非常重要，做不到就别用本脚本）：
  换皮模型必须**保持构图/像素位置 1:1**（Nano Banana 类编辑模型可以；
  文生图模型不行，它们会重新构图，切出来全是错的）。

用法：
  python reskin_atlas.py --reskin reskin.png --atlas hero.atlas --out-dir out/
      [--prefix skin2-] [--keep-skeleton skeleton.json] [--name hero-reskin]

输出（--out-dir 下）：
  parts/<region>.png        切好的部件（可直接回喂 build_spine_json 流程）
  <name>.png / <name>.atlas  重打包的图集（--name，默认 hero-reskin）
  skeleton.json              原样拷贝（--keep-skeleton 提供时）

退出口径：
  - 区域裁切后若整块全透明/纯色，打印警告（多半是构图漂了），不要硬编成功。
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

# Windows GBK 控制台下中文输出会 UnicodeEncodeError / 乱码：统一按 UTF-8 写
# stdout（errors=replace 保证任何终端都不炸）。
if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

try:
    from PIL import Image
except ImportError:
    print("ERROR: Pillow required. Install: python -m pip install Pillow")
    sys.exit(1)


def parse_atlas(atlas_path: Path):
    """解析 Spine atlas → [(name, x, y, w, h, rotate)]，兼容 xy/bounds 两种写法。"""
    text = atlas_path.read_text(encoding="utf-8")
    regions = []
    cur = None
    for raw in text.splitlines():
        line = raw.rstrip()
        if not line:
            continue
        if not raw.startswith((" ", "\t")) and ":" not in line:
            # 跳过页头（第一列且以 .png 结尾的行）
            if line.strip().lower().endswith(".png"):
                continue
            if cur is not None:
                regions.append(cur)
            cur = {"name": line.strip(), "x": 0, "y": 0, "w": 0, "h": 0, "rotate": 0}
            continue
        if cur is None:
            continue
        stripped = line.strip()
        # 标准 Spine atlas：xy 与 size 是两条独立属性行（各 2 个数），
        # 部分变体用 bounds: x, y, w, h 一行四数。三种都要认。
        for key in ("xy", "bounds", "size"):
            m = re.match(rf"^{key}:\s*(.+)$", stripped)
            if m is None:
                continue
            nums = [int(v.strip()) for v in m.group(1).split(",") if v.strip().lstrip("-").isdigit()]
            if key == "xy" and len(nums) >= 2:
                cur["x"], cur["y"] = nums[0], nums[1]
            elif key == "bounds" and len(nums) >= 4:
                cur["x"], cur["y"], cur["w"], cur["h"] = nums[0], nums[1], nums[2], nums[3]
            elif key == "size" and len(nums) >= 2:
                cur["w"], cur["h"] = nums[0], nums[1]
            break
        if stripped.startswith("rotate:"):
            v = stripped.split(":", 1)[1].strip()
            cur["rotate"] = 90 if v == "true" else (int(v) if v.isdigit() else 0)
    if cur is not None:
        regions.append(cur)
    return regions


def parse_atlas_size(atlas_path: Path):
    """读 atlas 页头的 size: W, H（找不到返回 None）。"""
    text = atlas_path.read_text(encoding="utf-8")
    m = re.search(r"^\s*size:\s*(\d+)\s*,\s*(\d+)", text, re.MULTILINE)
    if m is None:
        return None
    return int(m.group(1)), int(m.group(2))


def main():
    p = argparse.ArgumentParser(description="Slice a reskinned sheet back into parts and repack")
    p.add_argument("--reskin", required=True, help="换皮后的整图 PNG")
    p.add_argument("--atlas", required=True, help="原 atlas（提供区域包围盒）")
    p.add_argument("--out-dir", required=True, help="输出目录")
    p.add_argument("--name", default="hero-reskin", help="新图集基础名")
    p.add_argument("--prefix", default="", help="部件重命名前缀（多套皮防覆盖）")
    p.add_argument("--keep-skeleton", default=None, help="原样拷贝的 skeleton.json 路径")
    p.add_argument("--padding", type=int, default=2)
    args = p.parse_args()

    reskin = Image.open(args.reskin).convert("RGBA")
    regions = parse_atlas(Path(args.atlas))
    if not regions:
        print("ERROR: atlas 里没解析到区域")
        sys.exit(1)

    sw, sh = reskin.size
    # 原图集页尺寸：换皮图若与之不同（模型改了分辨率），包围盒整体漂移。
    # - 宽高比一致（常见的 2x 整数倍）→ 直接缩放回原尺寸，包围盒按比例成立。
    # - 宽高比不一致 → 只能等比缩放 + 透明画布贴左上角（atlas 坐标原点），
    #   多出来的边是透明的；此时构图多半已被模型重排，强警告人工确认。
    atlas_size = parse_atlas_size(Path(args.atlas))
    if atlas_size is not None and (atlas_size[0], atlas_size[1]) != (sw, sh):
        aw0, ah0 = atlas_size
        scale = min(aw0 / sw, ah0 / sh)
        scaled = reskin.resize((max(1, round(sw * scale)), max(1, round(sh * scale))), Image.LANCZOS)
        canvas = Image.new("RGBA", (aw0, ah0), (0, 0, 0, 0))
        canvas.paste(scaled, (0, 0))
        if abs((sw / sh) - (aw0 / ah0)) > 0.01:
            print(f"WARN 换皮图 {sw}x{sh} 与原图集 {aw0}x{ah0} 宽高比不同：模型大概率重排了构图，"
                  f"已等比缩放贴左上角再切，**切出的部件很可能错位，务必人工检查**")
        else:
            print(f"WARN 换皮图 {sw}x{sh} 与原图集 {aw0}x{ah0} 尺寸不同，已缩放回原尺寸再切（请抽查部件）")
        reskin = canvas
        sw, sh = aw0, ah0
    out_dir = Path(args.out_dir)
    parts_dir = out_dir / "parts"
    parts_dir.mkdir(parents=True, exist_ok=True)

    import shutil  # noqa: F401  (实际拷贝在下方分支；顶部统一 import 避免局部导入风格混杂)
    # 复用 spine-rig 同目录 make_atlas.py 的打包器：subprocess 会引入路径问题，
    # 这里直接 import（同目录脚本）。
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from make_atlas import pack  # noqa: E402

    images = {}
    warn = 0
    for r in regions:
        x, y, w, h = r["x"], r["y"], r["w"], r["h"]
        rot = int(r.get("rotate") or 0)
        # rotate: 90 的区域在图集上宽高互换（转置放置）：先按互换后的覆盖区
        # 裁切，再逆时针转 90° 复原（实测夹具验证，见 SKILL.md reskin 章节）。
        cover_w, cover_h = (h, w) if rot in (90, 270) else (w, h)
        if x + cover_w > sw or y + cover_h > sh:
            print(f"  WARN {r['name']}: 区域 ({x},{y},{cover_w},{cover_h}) 超出换皮图 {sw}x{sh} —— 构图漂了？跳过")
            warn += 1
            continue
        part = reskin.crop((x, y, x + cover_w, y + cover_h))
        if rot == 90:
            part = part.rotate(90, expand=True)
        elif rot == 270:
            part = part.rotate(-90, expand=True)
        elif rot == 180:
            part = part.rotate(180, expand=True)
        # 全透明或近纯色 = 这一块大概率切空了
        # （部分换皮模型会丢 alpha：全不透明的块不算失败，只有「整块完全
        #   透明」才说明这块区域上根本没有像素。）
        try:
            extrema = part.getchannel("A").getextrema()
        except Exception:
            extrema = (255, 255)
        if extrema is not None and extrema[1] == 0:
            print(f"  WARN {r['name']}: 裁出的块全透明（构图漂移或换皮失败）")
            warn += 1
        name = f"{args.prefix}{r['name']}"
        part.save(parts_dir / f"{name}.png")
        images[name] = part

    if not images:
        print("ERROR: 一个可用区域都没有")
        sys.exit(1)

    aw, ah, placements = pack(images, args.padding)
    atlas_img = Image.new("RGBA", (aw, ah), (0, 0, 0, 0))
    for name, (x, y, w, h) in placements.items():
        atlas_img.paste(images[name], (x, y))
    atlas_img.save(out_dir / f"{args.name}.png")

    lines = [f"{args.name}.png", f"size: {aw},{ah}",
             "format: RGBA8888", "filter: Linear,Linear", "repeat: none"]
    for name, (x, y, w, h) in placements.items():
        lines += [name, "  rotate: false", f"  xy: {x}, {y}",
                  f"  size: {w}, {h}", f"  orig: {w}, {h}",
                  "  offset: 0, 0", "  index: -1"]
    (out_dir / f"{args.name}.atlas").write_text("\n".join(lines) + "\n", encoding="utf-8")

    if args.keep_skeleton:
        # --prefix 改了区域名，但 skeleton 的 slots/skins 还引用原名 → 运行时
        # 附件全部解析失败（角色整块不可见，静默丢渲染）。必须在拷贝时把
        # 附件引用一并改名，保持「骨骼 ↔ 图集」一致。
        if args.prefix:
            import json as _json
            sk = _json.loads(Path(args.keep_skeleton).read_text(encoding="utf-8"))
            renamed = {r["name"]: f"{args.prefix}{r['name']}" for r in regions}
            for slot in sk.get("slots", []):
                if slot.get("attachment") in renamed:
                    slot["attachment"] = renamed[slot["attachment"]]
            for skin in sk.get("skins", []):
                atts = skin.get("attachments", {})
                # 键是 slot 名（不变），值里的附件名要换
                for slot_name, slot_atts in list(atts.items()):
                    for old_name in list(slot_atts.keys()):
                        if old_name in renamed:
                            entry = slot_atts.pop(old_name)
                            slot_atts[renamed[old_name]] = entry
                    # slot 名若恰好与区域同名且也加了前缀 → 需要同步换键
                    # （slot 名与附件名通常同名，但 slot 键不该改：它引用 bones。
                    #  仅当 skins 键与旧附件名相同时才涉及，保守起见不动。）
            (out_dir / "skeleton.json").write_text(
                _json.dumps(sk, indent=2, ensure_ascii=False), encoding="utf-8")
            print(f"骨骼已同步改名附件引用（+{args.prefix} 前缀）→ skeleton.json")
        else:
            shutil.copyfile(args.keep_skeleton, out_dir / "skeleton.json")

    print(f"切回部件 {len(images)} 个（警告 {warn} 条）→ {parts_dir}")
    print(f"新图集：{out_dir / (args.name + '.png')} / {args.name}.atlas ({aw}x{ah})")
    if args.keep_skeleton and not args.prefix:
        print(f"骨骼原样复用：{out_dir / 'skeleton.json'}（换皮不需要重新绑骨）")
    if warn:
        print("有警告：先人工检查 parts/ 里的图再继续，构图漂移时切出来的部件是错的。")


if __name__ == "__main__":
    main()
