import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

const autoIterateState = new Map();

// --- The key fix: capture the EXACT prompt payload at queue time ---
let savedPromptBody = null;
let isAutoIterating = false;

// Intercept fetch to capture the prompt JSON when first queued
const originalFetch = window.fetch;
window.fetch = async function(url, options) {
    // Only intercept POST /prompt and only if we're NOT already auto-iterating
    // (auto-iterate sends its own saved body, don't re-capture that)
    if (!isAutoIterating && typeof url === "string" && url.endsWith("/prompt") &&
        options?.method === "POST" && options?.body) {
        try {
            const body = JSON.parse(options.body);
            if (body.prompt) {
                // Check if any node in this prompt is a BatchFolderLoader with auto_iterate
                for (const nodeId of Object.keys(body.prompt)) {
                    const nodeData = body.prompt[nodeId];
                    if (nodeData.class_type === "BatchFolderLoader" &&
                        nodeData.inputs?.auto_iterate === "enable") {
                        // Save the entire POST body for replay
                        savedPromptBody = options.body;
                        break;
                    }
                }
            }
        } catch (e) { /* ignore parse errors */ }
    }
    return originalFetch.apply(this, arguments);
};

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

// Auto-queue: replay the SAVED prompt, not the current UI
api.addEventListener("executed", async ({ detail }) => {
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

    if (isLast) {
        savedPromptBody = null;
        isAutoIterating = false;
        if (state.statusWidget) {
            state.statusWidget.value = `Done — ${totalImages} images processed`;
            state.node?.setDirtyCanvas?.(true);
        }
        return;
    }

    // Re-queue using the EXACT saved prompt
    if (savedPromptBody) {
        setTimeout(async () => {
            try {
                isAutoIterating = true;
                await originalFetch("/prompt", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: savedPromptBody,
                });
            } catch (e) {
                console.error("[BatchFolderLoader] Re-queue failed:", e);
                isAutoIterating = false;
            }
        }, 300);
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

        // --- Upload with sync ---
        async function syncAndUpload(files, subfolder) {
            const exts = new Set([".png",".jpg",".jpeg",".bmp",".gif",".tiff",".tif",".webp"]);
            const imgs = files.filter(f => exts.has(f.name.substring(f.name.lastIndexOf(".")).toLowerCase()));
            if (!imgs.length) {
                statusWidget.value = "No image files found in folder";
                node.setDirtyCanvas(true);
                return;
            }

            statusWidget.value = "Syncing...";
            node.setDirtyCanvas(true);
            try {
                await originalFetch("/batch_folder_loader/clear", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ subfolder }),
                });
            } catch (e) { console.error("[BatchFolderLoader] Clear failed:", e); }

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
                    const r = await originalFetch("/upload/image", { method: "POST", body: fd });
                    if (r.ok) ok++;
                } catch (e) { console.error("[BatchFolderLoader]", e); }
            }

            // Reset for fresh capture on next Queue
            savedPromptBody = null;
            isAutoIterating = false;

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

                const relPath = files[0].webkitRelativePath || "";
                const rawFolderName = relPath.split("/")[0] || "batch";
                const browserId = getBrowserId();
                const subfolder = `${browserId}/${rawFolderName}`;

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
