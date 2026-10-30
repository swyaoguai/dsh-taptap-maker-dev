"""Local-only Pillow worker: immutable stdin image -> verified metadata/encoded bytes.

No network, filesystem writes, model/account access or dependency installation.
Invoked by reference-image-preparation.mjs with one bounded JSON policy argument.
"""
from __future__ import annotations

import base64
import io
import json
import sys
import warnings

import PIL
from PIL import Image, ImageOps, UnidentifiedImageError

MIMES = {
    "PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp",
    "GIF": "image/gif", "BMP": "image/bmp", "AVIF": "image/avif",
}
QUALITIES = (86, 80, 74, 68, 62, 56, 50)


class PreparationError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def fail(code: str, message: str) -> None:
    raise PreparationError(code, message)


def has_transparency(image: Image.Image) -> bool:
    if "A" not in image.getbands() and "transparency" not in image.info:
        return False
    return image.convert("RGBA").getchannel("A").getextrema()[0] < 255


def dimensions_allowed(width: int, height: int, policy: dict) -> bool:
    return (0 < width <= 32768 and 0 < height <= 32768
            and width * height <= policy["maxInputPixels"])


def metadata(image: Image.Image, mime: str) -> dict:
    return {"mime": mime, "width": image.width, "height": image.height,
            "hasAlpha": has_transparency(image), "animated": False}


def prepare(data: bytes, policy: dict) -> dict:
    Image.MAX_IMAGE_PIXELS = policy["maxInputPixels"]
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    with Image.open(io.BytesIO(data)) as probe:
        mime = MIMES.get(probe.format)
        if mime is None:
            fail("unsupported_reference_image", "不支持的图片格式")
        if not dimensions_allowed(probe.width, probe.height, policy):
            fail("reference_image_dimensions_exceeded", "参考图超出本地安全像素限制")
        if getattr(probe, "n_frames", 1) != 1:
            fail("animated_reference_unsupported", "动画参考图需先导出静态帧")
        probe.verify()

    with Image.open(io.BytesIO(data)) as opened:
        opened.load()  # verify() alone does not decode JPEG/WebP pixels.
        source = metadata(opened, mime)
        orientation = opened.getexif().get(274, 1)
        source["orientation"] = orientation
        image = ImageOps.exif_transpose(opened)
        image.load()
        if not dimensions_allowed(image.width, image.height, policy):
            fail("reference_image_dimensions_exceeded", "参考图超出本地安全像素限制")

    reasons = []
    if len(data) > policy["perFileTarget"]:
        reasons.append("bytes")
    if max(image.size) > policy["maxEdge"]:
        reasons.append("dimensions")
    if mime not in policy["acceptedMimes"]:
        reasons.append("format")
    if orientation not in (None, 1):
        reasons.append("orientation")
    if not reasons:
        return {"ok": True, "source": source, "output": {**source, "orientation": 1},
                "changed": False, "reason": "passthrough", "quality": None,
                "toolVersion": PIL.__version__}

    # RGB(A) conversion preserves actual transparency; an opaque RGBA source is
    # allowed to become an opaque WebP instead of tripping a channel-only guard.
    image = image.convert("RGBA" if source["hasAlpha"] else "RGB")
    width, height = image.size
    edge = min(policy["maxEdge"], max(width, height))
    floor = min(edge, policy["minEdge"])
    fmt = policy["outputFormat"]
    while True:
        scale = min(1.0, edge / max(width, height))
        size = (max(1, round(width * scale)), max(1, round(height * scale)))
        candidate = image if size == image.size else image.resize(size, Image.Resampling.LANCZOS)
        for quality in (QUALITIES if fmt == "webp" else (None,)):
            encoded = io.BytesIO()
            if fmt == "webp":
                candidate.save(encoded, format="WEBP", quality=quality, method=4, exact=True)
            else:
                candidate.save(encoded, format="PNG", optimize=True, compress_level=9)
            output = encoded.getvalue()
            if len(output) > policy["perFileTarget"]:
                continue
            # Decode the final pixels independently of the encoder's claims.
            with Image.open(io.BytesIO(output)) as final:
                final.load()
                actual = metadata(final, MIMES.get(final.format, ""))
            if actual["mime"] not in policy["acceptedMimes"]:
                fail("reference_preprocess_failed", "结果格式不符合当前通道要求")
            if source["hasAlpha"] and not actual["hasAlpha"]:
                fail("reference_preprocess_failed", "透明度未保留，拒绝上传")
            return {"ok": True, "source": source, "output": actual, "changed": True,
                    "reason": "+".join(reasons), "quality": quality,
                    "dataBase64": base64.b64encode(output).decode("ascii"),
                    "toolVersion": PIL.__version__}
        if edge <= floor:
            break
        next_edge = max(floor, int(edge * 0.82))
        if next_edge == edge:
            break
        edge = next_edge
    fail("reference_budget_exceeded", "已达到最小处理尺寸，仍无法满足上传体积限制；请调整参考图或预算")


def main() -> None:
    policy = json.loads(sys.argv[1])
    data = sys.stdin.buffer.read(policy["maxInputBytes"] + 1)
    if not data or len(data) > policy["maxInputBytes"]:
        fail("reference_input_too_large", "输入为空或超出本地字节限制")
    try:
        result = prepare(data, policy)
    except (Image.DecompressionBombError, Image.DecompressionBombWarning) as exc:
        raise PreparationError("reference_image_dimensions_exceeded", "参考图像素过大") from exc
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError) as exc:
        raise PreparationError("reference_decode_failed", "参考图无法完整解码，可能已损坏或当前解码器不支持") from exc
    print(json.dumps(result, ensure_ascii=True, separators=(",", ":")))


if __name__ == "__main__":
    try:
        main()
    except PreparationError as exc:
        print(json.dumps({"ok": False, "code": exc.code, "message": str(exc)}, ensure_ascii=True))
        sys.exit(2)
