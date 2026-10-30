"""Offline Pillow worker tests. All image fixtures stay in memory; nothing is deleted."""
from __future__ import annotations

import base64
import hashlib
import importlib.util
import io
from pathlib import Path
import random
import sys
import unittest
from unittest.mock import patch

from PIL import Image, ImageOps

sys.dont_write_bytecode = True
module_path = Path(__file__).resolve().parents[1] / "src" / "reference-image-codec.py"
spec = importlib.util.spec_from_file_location("reference_codec", module_path)
codec = importlib.util.module_from_spec(spec)
spec.loader.exec_module(codec)
Image.init()


def policy(**overrides):
    result = {"maxEdge": 512, "maxInputPixels": 1_000_000, "maxInputBytes": 4_000_000,
              "perFileTarget": 256_000, "minEdge": 128, "outputFormat": "webp",
              "acceptedMimes": ["image/png", "image/jpeg", "image/webp"]}
    result.update(overrides)
    return result


def image_bytes(image, fmt="PNG", **kwargs):
    output = io.BytesIO()
    image.save(output, format=fmt, **kwargs)
    return output.getvalue()


def prepared_pixels(result):
    image = Image.open(io.BytesIO(base64.b64decode(result["dataBase64"])))
    image.load()
    return image


class ReferenceCodecTests(unittest.TestCase):
    def test_small_rgb_png_passthrough(self):
        source = image_bytes(Image.new("RGB", (40, 20), "green"))
        before = hashlib.sha256(source).hexdigest()
        result = codec.prepare(source, policy())
        self.assertFalse(result["changed"])
        self.assertNotIn("dataBase64", result)
        self.assertEqual(before, hashlib.sha256(source).hexdigest())

    def test_small_jpeg_passthrough_is_fully_decoded(self):
        source = image_bytes(Image.new("RGB", (40, 20), "green"), "JPEG")
        result = codec.prepare(source, policy())
        self.assertEqual(result["source"]["mime"], "image/jpeg")
        self.assertFalse(result["source"]["hasAlpha"])

    def test_transparent_image_retains_pixel_alpha_and_aspect_ratio(self):
        image = Image.new("RGBA", (800, 200), (0, 0, 255, 0))
        image.paste((255, 0, 0, 160), (100, 20, 700, 180))
        result = codec.prepare(image_bytes(image), policy(maxEdge=256))
        final = prepared_pixels(result)
        self.assertEqual(final.size, (256, 64))
        self.assertLess(final.convert("RGBA").getchannel("A").getextrema()[0], 255)
        self.assertTrue(result["source"]["hasAlpha"])

    def test_opaque_rgba_is_not_a_false_alpha_loss(self):
        result = codec.prepare(image_bytes(Image.new("RGBA", (800, 200), (0, 200, 0, 255))), policy())
        self.assertFalse(result["source"]["hasAlpha"])
        self.assertFalse(result["output"]["hasAlpha"])
        self.assertFalse(prepared_pixels(result).mode == "RGBA")

    def test_exif_orientation_is_normalized_even_when_small(self):
        image = Image.new("RGB", (80, 40), "red")
        image.paste("blue", (40, 0, 80, 40))
        exif = Image.Exif()
        exif[274] = 6
        source = image_bytes(image, "JPEG", exif=exif)
        result = codec.prepare(source, policy(outputFormat="png"))
        final = prepared_pixels(result)
        expected = ImageOps.exif_transpose(Image.open(io.BytesIO(source)))
        self.assertEqual(final.size, (40, 80))
        self.assertEqual(final.tobytes(), expected.tobytes())
        self.assertIn("orientation", result["reason"])
        self.assertNotIn(274, final.getexif())

    def test_relay_png_format_and_no_upscale(self):
        source = image_bytes(Image.new("RGB", (40, 20), "green"), "JPEG")
        result = codec.prepare(source, policy(outputFormat="png", acceptedMimes=["image/png"]))
        self.assertEqual(result["output"]["mime"], "image/png")
        self.assertEqual(prepared_pixels(result).size, (40, 20))

    def test_palette_transparency_is_preserved(self):
        image = Image.new("P", (20, 20), 1)
        image.putpalette([0, 0, 0, 255, 80, 0] + [0] * 762)
        image.putpixel((0, 0), 0)
        source = image_bytes(image, "GIF", transparency=0)
        result = codec.prepare(source, policy())
        self.assertTrue(result["source"]["hasAlpha"])
        self.assertEqual(prepared_pixels(result).convert("RGBA").getpixel((0, 0))[3], 0)

    def test_static_bmp_is_normalized(self):
        result = codec.prepare(image_bytes(Image.new("RGB", (30, 15), "red"), "BMP"), policy())
        self.assertEqual(result["output"]["mime"], "image/webp")
        self.assertEqual(prepared_pixels(result).size, (30, 15))

    def test_animation_rejected_not_flattened(self):
        for fmt in ("GIF", "PNG", "WEBP"):
            with self.subTest(format=fmt):
                a, b = Image.new("RGB", (20, 20), "red"), Image.new("RGB", (20, 20), "blue")
                data = image_bytes(a, fmt, save_all=True, append_images=[b], duration=100, loop=0)
                with self.assertRaises(codec.PreparationError) as ctx:
                    codec.prepare(data, policy())
                self.assertEqual(ctx.exception.code, "animated_reference_unsupported")

    def test_corrupt_png_and_truncated_jpeg_never_passthrough(self):
        png = image_bytes(Image.new("RGB", (40, 40), "red"))
        jpeg = image_bytes(Image.new("RGB", (40, 40), "red"), "JPEG")
        for data in (png[:-8], jpeg[:-10], b"not an image"):
            with self.subTest(size=len(data)):
                with self.assertRaises((OSError, ValueError, SyntaxError)):
                    codec.prepare(data, policy())

    def test_tiff_is_explicitly_unsupported(self):
        with self.assertRaises(codec.PreparationError) as ctx:
            codec.prepare(image_bytes(Image.new("RGB", (20, 20)), "TIFF"), policy())
        self.assertEqual(ctx.exception.code, "unsupported_reference_image")

    def test_input_dimensions_checked_before_pixel_loading(self):
        data = image_bytes(Image.new("RGB", (1100, 1000)))
        with self.assertRaises((codec.PreparationError, Image.DecompressionBombWarning)):
            codec.prepare(data, policy())

    def test_byte_budget_error_is_not_a_missing_processor(self):
        noise = random.Random(7).randbytes(384 * 384 * 3)
        data = image_bytes(Image.frombytes("RGB", (384, 384), noise))
        with self.assertRaises(codec.PreparationError) as ctx:
            codec.prepare(data, policy(maxEdge=384, minEdge=384, perFileTarget=65536,
                                       outputFormat="png", acceptedMimes=["image/png"]))
        self.assertEqual(ctx.exception.code, "reference_budget_exceeded")

    def test_cli_entry_wraps_decoder_errors(self):
        stdin = io.TextIOWrapper(io.BytesIO(b"not an image"), encoding="utf-8")
        with patch.object(sys, "stdin", stdin), patch.object(sys, "argv", [str(module_path), __import__("json").dumps(policy())]):
            with self.assertRaises(codec.PreparationError) as ctx:
                codec.main()
        self.assertEqual(ctx.exception.code, "reference_decode_failed")

    @unittest.skipUnless("AVIF" in Image.SAVE, "Pillow AVIF encoder unavailable")
    def test_avif_alpha_is_decoded_and_preserved(self):
        source = image_bytes(Image.new("RGBA", (40, 20), (10, 200, 80, 100)), "AVIF")
        result = codec.prepare(source, policy())
        self.assertTrue(result["source"]["hasAlpha"])
        self.assertTrue(result["output"]["hasAlpha"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
