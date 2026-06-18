import os
import json
import time
import uuid
import base64
import asyncio
import threading
import queue as queue_mod
import gradio as gr
from fastapi import Request
from fastapi.responses import StreamingResponse, JSONResponse
from huggingface_hub import hf_hub_download
from llama_cpp import Llama
from llama_cpp.llama_chat_format import Llava15ChatHandler

MODEL_REPO   = "ggml-org/GLM-OCR-GGUF"
MODEL_FILE   = "GLM-OCR-Q8_0.gguf"
MMPROJ_FILE  = "mmproj-GLM-OCR-Q8_0.gguf"
MODEL_PATH   = "/tmp/vision-model.gguf"
MMPROJ_PATH  = "/tmp/vision-mmproj.gguf"

SYSTEM_PROMPT = (
    "You are Axion Vision, a visual assistant by Axion Labs. "
    "You can read text in images, describe scenes, analyse diagrams, and answer questions about images. "
    "Be concise and accurate."
)

llm        = None
infer_lock = threading.Lock()


# ── Model loading ─────────────────────────────────────────────────────────────

def _load_model():
    global llm

    if not os.path.exists(MODEL_PATH):
        print("Downloading vision model…")
        hf_hub_download(repo_id=MODEL_REPO, filename=MODEL_FILE, local_dir="/tmp")
        os.rename(f"/tmp/{MODEL_FILE}", MODEL_PATH)

    if not os.path.exists(MMPROJ_PATH):
        print("Downloading vision projector…")
        hf_hub_download(repo_id=MODEL_REPO, filename=MMPROJ_FILE, local_dir="/tmp")
        os.rename(f"/tmp/{MMPROJ_FILE}", MMPROJ_PATH)

    print("Loading vision model…")
    chat_handler = Llava15ChatHandler(clip_model_path=MMPROJ_PATH, verbose=False)
    llm = Llama(
        model_path=MODEL_PATH,
        chat_handler=chat_handler,
        n_ctx=4096,
        n_threads=2,
        verbose=False,
    )
    print("Vision model ready.")


# Start loading immediately at module load (background thread)
threading.Thread(target=_load_model, daemon=True).start()


# ── Gradio helpers ────────────────────────────────────────────────────────────

def model_status():
    if llm is not None:
        return "<p style='color:#6aa87a;font-size:0.85em;font-weight:500;margin:0 0 10px'>● Model ready</p>"
    return "<p style='color:#c9994a;font-size:0.85em;font-weight:500;margin:0 0 10px'>● Loading model… (first boot takes a few minutes)</p>"


def analyze_image(image, question, max_tokens):
    if llm is None:
        yield "Model is still loading — please wait a moment."
        return
    if image is None:
        yield "Please upload an image."
        return

    import io
    buf = io.BytesIO()
    image.convert("RGB").save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    data_url = f"data:image/png;base64,{b64}"

    prompt = question.strip() or "Describe this image in detail. If there is any text, read it exactly."

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
                {"type": "text",      "text": prompt},
            ],
        },
    ]

    response = ""
    with infer_lock:
        for chunk in llm.create_chat_completion(
            messages=messages,
            max_tokens=int(max_tokens),
            temperature=0.3,
            stream=True,
        ):
            delta     = chunk["choices"][0]["delta"].get("content", "")
            response += delta
            yield response


# ── Gradio UI ─────────────────────────────────────────────────────────────────

with gr.Blocks(title="Axion Vision — Axion Labs") as demo:

    gr.HTML("""
        <div style="padding:24px 0 8px;border-bottom:1px solid #2e2218;margin-bottom:16px">
            <h1 style="font-size:1.6em;font-weight:700;margin:0 0 2px;color:#e8ddd0">
                ⚛ Axion <span style="color:#cc785c">Vision</span>
            </h1>
            <p style="color:#7a6050;margin:0;font-size:0.85em">
                Image understanding &amp; OCR · powered by GLM-OCR · by Axion Labs · free
            </p>
        </div>
    """)

    status_html = gr.HTML(model_status)

    with gr.Row():
        with gr.Column(scale=1):
            image_input = gr.Image(label="Image", type="pil")
            question    = gr.Textbox(
                placeholder="What does this say? / Describe this image / What error is shown?…",
                label="Question (optional)",
                lines=2,
            )
            max_tokens  = gr.Slider(64, 1024, value=512, step=64, label="Max tokens")
            submit_btn  = gr.Button("Analyse", variant="primary")

        with gr.Column(scale=1):
            output = gr.Textbox(label="Response", lines=16)

    gr.HTML("""
        <div style="color:#4a3828;font-size:0.75em;text-align:center;padding:14px 0;border-top:1px solid #2e2218;margin-top:12px">
            OpenAI-compatible API: <code style="background:#1c1510;padding:1px 5px;border-radius:4px;color:#7a6050">POST /v1/chat/completions</code>
            &nbsp;·&nbsp; send images as <code style="background:#1c1510;padding:1px 5px;border-radius:4px;color:#7a6050">image_url</code> content blocks (base64 data URLs)
        </div>
    """)

    submit_btn.click(analyze_image, [image_input, question, max_tokens], output)
    question.submit(analyze_image,  [image_input, question, max_tokens], output)

    demo.load(model_status, outputs=status_html)


# ── API routes via Gradio's FastAPI app ───────────────────────────────────────

demo.queue()


@demo.app.get("/health")
def health():
    return {"status": "ready" if llm is not None else "loading"}


@demo.app.post("/v1/chat/completions")
async def chat_completions(request: Request):
    if llm is None:
        return JSONResponse({"error": "Model is still loading, try again in a moment."}, status_code=503)

    body        = await request.json()
    messages    = body.get("messages", [])
    max_tokens  = int(body.get("max_tokens", 512))
    temperature = float(body.get("temperature", 0.3))
    stream      = body.get("stream", False)
    model_id    = body.get("model", "axion-vision")

    if not any(m.get("role") == "system" for m in messages):
        messages = [{"role": "system", "content": SYSTEM_PROMPT}] + messages

    if stream:
        async def event_stream():
            resp_id = "chatcmpl-" + uuid.uuid4().hex
            created = int(time.time())
            q    = queue_mod.Queue(maxsize=64)
            DONE = object()

            def produce():
                try:
                    with infer_lock:
                        for chunk in llm.create_chat_completion(
                            messages=messages,
                            max_tokens=max_tokens,
                            temperature=temperature,
                            stream=True,
                        ):
                            q.put(chunk)
                except Exception as e:
                    q.put(e)
                finally:
                    q.put(DONE)

            threading.Thread(target=produce, daemon=True).start()
            while True:
                chunk = await asyncio.to_thread(q.get)
                if chunk is DONE:
                    break
                if isinstance(chunk, Exception):
                    yield f"data: {json.dumps({'error': str(chunk)})}\n\n"
                    break
                delta  = chunk["choices"][0]["delta"]
                finish = chunk["choices"][0].get("finish_reason")
                data   = {
                    "id": resp_id,
                    "object": "chat.completion.chunk",
                    "created": created,
                    "model": model_id,
                    "choices": [{"index": 0, "delta": delta, "finish_reason": finish}],
                }
                yield f"data: {json.dumps(data)}\n\n"
            yield "data: [DONE]\n\n"

        return StreamingResponse(event_stream(), media_type="text/event-stream")

    def generate():
        with infer_lock:
            return llm.create_chat_completion(
                messages=messages,
                max_tokens=max_tokens,
                temperature=temperature,
                stream=False,
            )

    result = await asyncio.to_thread(generate)
    return JSONResponse(result)


demo.launch(server_name="0.0.0.0", server_port=7860)
