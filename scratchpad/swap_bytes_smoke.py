import base64, json, sys, time
import modal

video_path, ref_path, method = sys.argv[1], sys.argv[2], sys.argv[3]
with open(video_path, "rb") as f:
    video = f.read()
with open(ref_path, "rb") as f:
    ref = "data:image/jpeg;base64," + base64.b64encode(f.read()).decode()
cls = modal.Cls.from_name("ai-video-swap", "SwapService")
started = time.perf_counter()
fn = getattr(cls(), method)
out = fn.remote(video, ref)
stats = out["stats"]
print(json.dumps({"video": video_path, "wall_s": round(time.perf_counter() - started, 2), **stats}))
