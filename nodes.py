"""
ComfyUI Queue Tools
- BatchFolderLoader: Upload & iterate through image folders
- IsolatedQueueTrigger: Trigger the queue N times with workflow isolation
"""

import os
import hashlib
import logging
import time
import shutil

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths
from server import PromptServer
from aiohttp import web

logger = logging.getLogger(__name__)

SUPPORTED_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.tif', '.webp'}


def get_image_files(folder_path):
    if not os.path.isdir(folder_path):
        return []
    return [f for f in sorted(os.listdir(folder_path))
            if os.path.splitext(f)[1].lower() in SUPPORTED_EXTENSIONS]


# --- API: reset the iteration index for a subfolder ---
@PromptServer.instance.routes.post("/batch_folder_loader/reset_index")
async def reset_index(request):
    data = await request.json()
    subfolder = data.get("subfolder", "")
    input_dir = folder_paths.get_input_directory()
    target = os.path.join(input_dir, subfolder)
    folder_key = os.path.normpath(target)
    BatchFolderLoader._current_index.pop(folder_key, None)
    return web.json_response({"reset": True})


# --- API: clear a subfolder before re-upload (mirrors deletions) ---
@PromptServer.instance.routes.post("/batch_folder_loader/clear")
async def clear_subfolder(request):
    data = await request.json()
    subfolder = data.get("subfolder", "")

    if not subfolder or ".." in subfolder:
        return web.json_response({"error": "Invalid subfolder"}, status=400)

    input_dir = folder_paths.get_input_directory()
    target = os.path.join(input_dir, subfolder)

    if os.path.commonpath((input_dir, os.path.abspath(target))) != input_dir:
        return web.json_response({"error": "Invalid path"}, status=403)

    removed = 0
    if os.path.isdir(target):
        for f in os.listdir(target):
            fp = os.path.join(target, f)
            if os.path.isfile(fp):
                os.remove(fp)
                removed += 1

    return web.json_response({"removed": removed})


# --- API: list images in a subfolder ---
@PromptServer.instance.routes.get("/batch_folder_loader/info/{subfolder:.*}")
async def subfolder_info(request):
    subfolder = request.match_info.get("subfolder", "")
    input_dir = folder_paths.get_input_directory()
    target = os.path.join(input_dir, subfolder)
    if not os.path.isdir(target):
        return web.json_response({"count": 0, "files": []})
    files = get_image_files(target)
    return web.json_response({"count": len(files), "files": files})


# ==============================================================
# BatchFolderLoader
# ==============================================================
class BatchFolderLoader:

    _current_index = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "subfolder": ("STRING", {
                    "default": "batch",
                    "multiline": False,
                }),
                "auto_iterate": (["enable", "disable"], {
                    "default": "enable",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "INT", "INT")
    RETURN_NAMES = ("image", "mask", "filename", "current_index", "total_images")
    FUNCTION = "load_image"
    CATEGORY = "image"
    OUTPUT_NODE = True
    DESCRIPTION = "Upload a folder of images, then iterate through them automatically."

    @classmethod
    def IS_CHANGED(cls, subfolder, auto_iterate="enable"):
        return time.time()

    def load_image(self, subfolder, auto_iterate="enable"):
        subfolder = subfolder.strip().strip('"').strip("'")
        subfolder = subfolder.replace("..", "").strip("/").strip("\\")
        if not subfolder:
            subfolder = "batch"

        input_dir = folder_paths.get_input_directory()
        target_folder = os.path.join(input_dir, subfolder)

        if os.path.commonpath((input_dir, os.path.abspath(target_folder))) != input_dir:
            raise ValueError("[BatchFolderLoader] Invalid subfolder path.")

        if not os.path.isdir(target_folder):
            os.makedirs(target_folder, exist_ok=True)

        image_files = get_image_files(target_folder)
        if not image_files:
            raise ValueError(
                f"[BatchFolderLoader] No images found.\n"
                f"Click 'Upload Folder' on the node to add images."
            )

        total_images = len(image_files)
        folder_key = os.path.normpath(target_folder)

        if folder_key not in BatchFolderLoader._current_index:
            BatchFolderLoader._current_index[folder_key] = 0
        current_idx = BatchFolderLoader._current_index[folder_key]

        if current_idx >= total_images:
            current_idx = 0

        image_name = image_files[current_idx]
        image_path = os.path.join(target_folder, image_name)
        logger.info(f"[BatchFolderLoader] [{current_idx + 1}/{total_images}] {image_name}")

        img = Image.open(image_path)
        img = ImageOps.exif_transpose(img)

        if img.mode == 'I':
            img = img.point(lambda i: i * (1 / 255))
        image = img.convert("RGB")
        image = np.array(image).astype(np.float32) / 255.0
        image = torch.from_numpy(image)[None,]

        if 'A' in img.getbands():
            mask = np.array(img.getchannel('A')).astype(np.float32) / 255.0
            mask = 1.0 - torch.from_numpy(mask)
        else:
            mask = torch.zeros((image.shape[1], image.shape[2]), dtype=torch.float32)

        is_last = (current_idx + 1) >= total_images
        BatchFolderLoader._current_index[folder_key] = current_idx + 1

        return {
            "ui": {
                "images": [],
                "current_index": [current_idx],
                "total_images": [total_images],
                "filename": [image_name],
                "is_last": [is_last],
            },
            "result": (image, mask, image_name, current_idx, total_images),
        }


# ==============================================================
# IsolatedQueueTrigger
# ==============================================================
class IsolatedQueueTrigger:

    _counters = {}

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "total": ("INT", {
                    "default": 10,
                    "min": 1,
                    "max": 99999,
                    "step": 1,
                }),
            },
            "optional": {
                "signal": ("*",),
            },
            "hidden": {
                "unique_id": "UNIQUE_ID",
            },
        }

    RETURN_TYPES = ("*", "INT", "INT")
    RETURN_NAMES = ("signal_opt", "count", "total")
    FUNCTION = "trigger"
    CATEGORY = "utils"
    OUTPUT_NODE = True
    DESCRIPTION = "Triggers the queue N times with workflow isolation."

    @classmethod
    def IS_CHANGED(cls, total=10, signal=None, unique_id=None):
        return time.time()

    def trigger(self, total=10, signal=None, unique_id=None):
        key = str(unique_id) if unique_id else "default"

        if key not in IsolatedQueueTrigger._counters:
            IsolatedQueueTrigger._counters[key] = 0

        count = IsolatedQueueTrigger._counters[key]

        if count >= total:
            count = 0
            IsolatedQueueTrigger._counters[key] = 0

        current = count
        is_last = (current + 1) >= total
        IsolatedQueueTrigger._counters[key] = current + 1

        logger.info(f"[IsolatedQueueTrigger] [{current + 1}/{total}]")

        return {
            "ui": {
                "images": [],
                "count": [current],
                "total": [total],
                "is_last": [is_last],
            },
            "result": (signal, current, total),
        }


# ==============================================================
# Registration
# ==============================================================
NODE_CLASS_MAPPINGS = {
    "BatchFolderLoader": BatchFolderLoader,
    "IsolatedQueueTrigger": IsolatedQueueTrigger,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "BatchFolderLoader": "Batch Folder Image Loader",
    "IsolatedQueueTrigger": "Isolated Queue Trigger",
}
