#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""taptap-maker-local-sfx 环境管理脚本（纯标准库）。

子命令:
  check    硬件与环境检查（GPU/显存/驱动/磁盘），给出「能不能跑」的结论
  guide    打印模型权重的手动下载指引（本脚本绝不自动下载）
  verify   校验已下载的模型文件（SHA256，内置清单，离线可用）
  deps     打印依赖安装命令；加 --yes 才真正执行（装 venv + torch/diffusers）
  doctor   装好后的体检：torch CUDA、diffusers 导入、模型文件齐全性

模型目录解析顺序:
  1) 环境变量 TAPTAP_SFX_HOME
  2) 现成的已知安装（如 D:\\stable-audio，含 model/stable-audio-open-1.0）
  3) 默认 %LOCALAPPDATA%\\taptap-maker-sfx
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import re
import shutil
import subprocess
import sys

MODEL_REPO = "stabilityai/stable-audio-open-1.0"
MIRROR = "https://modelscope.cn/api/v1/models/{repo}/repo?Revision=master&FilePath={path}"
MIRROR_PAGE = "https://modelscope.cn/models/stabilityai/stable-audio-open-1.0"
HF_PAGE = "https://huggingface.co/stabilityai/stable-audio-open-1.0"
LICENSE_NOTE = "Stability AI Community License：个人与年营收 < 100 万美元的团队免费商用"

# 与 ModelScope 官方镜像逐一核对过的 SHA256（2026-10-28 校验全部 17 个文件 MATCH）
MANIFEST = [
    # path, size, sha256
    ("model_index.json", 498, "80b5bfb4f4ed10f56f27846377f000541d341eed6db17041b820606c548be6a9"),
    ("configuration.json", 71, "3eefed50f26939655a89fcb85efb21acbe4b0fe470f9f61146092fdd83c8d894"),
    ("model_config.json", 4172, "b29307b92126a9edb776e34ec99fee4aafaf22645483cd4136dd65ec51fceb9a"),
    ("LICENSE.md", 11852, "d6f6b1a4dce5c852bd6d7d9482d002baf0ccdb71e662250b73be9eec8764ee8d"),
    ("scheduler/scheduler_config.json", 411, "7d476d3ad984693c144169ae7e7fd978cf2cd6bb3b9b224db3ee944d83a5ad41"),
    ("text_encoder/config.json", 1497, "491696a2ea20e9f5e78b4f150fab241a42d9d64d75b8031cab5b91d2da62a535"),
    ("text_encoder/model.safetensors", 438525864, "095878c81d21f17d235e1b4aa20e9595289177e2658ef4dcec69fa5aa3b07ca2"),
    ("tokenizer/special_tokens_map.json", 2201, "5c87151ef0f72a99d1f766a4c418bd2a1f90aaa30a8e22fe5eca9641daebb64f"),
    ("tokenizer/spiece.model", 791656, "d60acb128cf7b7f2536e8f38a5b18a05535c9e14c7a355904270e15b0945ea86"),
    ("tokenizer/tokenizer.json", 2422169, "71c33c3bf57bf2e19b4f8ac686ad8d182a79f7cd1a4921889437c453420223f1"),
    ("tokenizer/tokenizer_config.json", 20768, "63c92e838e62d98bf80514739be8eba70707aedf656a1faf113d5d4ae585045c"),
    ("transformer/config.json", 391, "b5dd7f337bdcb51f68d414d619710d9fe5b9d18a3c1056afcb9ae6e020478414"),
    ("transformer/diffusion_pytorch_model.safetensors", 4227806200, "65ae9715febfeb2dc9f33aa506c2bda69fd2ddf8ebc483fb2df090df4ca506fd"),
    ("projection_model/config.json", 181, "a83ff2e87d709803d7702bdadb705e72b22ced16ad0fd929a8af1d11ed57b2a1"),
    ("projection_model/diffusion_pytorch_model.safetensors", 1586944, "032102e2b0e4b9b9e19c648dc476345157b97906752a7b4b7a0133900f340926"),
    ("vae/config.json", 350, "858b6cce27aa1b2d1e8d331734d2d9690d9ea1dad2fb1e6bd23ee67a61058ad9"),
    ("vae/diffusion_pytorch_model.safetensors", 624490240, "2131cdb52020b2473707465449d8bdb4f6cca61c93150a947baca02bc58ffd7b"),
]
TOTAL_BYTES = sum(s for _, s, _ in MANIFEST)
MODEL_SUBDIR = os.path.join("model", "stable-audio-open-1.0")

TORCH_PIN = "torch==2.14.1"
TORCH_WHEEL_MIRROR = "https://mirrors.aliyun.com/pytorch-wheels/{cu}/torch-{v}%2B{cu}-cp311-cp311-win_amd64.whl"


def resolve_home() -> str:
    """模型安装根目录：环境变量 > 已知现成安装 > 默认。"""
    env = os.environ.get("TAPTAP_SFX_HOME")
    if env and os.path.isdir(os.path.join(env, MODEL_SUBDIR)):
        return env
    for known in (r"D:\stable-audio", os.path.join(os.environ.get("LOCALAPPDATA", ""), "taptap-maker-sfx")):
        if known and os.path.isdir(os.path.join(known, MODEL_SUBDIR)):
            return known
    if env:
        return env
    return os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "taptap-maker-sfx")


def model_dir(home: str) -> str:
    return os.path.join(home, MODEL_SUBDIR)


def venv_python(home: str) -> str:
    return os.path.join(home, "venv", "Scripts", "python.exe")


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8 * 1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def gpu_report() -> dict:
    """从 nvidia-smi 读取 GPU 信息；读不到就返回不可用。"""
    out = {"available": False}
    smi = shutil.which("nvidia-smi")
    if not smi:
        return out
    try:
        r = subprocess.run(
            [smi, "--query-gpu=name,memory.total,driver_version", "--format=csv,noheader"],
            capture_output=True, text=True, timeout=15,
        )
        line = r.stdout.strip().splitlines()[0]
        name, mem, drv = [p.strip() for p in line.split(",")]
        vram_mb = int(re.sub(r"[^\d]", "", mem) or 0)
        out.update(available=True, name=name, vram_mb=vram_mb, driver=drv)
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)
    return out


def verdict_for(vram_mb: int) -> str:
    if vram_mb >= 8192:
        return "可以跑 Stable Audio Open 1.0（fp16 + 低显存模式，实测 8GB 卡约 35-55 秒/条）"
    if vram_mb >= 6144:
        return "勉强可跑：务必始终开低显存模式，生成前关掉吃显存的程序；体验一般，也可考虑更轻的方案"
    return "不建议：显存不足，本地生成体验会很差；建议用 CC0 音效库或在线生图通道的替代方案"


def cmd_check(_args) -> int:
    home = resolve_home()
    md = model_dir(home)
    print("== taptap-maker-local-sfx 环境检查 ==")
    print(f"python      : {platform.python_version()} ({sys.executable})")
    print(f"安装目录     : {home}  ({'已存在' if os.path.isdir(home) else '尚不存在'})")
    g = gpu_report()
    if g.get("available"):
        print(f"GPU         : {g['name']}, {g['vram_mb'] // 1024} GB 显存, 驱动 {g['driver']}")
        print(f"结论        : {verdict_for(g['vram_mb'])}")
    else:
        print("GPU         : 未检测到 NVIDIA GPU（nvidia-smi 不可用）")
        print("结论        : 本方案需要 NVIDIA 显卡（建议 8GB 显存）；当前机器不建议部署，"
              "用 CC0 音效库（taptap-audio）或在线通道更合适")
    free_gb = None
    drive = os.path.splitdrive(home)[0] or "C:"
    try:
        import ctypes
        free_bytes = ctypes.c_ulonglong(0)
        ctypes.windll.kernel32.GetDiskFreeSpaceExW(ctypes.c_wchar_p(drive + "\\"), None, None,
                                                   ctypes.byref(free_bytes))
        free_gb = free_bytes.value / 1024 ** 3
    except Exception:  # noqa: BLE001
        pass
    if free_gb is not None:
        need = TOTAL_BYTES / 1024 ** 3 + 6  # 模型 + venv(torch 等)
        print(f"磁盘         : {drive} 剩余 {free_gb:.0f} GB（需要约 {need:.0f} GB）"
              + ("" if free_gb >= need else "  ← 空间不足"))
    n_ok = sum(1 for p, s, _ in MANIFEST if os.path.isfile(os.path.join(md, p.replace("/", os.sep))))
    print(f"模型文件     : {n_ok}/{len(MANIFEST)} 个已就位" + ("（完整）" if n_ok == len(MANIFEST) else "（不完整 → 运行 guide 看手动下载指引）"))
    vp = venv_python(home)
    print(f"Python venv  : {'已就绪' if os.path.isfile(vp) else '未创建'} ({vp})")
    print()
    print("下一步：")
    if n_ok < len(MANIFEST):
        print("  1) 运行  python sfx_env.py guide   看模型手动下载指引（脚本不会替你下载）")
        print("  2) 下载完成后运行  python sfx_env.py verify")
    if not os.path.isfile(vp):
        print("  3) 运行  python sfx_env.py deps --yes   创建环境并安装依赖（约 3GB 下载，需你确认）")
    print("  4) 运行  python sfx_env.py doctor   体检")
    return 0


def cmd_guide(_args) -> int:
    home = resolve_home()
    md = model_dir(home)
    print("== Stable Audio Open 1.0 模型手动下载指引 ==")
    print()
    print("本 skill 不会自动下载模型（体积大，且需要先确认硬件足够）。")
    print("下载前请先跑 `python sfx_env.py check` 确认显卡满足要求（建议 NVIDIA 8GB 显存）。")
    print()
    print(f"官方发布页（二选一）:")
    print(f"  ModelScope 镜像（国内直连，推荐）: {MIRROR_PAGE}")
    print(f"  HuggingFace 原仓（可能需要代理） : {HF_PAGE}")
    print(f"许可: {LICENSE_NOTE}（完整文本见下载的 LICENSE.md）")
    print()
    print(f"目标目录: {md}")
    print(f"共 {len(MANIFEST)} 个文件, 合计 {TOTAL_BYTES / 1024 ** 3:.2f} GB。")
    print("以下命令逐条复制到 PowerShell 执行（断点续传，可重复跑直到全部 OK）：")
    print()
    base = MIRROR.format(repo=MODEL_REPO, path="")
    for path, size, sha in MANIFEST:
        win_path = path.replace("/", "\\")
        print(f"# {path}  ({size / 1024 / 1024:.1f} MB)")
        print(f"$dst='{md}\\{win_path}' ; New-Item -ItemType Directory -Force -Path (Split-Path $dst) | Out-Null ; "
              f"curl.exe -sS -L -C - --retry 6 --retry-delay 3 -o $dst \"{base}{path}\"")
    print()
    print("全部下载完成后运行 `python sfx_env.py verify` 校验 SHA256。")
    print("提示：transformer 那个 4GB 大文件如果单连接太慢，可用任意支持断点续传/多线程的工具，")
    print("下载完仍以 verify 的 SHA256 为准。")
    return 0


def cmd_verify(args) -> int:
    home = resolve_home()
    md = model_dir(home)
    print(f"== 校验 {md} ==")
    ok = bad = missing = 0
    only = set(args.only.split(",")) if args.only else None
    for path, size, sha in MANIFEST:
        if only and not any(path.startswith(o) or path == o for o in only):
            continue
        local = os.path.join(md, path.replace("/", os.sep))
        if not os.path.isfile(local):
            print(f"MISSING  {path}")
            missing += 1
            continue
        got = os.path.getsize(local)
        if got != size:
            print(f"BADSIZE  {path}  (本地 {got} / 期望 {size})")
            bad += 1
            continue
        if args.fast:
            print(f"SIZE-OK  {path}")
            continue
        digest = sha256_of(local)
        if digest == sha:
            print(f"MATCH    {path}")
        else:
            print(f"BADSHA   {path}  (本地 {digest[:12]}… / 期望 {sha[:12]}…)")
            bad += 1
    checked = len(MANIFEST) - missing if not only else None
    if missing == 0 and bad == 0:
        print(f"\n全部通过（{checked if checked else len(MANIFEST)} 个文件 SHA256 与 ModelScope 官方元数据一致）")
        return 0
    print(f"\n缺失 {missing} 个、异常 {bad} 个；补齐后重跑本命令。")
    return 1


def cmd_deps(args) -> int:
    home = resolve_home()
    vp = venv_python(home)
    g = gpu_report()
    cu = "cu130"
    if g.get("available"):
        drv = g.get("driver", "")
        try:
            drv_major = int(drv.split(".")[0])
        except ValueError:
            drv_major = 0
        cu = "cu130" if drv_major >= 580 else "cu126"
    print("== 依赖安装 ==")
    print(f"安装目录: {home}")
    print(f"CUDA 构建: {cu}（依据驱动 {g.get('driver', '?')} 自动选择）")
    print()
    if not args.yes:
        print("本步骤会下载约 3GB（torch CUDA 版 + diffusers 全家桶），默认只打印命令不执行。")
        print("确认要装的话，由你或 agent 明确说明后追加 --yes 运行：")
        print(f"  python sfx_env.py deps --yes")
        print()
    cmds = [
        ["uv", "venv", os.path.join(home, "venv"), "--python", sys.executable],
        ["uv", "pip", "install", "--python", vp, f"torch==2.14.1+{cu}",
         "--find-links", f"https://mirrors.aliyun.com/pytorch-wheels/{cu}/"],
        ["uv", "pip", "install", "--python", vp,
         "--index-url", "https://pypi.tuna.tsinghua.edu.cn/simple",
         "diffusers", "transformers", "accelerate", "soundfile", "scipy",
         "sentencepiece", "protobuf", "torchsde"],
    ]
    if not args.yes:
        for c in cmds:
            print("  " + " ".join(c))
        print()
        print("没有 uv 时把 uv 换成 pip（venv 创建改用 python -m venv）。")
        return 0
    have_uv = shutil.which("uv")
    for c in cmds:
        if not have_uv and c[0] == "uv":
            if c[1] == "venv":
                subprocess.run([sys.executable, "-m", "venv", c[2]], check=True)
                continue
            c = [sys.executable, "-m", "pip", "install"] + c[5:] if c[1] == "pip" else c
        print(">>", " ".join(str(x) for x in c))
        subprocess.run([str(x) for x in c], check=True)
    print("\n依赖安装完成，运行 `python sfx_env.py doctor` 体检。")
    return 0


def cmd_doctor(_args) -> int:
    home = resolve_home()
    vp = venv_python(home)
    print("== taptap-maker-local-sfx 体检 ==")
    if not os.path.isfile(vp):
        print(f"venv 未创建: {vp}  → 先跑 deps --yes")
        return 1
    rc = subprocess.run([vp, "-c",
                         "import torch, diffusers, transformers, soundfile; "
                         "print('torch', torch.__version__); "
                         "print('cuda_available', torch.cuda.is_available()); "
                         "print('gpu', torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'none'); "
                         "print('diffusers', diffusers.__version__, '| transformers', transformers.__version__)"],
                        capture_output=True, text=True, encoding="utf-8", errors="replace")
    print(rc.stdout.strip() or rc.stderr.strip()[-1500:])
    if rc.returncode != 0:
        return 1
    print()
    return _verify_quiet(home)


def _verify_quiet(home: str) -> int:
    md = model_dir(home)
    missing = [p for p, _, _ in MANIFEST if not os.path.isfile(os.path.join(md, p.replace("/", os.sep)))]
    if missing:
        print(f"模型文件不完整：缺 {len(missing)} 个（如 {missing[0]}）→ 跑 guide/verify")
        return 1
    print(f"模型文件齐全：{len(MANIFEST)}/{len(MANIFEST)}（快速校验；完整 SHA256 校验跑 verify）")
    # cmd_doctor 里的 vp 是它自己的局部变量，在这里必须重新解析一次
    # （曾直接引用 vp → NameError，体检成功却以退出码 1 收场，极易误判成「没装好」）。
    vp = venv_python(home)
    print("\n就绪。生成示例：")
    print(f'  "{vp}" "{os.path.join(os.path.dirname(os.path.abspath(__file__)), "generate.py")}" '
          f'"coin pickup, bright arcade blip" -s 3')
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description="taptap-maker-local-sfx 环境管理")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("check", help="硬件与环境检查").set_defaults(func=cmd_check)
    sub.add_parser("guide", help="模型手动下载指引（不自动下载）").set_defaults(func=cmd_guide)
    p = sub.add_parser("verify", help="校验模型文件 SHA256")
    p.add_argument("--only", default=None, help="只校验某子目录，如 transformer")
    p.add_argument("--fast", action="store_true", help="只比大小不比 SHA256")
    p.set_defaults(func=cmd_verify)
    p = sub.add_parser("deps", help="打印/执行依赖安装")
    p.add_argument("--yes", action="store_true", help="真正执行（默认只打印命令）")
    p.set_defaults(func=cmd_deps)
    sub.add_parser("doctor", help="安装后体检").set_defaults(func=cmd_doctor)
    args = ap.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
