import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

// === Workflow-isolated queue trigger ===
// Identifies trigger executions by output shape (count + total + is_last),
// not by node ID — because litegraph IDs don't match prompt IDs.

let _iqt_promptId = null;
let _iqt_savedPrompt = null;

api.addEventListener("execution_start", ({ detail }) => {
    if (detail?.prompt_id) {
        _iqt_promptId = detail.prompt_id;
    }
});

api.addEventListener("executed", async ({ detail }) => {
    try {
        const nodeId = detail?.node;
        if (!nodeId) return;

        const output = detail?.output;
        if (!output) return;

        // Identify our node by its unique output shape
        if (output.count === undefined || output.total === undefined || output.is_last === undefined) return;

        const isLast = output.is_last?.[0];
        const cnt = output.count?.[0] ?? 0;
        const tot = output.total?.[0] ?? 0;

        // Update status widget if visible
        try {
            const node = app.graph?.getNodeById(Number(nodeId));
            if (node) {
                const sw = node.widgets?.find(w => w.name === "_iqt_status");
                if (sw) {
                    sw.value = isLast ? `Done — ${tot} runs completed` : `[${cnt + 1}/${tot}]`;
                    node.setDirtyCanvas(true);
                }
            }
        } catch (e) { /* widget update is optional — workflow might be switched */ }

        if (isLast) {
            _iqt_savedPrompt = null;
            _iqt_promptId = null;
            return;
        }

        // Capture prompt from history on first iteration
        if (!_iqt_savedPrompt && _iqt_promptId) {
            try {
                const resp = await fetch(`/history/${_iqt_promptId}`);
                if (resp.ok) {
                    const data = await resp.json();
                    const entry = data[_iqt_promptId];
                    if (entry?.prompt) {
                        _iqt_savedPrompt = JSON.stringify({
                            prompt: entry.prompt[2],
                            extra_data: entry.prompt[3],
                            client_id: api.clientId,
                        });
                    }
                }
            } catch (e) {
                console.error("[IsolatedQueueTrigger] Capture failed:", e);
            }
        }

        // Re-queue: replay saved prompt (Python handles counting)
        setTimeout(async () => {
            try {
                if (_iqt_savedPrompt) {
                    await fetch("/prompt", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: _iqt_savedPrompt,
                    });
                } else {
                    app.queuePrompt(0, 1);
                }
            } catch (e) {
                console.error("[IsolatedQueueTrigger] Re-queue failed:", e);
            }
        }, 300);

    } catch (e) {
        console.error("[IsolatedQueueTrigger]", e);
    }
});

app.registerExtension({
    name: "IsolatedQueueTrigger",
    async nodeCreated(node) {
        if (node.comfyClass !== "IsolatedQueueTrigger") return;

        node.addWidget("text", "_iqt_status", "Ready", () => {}, { serialize: false });
        node.size[0] = Math.max(node.size[0], 250);
    },
});
