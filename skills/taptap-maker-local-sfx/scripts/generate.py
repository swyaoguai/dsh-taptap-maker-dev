#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Stable Audio Open 1.0 — 本地文生音效（taptap-maker-local-sfx 版）

模型: stabilityai/stable-audio-open-1.0 (Stability AI Community License, 年营收<$1M免费商用)
模型目录解析: 环境变量 TAPTAP_SFX_HOME > 已知现成安装(如 D:\\stable-audio) > %LOCALAPPDATA%\\taptap-maker-sfx
显存 < 10GB 时自动启用低显存模式（组件轮流上 GPU），可用 --no-lowvram 关闭。

用法:
  python generate.py "sword swing whoosh, fast metallic swoosh" -s 4
  python generate.py "coin pickup" -n 3            # 同提示词出3个不同seed
  python generate.py --batch prompts.txt           # 批量, 每行一条提示词, # 开头为注释
提示词用英文效果最好（模型只用英文数据训练）。
"""
import argparse
import os
import re
import sys
import time

import torch
import soundfile as sf
from diffusers import StableAudioPipeline


def resolve_home() -> str:
    env = os.environ.get("TAPTAP_SFX_HOME")
    model_sub = os.path.join("model", "stable-audio-open-1.0")
    if env and os.path.isdir(os.path.join(env, model_sub)):
        return env
    for known in (r"D:\stable-audio",
                  os.path.join(os.environ.get("LOCALAPPDATA", ""), "taptap-maker-sfx")):
        if known and os.path.isdir(os.path.join(known, model_sub)):
            return known
    return env or os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")),
                               "taptap-maker-sfx")


ROOT = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(resolve_home(), "model", "stable-audio-open-1.0")
DEFAULT_OUTDIR = os.path.join(os.getcwd(), "sfx-output")


def slug(text, maxlen=50):
    s = re.sub(r"[^\w\u4e00-\u9fff-]+", "_", text.strip()).strip("_")
    return s[:maxlen] or "sfx"


def main():
    ap = argparse.ArgumentParser(description="Generate sound effects with Stable Audio Open 1.0")
    ap.add_argument("prompt", nargs="?", default=None, help="sound description (English works best)")
    ap.add_argument("-o", "--out", default=None, help="output directory (default: ./sfx-output)")
    ap.add_argument("-s", "--seconds", type=float, default=10.0, help="clip length in seconds (max 47)")
    ap.add_argument("--steps", type=int, default=100, help="diffusion steps (60~200; more=better, slower)")
    ap.add_argument("--cfg", type=float, default=7.0, help="guidance scale")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("-n", "--variants", type=int, default=1, help="number of seeds per prompt")
    ap.add_argument("--lowvram", dest="lowvram", action="store_true", default=None,
                    help="force low-VRAM streaming mode")
    ap.add_argument("--no-lowvram", dest="lowvram", action="store_false",
                    help="disable low-VRAM mode (large-VRAM GPUs only)")
    ap.add_argument("--batch", default=None, help="text file with one prompt per line")
    args = ap.parse_args()

    if not os.path.isdir(MODEL_DIR):
        sys.exit(f"model dir not found: {MODEL_DIR}\n"
                 "先完成模型手动下载（跑 sfx_env.py guide/verify）或设置 TAPTAP_SFX_HOME 指向安装目录")

    # 自动低显存：显存 < 10GB 一律走流式加载，避免被桌面/浏览器挤进共享内存后慢 30 倍
    lowvram = args.lowvram
    if lowvram is None:
        lowvram = torch.cuda.is_available() and \
            torch.cuda.get_device_properties(0).total_memory < 10 * 1024 ** 3

    print(f"loading model from {MODEL_DIR} (fp16, CUDA{', low-VRAM mode' if lowvram else ''}) ...")
    t0 = time.time()
    pipe = StableAudioPipeline.from_pretrained(MODEL_DIR, torch_dtype=torch.float16)
    gen_device = "cuda"
    if lowvram:
        pipe.enable_model_cpu_offload()
        pipe.vae.enable_slicing()
        pipe.vae.enable_tiling()
        gen_device = "cpu"
    else:
        pipe = pipe.to("cuda")
    pipe.set_progress_bar_config(disable=True)
    print(f"model ready in {time.time() - t0:.1f}s | VRAM: {torch.cuda.memory_allocated() / 2**30:.2f} GiB")

    prompts = []
    if args.prompt:
        prompts.append(args.prompt)
    if args.batch:
        with open(args.batch, encoding="utf-8-sig") as f:
            prompts += [ln.strip() for ln in f if ln.strip() and not ln.lstrip().startswith("#")]
    if not prompts:
        sys.exit("no prompt given (positional arg or --batch file)")

    outdir = args.out or DEFAULT_OUTDIR
    os.makedirs(outdir, exist_ok=True)

    for pi, prompt in enumerate(prompts):
        for i in range(args.variants):
            gen = torch.Generator(gen_device).manual_seed(args.seed + i)
            t0 = time.time()
            audio = pipe(
                prompt,
                negative_prompt="Low quality.",
                num_inference_steps=args.steps,
                audio_end_in_s=min(max(args.seconds, 0.5), 47.0),
                generator=gen,
                guidance_scale=args.cfg,
            ).audios[0]
            dt = time.time() - t0
            audio = audio.float().cpu()
            suffix = "" if (len(prompts) == 1 and args.variants == 1) else f"_{args.seed + i}"
            path = os.path.join(outdir, f"{slug(prompt)}{suffix}.wav")
            sf.write(path, audio.T, pipe.vae.sampling_rate)  # (2, N) -> (N, 2), 44.1kHz stereo
            print(f"[{pi + 1}/{len(prompts)}] saved {path}  ({dt:.1f}s)")


if __name__ == "__main__":
    main()
