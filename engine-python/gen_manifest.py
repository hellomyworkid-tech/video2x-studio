# -*- coding: utf-8 -*-
"""生成 weights/manifest.json：大小 + sha256 + 检查点关键键名（供下载后校验）。"""
import hashlib, json, os, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "weights")

FILES = [
    "realbasicvsr_x4.pth",
    "spynet.pth",
    "FlashVSR-v1.1/LQ_proj_in.ckpt",
    "FlashVSR-v1.1/TCDecoder.ckpt",
    "FlashVSR-v1.1/Wan2.1_VAE.pth",
    "FlashVSR-v1.1/diffusion_pytorch_model_streaming_dmd.safetensors",
    "SeedVR2-3B/seedvr2_ema_3b_fp8_e4m3fn.safetensors",
    "SeedVR2-3B/ema_vae_fp16.safetensors",
]

def sha256_of(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 24), b""):
            h.update(chunk)
    return h.hexdigest()

def keys_of(path):
    """提取检查点顶层键名样例与总数；失败返回 None。"""
    try:
        if path.endswith(".safetensors"):
            with open(path, "rb") as f:
                n = int.from_bytes(f.read(8), "little")
                hdr = json.loads(f.read(n).decode("utf-8"))
            ks = [k for k in hdr if k != "__metadata__"]
            return {"count": len(ks), "sample": sorted(ks)[:8]}
        import torch
        obj = torch.load(path, map_location="cpu", weights_only=False)
        sd = obj
        for wrap in ("state_dict", "params", "params_ema", "generator"):
            if isinstance(obj, dict) and wrap in obj and isinstance(obj[wrap], dict):
                sd = obj[wrap]
                break
        ks = list(sd.keys()) if isinstance(sd, dict) else []
        return {"count": len(ks), "sample": sorted(ks)[:8], "wrap": None if sd is obj else wrap}
    except Exception as e:  # noqa
        return {"error": str(e)}

def main():
    out = {}
    for rel in FILES:
        p = os.path.join(ROOT, rel.replace("/", os.sep))
        info = {"size": os.path.getsize(p), "sha256": sha256_of(p), "keys": keys_of(p)}
        out[rel] = info
        print(rel, info["size"], info["sha256"][:12], (info["keys"] or {}).get("count"))
    dst = os.path.join(ROOT, "manifest.json")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print("written:", dst)

if __name__ == "__main__":
    sys.exit(main())
