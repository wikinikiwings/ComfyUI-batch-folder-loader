<img width="859" height="570" alt="image" src="https://github.com/user-attachments/assets/638e43c1-60db-4c23-bf98-5c280d658fbf" />

A simple node that allows you to upload images from a local folder to comfyui running on a remote PC (runpod or PC on a local network) and send them iteratively to the process one by one, without creating a batch. Each image will be submitted to the workflow as a separate task. The node is intended for very niche use cases

<img width="551" height="381" alt="image" src="https://github.com/user-attachments/assets/a18f839c-571f-49b0-8509-63d6601fa7f5" />

also added isolated que trigger node. known issue - do not connect it to "show any" native node - it will brake history
if this happened you can reset comfy history by pressing f12 and pasting in console:
/n`fetch('/history', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({clear: true}) })`

If you want to be more selective (delete only one broken job instead of everything), you can delete by prompt ID:
`javascriptfetch('/history', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({delete: ["prompt_id_here"]}) })`
You can find prompt IDs by visiting http://192.168.2.67:5070/history in a new tab — it shows all jobs as JSON.
