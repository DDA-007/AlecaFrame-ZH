import json
import os
import sys

os.environ.setdefault("FLAGS_use_mkldnn", "0")

# Node reads this worker's line-delimited JSON as UTF-8.  Windows otherwise
# selects the active console code page, corrupting the Chinese OCR text.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="strict", line_buffering=True)
if hasattr(sys.stdin, "reconfigure"):
    sys.stdin.reconfigure(encoding="utf-8", errors="strict")

from PIL import Image
from PIL import ImageDraw, ImageFont
import numpy as np
from paddleocr import PaddleOCR


def make_box(points):
    xs = [float(point[0]) for point in points]
    ys = [float(point[1]) for point in points]
    return {
        "left": min(xs),
        "top": min(ys),
        "right": max(xs),
        "bottom": max(ys),
        "centerX": (min(xs) + max(xs)) / 2,
    }


def run(ocr, image_path, crop=None):
    with Image.open(image_path) as image:
        image_width, image_height = image.size
        if crop:
            if crop.get("relative"):
                crop = {
                    "left": float(crop.get("left", 0)) * image_width,
                    "top": float(crop.get("top", 0)) * image_height,
                    "right": float(crop.get("right", 1)) * image_width,
                    "bottom": float(crop.get("bottom", 1)) * image_height,
                }
            left = max(0, int(crop.get("left", 0)))
            top = max(0, int(crop.get("top", 0)))
            right = min(image_width, int(crop.get("right", image_width)))
            bottom = min(image_height, int(crop.get("bottom", image_height)))
            if right <= left or bottom <= top:
                raise ValueError("Reward title crop is invalid.")
            image = image.crop((left, top, right, bottom)).resize(
                ((right - left) * 2, (bottom - top) * 2), Image.Resampling.LANCZOS
            )
            result = ocr.ocr(np.array(image.convert("RGB")), cls=True)
            offset_x, offset_y, scale = left, top, 2
        else:
            result = ocr.ocr(image_path, cls=True)
            offset_x, offset_y, scale = 0, 0, 1
    lines = []
    for page in result or []:
        for entry in page or []:
            box, recognition = entry
            text, confidence = recognition
            bounds = make_box([
                ((point[0] / scale) + offset_x, (point[1] / scale) + offset_y)
                for point in box
            ])
            bounds.update({"text": str(text), "confidence": float(confidence)})
            lines.append(bounds)
    return {"success": True, "imageWidth": image_width, "imageHeight": image_height, "lines": lines}


def make_refinement_landmark(image_path, output_path):
    # AlecaFrame's native recommendation window requires this English screen
    # landmark handshake before it resolves its Vue loading state.  Paddle has
    # already identified the Chinese page, so render only those two markers
    # without invoking the slower Windows OCR worker.
    with Image.open(image_path) as source:
        image = source.convert("RGB")
        width, height = image.size
        draw = ImageDraw.Draw(image)
        title_font = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", max(18, min(30, int(height * 0.026))))
        button_font = ImageFont.truetype("C:/Windows/Fonts/segoeuib.ttf", max(16, min(26, int(height * 0.022))))
        title_box = (max(0, int(width * 0.025)), max(0, int(height * 0.025)), int(width * 0.36), int(height * 0.12))
        button_box = (int(width * 0.74), int(height * 0.84), int(width * 0.98), int(height * 0.93))
        draw.rectangle(title_box, fill=(15, 19, 33))
        draw.rectangle(button_box, fill=(15, 19, 33))
        draw.text((title_box[0] + 10, title_box[1] + 8), "VOID RELICS / REFINEMENT", font=title_font, fill="white")
        draw.text((button_box[0] + 10, button_box[1] + 8), "EQUIP FOR MISSION", font=button_font, fill="white")
        image.save(output_path, "PNG")
    return {"success": True, "outputPath": output_path}


def main():
    # The model is initialized once and retained for all reward screenshots.
    ocr = PaddleOCR(lang="ch", use_angle_cls=True, show_log=False, use_mkldnn=False)
    print(json.dumps({"ready": True}), flush=True)

    for raw_request in sys.stdin:
        try:
            request = json.loads(raw_request)
            image_path = request.get("path")
            if not image_path or not os.path.isfile(image_path):
                raise ValueError("Screenshot path is invalid.")
            if request.get("mode") == "refinement-landmark":
                output_path = request.get("outputPath")
                if not output_path:
                    raise ValueError("Refinement landmark output path is invalid.")
                print(json.dumps(make_refinement_landmark(image_path, output_path)), flush=True)
            else:
                print(json.dumps(run(ocr, image_path, request.get("crop")), ensure_ascii=False), flush=True)
        except Exception as error:
            print(json.dumps({"success": False, "reason": str(error)}), flush=True)


if __name__ == "__main__":
    main()
