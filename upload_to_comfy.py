"""
upload_to_comfy.py - Local companion script for BatchFolderLoader
-----------------------------------------------------------------
Run this on your LOCAL PC to upload images from a local folder
to the remote ComfyUI server's input directory.

Usage:
    python upload_to_comfy.py  E:\\test\\test2  --server http://REMOTE_IP:8188

This will:
  1. Scan E:\\test\\test2 for images
  2. Upload each image to ComfyUI's input/<folder_name>/ via the /upload/image API
     (in this example, folder_name = "test2")
  3. The BatchFolderLoader node can then iterate through them

Requirements:
    pip install requests
"""

import os
import sys
import argparse
import requests

SUPPORTED_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.bmp', '.gif', '.tiff', '.tif', '.webp'}


def get_image_files(folder_path):
    """Return sorted list of image filenames in the given folder."""
    files = []
    for f in sorted(os.listdir(folder_path)):
        if os.path.splitext(f)[1].lower() in SUPPORTED_EXTENSIONS:
            files.append(f)
    return files


def upload_images(local_folder, server_url, subfolder=None, overwrite=True):
    """
    Upload all images from local_folder to ComfyUI server's input directory.

    Args:
        local_folder: Path to local folder with images
        server_url:   ComfyUI server URL (e.g. http://192.168.1.100:8188)
        subfolder:    Subfolder name in ComfyUI's input/ dir. 
                      If None, uses the last folder name from local_folder.
        overwrite:    Whether to overwrite existing files
    """
    local_folder = os.path.abspath(local_folder)

    if not os.path.isdir(local_folder):
        print(f"ERROR: Folder not found: {local_folder}")
        sys.exit(1)

    # Extract subfolder name from path if not provided
    if subfolder is None:
        subfolder = os.path.basename(local_folder.rstrip('/\\'))
        if not subfolder:
            print("ERROR: Could not extract folder name from path.")
            sys.exit(1)

    image_files = get_image_files(local_folder)
    if not image_files:
        print(f"No supported images found in: {local_folder}")
        print(f"Supported formats: {', '.join(sorted(SUPPORTED_EXTENSIONS))}")
        sys.exit(1)

    upload_url = f"{server_url.rstrip('/')}/upload/image"
    print(f"Uploading {len(image_files)} image(s) to {upload_url}")
    print(f"  Subfolder: {subfolder}")
    print(f"  Overwrite: {overwrite}")
    print()

    success_count = 0
    fail_count = 0

    for i, filename in enumerate(image_files, 1):
        filepath = os.path.join(local_folder, filename)
        file_size = os.path.getsize(filepath)
        size_str = f"{file_size / 1024:.1f} KB" if file_size < 1024 * 1024 else f"{file_size / (1024*1024):.1f} MB"

        try:
            with open(filepath, 'rb') as f:
                # ComfyUI expects multipart form with field name "image"
                files = {
                    'image': (filename, f, 'image/png'),
                }
                data = {
                    'subfolder': subfolder,
                    'type': 'input',
                    'overwrite': 'true' if overwrite else 'false',
                }
                response = requests.post(upload_url, files=files, data=data, timeout=60)

            if response.status_code == 200:
                result = response.json()
                print(f"  [{i}/{len(image_files)}] OK  {filename} ({size_str})")
                success_count += 1
            else:
                print(f"  [{i}/{len(image_files)}] FAIL {filename} - HTTP {response.status_code}: {response.text}")
                fail_count += 1

        except requests.exceptions.ConnectionError:
            print(f"  [{i}/{len(image_files)}] FAIL {filename} - Cannot connect to {server_url}")
            print(f"\n  Is ComfyUI running? Check the server URL.")
            fail_count += 1
            break
        except Exception as e:
            print(f"  [{i}/{len(image_files)}] FAIL {filename} - {e}")
            fail_count += 1

    print(f"\nDone: {success_count} uploaded, {fail_count} failed")
    print(f"\nIn the BatchFolderLoader node, set folder_path to: {subfolder}")


def main():
    parser = argparse.ArgumentParser(
        description="Upload images from a local folder to a remote ComfyUI server.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  python upload_to_comfy.py  E:\\test\\test2  --server http://192.168.1.100:8188
  python upload_to_comfy.py  ./my_photos     --server http://DESKTOP-9QLQFG1:8188
  python upload_to_comfy.py  E:\\test\\test2  --server http://192.168.1.100:8188 --subfolder my_custom_name
        """
    )
    parser.add_argument('folder', help='Local folder containing images to upload')
    parser.add_argument('--server', '-s', default='http://127.0.0.1:8188',
                        help='ComfyUI server URL (default: http://127.0.0.1:8188)')
    parser.add_argument('--subfolder', '-f', default=None,
                        help='Subfolder name in ComfyUI input/ (default: last folder name from path)')
    parser.add_argument('--no-overwrite', action='store_true',
                        help='Do not overwrite existing files')

    args = parser.parse_args()
    upload_images(args.folder, args.server, args.subfolder, not args.no_overwrite)


if __name__ == '__main__':
    main()
