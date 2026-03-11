import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// nodeId (string) → { enabled, node, statusWidget }
const nodeState = new Map();

// Prevent overlapping re-queues: tracks which node is mid-iteration
const iterating = new Set();

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

// --- Re-queue using the live graph (no saved-body fragility) ---
async function reQueue() {
    try {
        const p = await app.graphToPrompt();
        await api.queuePrompt(0, p);
    } catch (e) {
        console.error("[BatchFolderLoader] Re-queue failed:", e);
    }
}

// --- Handle executed events ---
api.addEventListener("executed", async ({ detail }) => {
    const nodeId = String(detail?.node ?? "");
    if (!nodeId) return;

    const state = nodeState.get(nodeId);
    if (!state?.enabled) return;

    const output = detail?.output;
    if (!output) return;

    const isLast      = !!output.is_last?.[0];
    const currentIdx  = output.current_index?.[0] ?? 0;
    const totalImages = output.total_images?.[0] ?? 0;
    const filename    = output.filename?.[0] ?? "";

    // Update status label
    if (state.statusWidget) {
        state.statusWidget.value = isLast
            ? `Done — ${totalImages} images processed`
            : `[${currentIdx + 1}/${totalImages}] ${filename}`;
        state.node?.setDirtyCanvas?.(true);
    }

    if (isLast) {
        iterating.delete(nodeId);
        return;
    }

    // Guard against double-fire
    if (iterating.has(nodeId)) return;
    iterating.add(nodeId);

    setTimeout(async () => {
        await reQueue();
        // Keep nodeId in iterating until the NEXT executed event clears/re-adds it
        iterating.delete(nodeId);
    }, 150);
});

app.registerExtension({
    name: "BatchFolderLoader",

    async nodeCreated(node) {
        if (node.comfyClass !== "BatchFolderLoader") return;

        const subfolderWidget   = node.widgets?.find(w => w.name === "subfolder");
        const autoIterateWidget = node.widgets?.find(w => w.name === "auto_iterate");

        // Hide the raw subfolder widget — managed internally
        if (subfolderWidget) {
            subfolderWidget.type = "hidden";
            subfolderWidget.computeSize = () => [0, -4];
        }

        // Status display widget
        const statusWidget = node.addWidget("text", "status", "Click 'Upload Folder' to begin", () => {}, {
            serialize: false,
        });

        const syncState = () => {
            nodeState.set(String(node.id), {
                enabled: autoIterateWidget?.value === "enable",
                node,
                statusWidget,
            });
        };
        syncState();

        if (autoIterateWidget) {
            const orig = autoIterateWidget.callback;
            autoIterateWidget.callback = (...args) => { orig?.(...args); syncState(); };
        }

        node.onConfigure = () => syncState();

        // --- Upload + sync to server ---
        async function syncAndUpload(files, subfolder) {
            const exts = new Set([".png",".jpg",".jpeg",".bmp",".gif",".tiff",".tif",".webp"]);
            const imgs = files.filter(f => exts.has(f.name.substring(f.name.lastIndexOf(".")).toLowerCase()));
            if (!imgs.length) {
                statusWidget.value = "No image files found in folder";
                node.setDirtyCanvas(true);
                return;
            }

            statusWidget.value = "Clearing old files...";
            node.setDirtyCanvas(true);

            // 1. Clear existing files in the subfolder
            try {
                await fetch("/batch_folder_loader/clear", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ subfolder }),
                });
            } catch (e) { console.error("[BatchFolderLoader] Clear failed:", e); }

            // 2. Reset Python iteration index so first Queue always starts at image 0
            try {
                await fetch("/batch_folder_loader/reset_index", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ subfolder }),
                });
            } catch (e) { console.error("[BatchFolderLoader] Index reset failed:", e); }

            // 3. Upload images one by one
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
                } catch (e) { console.error("[BatchFolderLoader]", e); }
            }

            // Clear any in-progress iteration state
            iterating.delete(String(node.id));

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

                const relPath      = files[0].webkitRelativePath || "";
                const rawFolderName = relPath.split("/")[0] || "batch";
                const browserId    = getBrowserId();
                const subfolder    = `${browserId}/${rawFolderName}`;

                if (subfolderWidget) subfolderWidget.value = subfolder;
                syncAndUpload(files, subfolder);
            };
            input.click();
        });

        node.size[0] = Math.max(node.size[0], 300);
        node.size[1] = Math.max(node.size[1], 180);
    },
});
