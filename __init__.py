"""
Batch Folder Image Loader - ComfyUI Custom Node
Loads images one-by-one from a subfolder in ComfyUI's input directory.
Includes browser-based upload buttons for pushing images from your local PC.
"""

from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

# Tell ComfyUI to load our frontend JS extension
WEB_DIRECTORY = "./js"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
