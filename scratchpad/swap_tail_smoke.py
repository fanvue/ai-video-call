import json, sys, time
import modal

video_url, ref_path = sys.argv[1], sys.argv[2]
with open(ref_path, "rb") as f:
    import base64
    ref = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()
cls = modal.Cls.from_name("ai-video-swap", "SwapService")
started = time.perf_counter()
out = cls().swap_tail_url.remote(video_url, ref)
print(json.dumps({"wall_s": round(time.perf_counter() - started, 2), **out["stats"]}))
