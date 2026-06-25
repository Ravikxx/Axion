"""
Format message-lists into Qwen 3 chat template format.

Input:  list of message-lists  [ [{"role":..., "content":...}, ...], ... ]
Output: JSONL lines with {"messages": [...]} ready for SFT training

Qwen 3 uses ChatML-style format:
<|im_start|>system
...<|im_end|>
<|im_start|>user
...<|im_end|>
<|im_start|>assistant
...<|im_end|>

The JSONL format expected by Unsloth / TRL / HuggingFace SFTTrainer is:
{"messages": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}
The model's chat template (added via tokenizer.chat_template) handles conversion.
"""
import json, os, sys

sys.path.insert(0, os.path.dirname(__file__))
import config


def format_for_qwen(msgs_list):
    """Wrap messages with the Qwen-style system prompt injected at position 0."""
    formatted = []
    for msgs in msgs_list:
        new_msgs = list(msgs)
        # Insert system message at start if not already present
        if not any(m["role"] == "system" for m in new_msgs):
            new_msgs.insert(0, {
                "role": "system",
                "content": config.QWEN_SYSTEM_PROMPT,
            })
        formatted.append({"messages": new_msgs})
    return formatted


def write_dataset(formatted, out_path=None):
    if out_path is None:
        out_path = config.OUTPUT_FILE

    with open(out_path, "w", encoding="utf-8") as f:
        for entry in formatted:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")

    size_mb = os.path.getsize(out_path) / 1024 / 1024
    print(f"  [format] wrote {len(formatted):,} examples -> {out_path} ({size_mb:.1f} MB)", flush=True)


if __name__ == "__main__":
    # Test with sample data
    sample = [
        [
            {"role": "user", "content": "What is Python?"},
            {"role": "assistant", "content": "Python is a programming language."},
        ]
    ]
    formatted = format_for_qwen(sample)
    print(json.dumps(formatted[0], indent=2))
