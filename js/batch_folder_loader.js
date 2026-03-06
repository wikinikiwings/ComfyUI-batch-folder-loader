import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const autoIterateState = new Map();

// --- Persistent browser ID ---
function getBrowserId() {
    const key = "batch_folder_loader_browser_id";
    let id = localStorage.getItem(key);
    if (!id) {
        const arr = new Uint8Array(3);
        crypto.getRandomValues(arr);
        id = Array.from(arr, b => b.toString(16).padStart(2, "0")).join("");
        localStorage.setItem(key, id);
    }
    return id;
}

// Auto-queue next image when execution completes
api.addEventListener("executed", ({ detail }) => {
    const nodeId = detail?.node;
    if (!nodeId) return;

    const state = autoIterateState.get(String(nodeId));
    if (!state || !state.enabled) return;

    const output = detail?.output;
    if (!output) return;

    const isLast = output.is_last?.[0];
    const currentIdx = output.current_index?.[0] ?? 0;
    const totalImages = output.total_images?.[0] ?? 0;
    const filename = output.filename?.[0] ?? "";

    if (state.statusWidget) {
        state.statusWidget.value = `[${currentIdx + 1}/${totalImages}] ${filename}`;
        state.node?.setDirtyCanvas?.(true);
    }

    if (!isLast) {
        setTimeout(() => app.queuePrompt(0, 1), 300);
    } else if (state.statusWidget) {
        state.statusWidget.value = `Done — ${totalImages} images processed`;
        state.node?.setDirtyCanvas?.(true);
    }
});

app.registerExtension({
    name: "BatchFolderLoader",

    async nodeCreated(node) {
        if (node.comfyClass !== "BatchFolderLoader") return;

        const subfolderWidget = node.widgets?.find(w => w.name === "subfolder");
        const autoIterateWidget = node.widgets?.find(w => w.name === "auto_iterate");

        // Hide the subfolder widget
        if (subfolderWidget) {
            subfolderWidget.type = "hidden";
            subfolderWidget.computeSize = () => [0, -4];
        }

        // Status display
        const statusWidget = node.addWidget("text", "status", "Click 'Upload Folder' to begin", () => {}, {
            serialize: false,
        });

        // Auto-iterate tracking
        const updateState = () => {
            autoIterateState.set(String(node.id), {
                enabled: autoIterateWidget?.value === "enable",
                node,
                statusWidget,
            });
        };
        updateState();

        if (autoIterateWidget) {
            const orig = autoIterateWidget.callback;
            autoIterateWidget.callback = (...args) => { orig?.(...args); updateState(); };
        }

        node.onConfigure = function(info) { updateState(); };

        // --- Core upload with full sync ---
        async function syncAndUpload(files, subfolder) {
            const exts = new Set([".png",".jpg",".jpeg",".bmp",".gif",".tiff",".tif",".webp"]);
            const imgs = files.filter(f => exts.has(f.name.substring(f.name.lastIndexOf(".")).toLowerCase()));
            if (!imgs.length) {
                statusWidget.value = "No image files found in folder";
                node.setDirtyCanvas(true);
                return;
            }

            // Step 1: Clear the remote subfolder (mirrors deletions)
            statusWidget.value = "Syncing — clearing old files...";
            node.setDirtyCanvas(true);
            try {
                await fetch("/batch_folder_loader/clear", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ subfolder }),
                });
            } catch (e) {
                console.error("[BatchFolderLoader] Clear failed:", e);
            }

            // Step 2: Upload all current files
            let ok = 0;
            for (let i = 0; i < imgs.length; i++) {
                statusWidget.value = `Uploading ${i + 1}/${imgs.length}...`;
                node.setDirtyCanvas(true);
                try {
                    const fd = new FormData();
                    fd.append("image", imgs[i], imgs[i].name);
                    fd.append("subfolder", subfolder);
                    fd.append("type", "input");
                    fd.append("overwrite", "true");
                    const r = await fetch("/upload/image", { method: "POST", body: fd });
                    if (r.ok) ok++;
                } catch (e) {
                    console.error("[BatchFolderLoader]", e);
                }
            }

            statusWidget.value = `${ok} images ready — press Queue to start`;
            node.setDirtyCanvas(true);
        }

        // --- Upload Folder button ---
        node.addWidget("button", "upload_folder", "Upload Folder", () => {
            const input = document.createElement("input");
            input.type = "file";
            input.multiple = true;
            input.webkitdirectory = true;

            input.onchange = () => {
                const files = Array.from(input.files);
                if (!files.length) return;

                // Extract folder name from webkitRelativePath
                const relPath = files[0].webkitRelativePath || "";
                const rawFolderName = relPath.split("/")[0] || "batch";

                // Structure: browserId/folderName
                const browserId = getBrowserId();
                const subfolder = `${browserId}/${rawFolderName}`;

                // Set the hidden widget
                if (subfolderWidget) {
                    subfolderWidget.value = subfolder;
                }

                syncAndUpload(files, subfolder);
            };
            input.click();
        });

        node.size[0] = Math.max(node.size[0], 300);
        node.size[1] = Math.max(node.size[1], 180);
    },
});
