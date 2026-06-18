import os
import json
import time
import uuid
import base64
import asyncio
import threading
import queue as queue_mod
import gradio as gr
from fastapi import FastAPI, Request
from fastapi.responses import StreamingResponse, JSONResponse
from huggingface_hub import hf_hub_download
from llama_cpp import Llama

MODEL_REPO   = "ggml-org/Qwen2.5-VL-3B-Instruct-GGUF"
MODEL_FILE   = "Qwen2.5-VL-3B-Instruct-Q4_K_M.gguf"
MMPROJ_FILE  = "Qwen2.5-VL-3B-Instruct-mmproj-f16.gguf"
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
    llm = Llama(
        model_path=MODEL_PATH,
        clip_model_path=MMPROJ_PATH,
        n_ctx=4096,
        n_threads=2,
        verbose=False,
    )
    print("Vision model ready.")


# ── FastAPI ───────────────────────────────────────────────────────────────────

fastapi_app = FastAPI()


@fastapi_app.on_event("startup")
async def startup():
    loop = asyncio.get_event_loop()
    loop.run_in_executor(None, _load_model)


@fastapi_app.get("/health")
def health():
    return {"status": "ready" if llm is not None else "loading"}


@fastapi_app.post("/v1/chat/completions")
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


# ── Gradio helpers ────────────────────────────────────────────────────────────

def model_status():
    if llm is not None:
        return "<p class='status ready'>● Model ready</p>"
    return "<p class='status loading'>● Loading model… (first boot takes a few minutes)</p>"


def analyze_image(image, question, max_tokens):
    if llm is None:
        yield "Model is still loading — please wait a moment."
        return
    if image is None:
        yield "Please upload an image."
        return

    # Encode image to base64
    import io
    from PIL import Image as PILImage
    buf = io.BytesIO()
    if not isinstance(image, PILImage.Image):
        image = PILImage.fromarray(image)
    image.save(buf, format="PNG")
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


# ── Theme & CSS ───────────────────────────────────────────────────────────────

THEME = gr.themes.Base(
    primary_hue=gr.themes.colors.orange,
    secondary_hue=gr.themes.colors.stone,
    neutral_hue=gr.themes.colors.stone,
    font=[gr.themes.GoogleFont("Inter"), "ui-sans-serif", "system-ui", "sans-serif"],
    font_mono=[gr.themes.GoogleFont("JetBrains Mono"), "ui-monospace", "monospace"],
).set(
    body_background_fill="#110d08",
    body_background_fill_dark="#110d08",
    block_background_fill="#1c1510",
    block_background_fill_dark="#1c1510",
    block_border_color="#2e2218",
    block_border_color_dark="#2e2218",
    input_background_fill="#150f0a",
    input_background_fill_dark="#150f0a",
    input_border_color="#2e2218",
    input_border_color_dark="#2e2218",
    button_primary_background_fill="#cc785c",
    button_primary_background_fill_hover="#b8664a",
    button_primary_text_color="#fff",
    button_secondary_background_fill="#2e2218",
    button_secondary_background_fill_hover="#3a2c1e",
    button_secondary_text_color="#d4b896",
    body_text_color="#e8ddd0",
    body_text_color_dark="#e8ddd0",
)

CSS = """
.gradio-container { max-width: 860px !important; margin: 0 auto !important; padding: 0 12px !important; }
footer { display: none !important; }
#av-header { padding: 24px 0 8px; border-bottom: 1px solid #2e2218; margin-bottom: 16px; }
#av-header h1 { font-size: 1.6em; font-weight: 700; margin: 0 0 2px; color: #e8ddd0; }
#av-header h1 span { color: #cc785c; }
#av-header p { color: #7a6050; margin: 0; font-size: 0.85em; }
.status { margin: 0 0 10px; font-size: 0.8em; font-weight: 500; }
.status.ready   { color: #6aa87a; }
.status.loading { color: #c9994a; }
#av-footer { color: #4a3828; font-size: 0.75em; text-align: center; padding: 14px 0; border-top: 1px solid #2e2218; margin-top: 12px; }
#av-footer code { background: #1c1510; padding: 1px 5px; border-radius: 4px; color: #7a6050; }
"""

# ── Gradio UI ─────────────────────────────────────────────────────────────────

with gr.Blocks(theme=THEME, css=CSS, title="Axion Vision — Axion Labs") as demo:

    gr.HTML("""
        <div id="av-header">
            <h1>⚛ Axion <span>Vision</span></h1>
            <p>Image understanding &amp; OCR · powered by Qwen2.5-VL-3B · by Axion Labs · free</p>
        </div>
    """)

    status_html = gr.HTML(model_status)

    with gr.Row():
        with gr.Column(scale=1):
            image_input = gr.Image(label="Image", type="numpy")
            question    = gr.Textbox(
                placeholder="What does this say? / Describe this image / What error is shown?…",
                label="Question (optional)",
                lines=2,
            )
            max_tokens  = gr.Slider(64, 1024, value=512, step=64, label="Max tokens")
            submit_btn  = gr.Button("Analyse", variant="primary")

        with gr.Column(scale=1):
            output = gr.Textbox(label="Response", lines=16, show_copy_button=True)

    gr.HTML("""
        <div id="av-footer">
            OpenAI-compatible API: <code>POST /v1/chat/completions</code>
            &nbsp;·&nbsp; send images as <code>image_url</code> content blocks (base64 data URLs)
        </div>
    """)

    submit_btn.click(analyze_image, [image_input, question, max_tokens], output)
    question.submit(analyze_image,  [image_input, question, max_tokens], output)

    demo.load(model_status, outputs=status_html)


app = gr.mount_gradio_app(fastapi_app, demo, path="/")
