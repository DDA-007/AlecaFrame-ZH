import json
import os
import sys
import gc
import ctypes

os.environ.setdefault("FLAGS_use_mkldnn", "0")
os.environ.setdefault("OMP_NUM_THREADS", "2")
os.environ.setdefault("MKL_NUM_THREADS", "2")

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


def private_bytes():
    if os.name != "nt":
        return 0
    from ctypes import wintypes
    class Counters(ctypes.Structure):
        _fields_ = [("cb", wintypes.DWORD), ("PageFaultCount", wintypes.DWORD)] + [
            (name, ctypes.c_size_t) for name in ("PeakWorkingSetSize", "WorkingSetSize",
            "QuotaPeakPagedPoolUsage", "QuotaPagedPoolUsage", "QuotaPeakNonPagedPoolUsage",
            "QuotaNonPagedPoolUsage", "PagefileUsage", "PeakPagefileUsage", "PrivateUsage")]
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel.GetCurrentProcess.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(Counters), wintypes.DWORD]
    info = Counters()
    info.cb = ctypes.sizeof(info)
    if psapi.GetProcessMemoryInfo(kernel.GetCurrentProcess(), ctypes.byref(info), info.cb):
        return info.PrivateUsage
    return 0


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
    with Image.open(image_path) as source:
        image_width, image_height = source.size
        if image_width * image_height > 40_000_000:
            raise MemoryError("OCR image exceeds the decoded-image memory budget.")
        left, top, right, bottom = 0, 0, image_width, image_height
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
        width, height = right - left, bottom - top
        scale = min(2.0, 1920 / max(width, height)) if crop else min(1.0, 2560 / max(width, height))
        target = (max(1, round(width * scale)), max(1, round(height * scale)))
        # Close decoded/full-size PIL buffers before Paddle allocates tensors.
        with source.crop((left, top, right, bottom)) as cropped:
            with cropped.resize(target, Image.Resampling.LANCZOS) as resized:
                with resized.convert("RGB") as rgb:
                    pixels = np.array(rgb)
        scale_x, scale_y = target[0] / width, target[1] / height
    try:
        result = ocr.ocr(pixels, cls=True)
    finally:
        del pixels
    lines = []
    for page in result or []:
        for entry in page or []:
            box, recognition = entry
            text, confidence = recognition
            bounds = make_box([
                ((point[0] / scale_x) + left, (point[1] / scale_y) + top)
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
    try:
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
    finally:
        image.close()
    return {"success": True, "outputPath": output_path}


def main():
    # Retain one warm model; the parent restarts it only on faults or pressure.
    ocr = PaddleOCR(lang="ch", use_angle_cls=True, show_log=False, use_mkldnn=False,
                   enable_mkldnn=False, cpu_threads=2, rec_batch_num=2, cls_batch_num=2)
    print(json.dumps({"ready": True, "privateBytes": private_bytes()}), flush=True)

    for raw_request in sys.stdin:
        request_id = None
        try:
            request = json.loads(raw_request)
            request_id = request.get("id")
            image_path = request.get("path")
            if not image_path or not os.path.isfile(image_path):
                raise ValueError("Screenshot path is invalid.")
            if request.get("mode") == "refinement-landmark":
                output_path = request.get("outputPath")
                if not output_path:
                    raise ValueError("Refinement landmark output path is invalid.")
                response = make_refinement_landmark(image_path, output_path)
            else:
                response = run(ocr, image_path, request.get("crop"))
        except Exception as error:
            response = {"success": False, "reason": str(error)}
            if isinstance(error, MemoryError) or any(token in str(error).lower() for token in
                    ("out of memory", "bad_alloc", "resourceexhausted")):
                response["resourceLimited"] = True
        gc.collect()
        response.update(id=request_id, privateBytes=private_bytes())
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
