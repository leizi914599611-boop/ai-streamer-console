"""MuseTalk 实时互动服务（本地 http://127.0.0.1:7863）。

职责：
  - 常驻进程持有 Avatar 缓存与 MuseTalk 模型，避免每句话都重新加载；
  - /talk：文本 -> edge-tts 语音 -> 口型视频（一次互动回合）；
  - /infer：已有音频 -> 口型视频；
  - /stt：faster-whisper 语音识别（CPU int8）；
  - /admin/unload：释放显存，供离线渲染队列抢占 GPU。

所有文件路径均使用仓库内相对路径（cwd=仓库根），避免 OpenCV 在中文绝对路径下读帧失败。
"""

import argparse
import asyncio
import gc
import os
import sys
import threading
import concurrent.futures
import glob
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import traceback
import uuid
from types import SimpleNamespace

import cv2
import numpy as np
import torch
from fastapi import FastAPI, File, HTTPException, UploadFile
from pydantic import BaseModel
import uvicorn

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(REPO_ROOT)
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

STATE = {
    "started_at": time.time(),
    "model_loaded": False,
    "loading": False,
    "avatar_id": None,
    "avatar_ready": False,
    "busy": False,
    "last_error": None,
    "stt_ready": False,
    "stt_model": None,
    "last_turn": None,
}

ARGS = None
LOG_LOCK = threading.Lock()


def log(msg):
    with LOG_LOCK:
        print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


# --------------------------------------------------------------------------- #
# GPU 互斥锁（与 Electron 主进程共用 data/gpu.lock）
# --------------------------------------------------------------------------- #
class GpuLock:
    def __init__(self, path, owner, stale_sec=7200):
        self.path = path
        self.owner = owner
        self.stale_sec = stale_sec

    def acquire(self, wait_sec=600, poll=2.0):
        deadline = time.time() + wait_sec
        while True:
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                with os.fdopen(fd, "w", encoding="utf-8") as f:
                    json.dump({"owner": self.owner, "pid": os.getpid(), "ts": time.time()}, f)
                return True
            except FileExistsError:
                stale = False
                try:
                    age = time.time() - os.path.getmtime(self.path)
                    stale = age > self.stale_sec
                except OSError:
                    stale = True
                if stale:
                    try:
                        os.remove(self.path)
                        log(f"清理过期 GPU 锁: {self.path}")
                    except OSError:
                        pass
                    continue
                if time.time() > deadline:
                    return False
                time.sleep(poll)

    def release(self):
        try:
            os.remove(self.path)
        except OSError:
            pass


GPU_LOCK = None


# --------------------------------------------------------------------------- #
# 模型引擎
# --------------------------------------------------------------------------- #
class Engine:
    def __init__(self, args):
        self.args = args
        self.lock = threading.RLock()
        self.vae = None
        self.unet = None
        self.pe = None
        self.whisper = None
        self.fp = None
        self.audio_processor = None
        self.timesteps = None
        self.weight_dtype = None
        self.device = None
        self.avatar = None
        self.avatar_id = None

    # -- 模型 ------------------------------------------------------------- #
    def load_models(self):
        if STATE["model_loaded"]:
            return
        if STATE["loading"]:
            while STATE["loading"]:
                time.sleep(1)
            if not STATE["model_loaded"]:
                raise RuntimeError(STATE["last_error"] or "模型加载失败")
            return
        STATE["loading"] = True
        STATE["last_error"] = None
        started = time.time()
        try:
            log("加载 MuseTalk 模型...")
            from transformers import WhisperModel
            from musetalk.utils.audio_processor import AudioProcessor
            from musetalk.utils.face_parsing import FaceParsing
            from musetalk.utils.utils import load_all_model

            self.device = torch.device(f"cuda:{self.args.gpu_id}" if torch.cuda.is_available() else "cpu")
            vae, unet, pe = load_all_model(
                unet_model_path=self.args.unet_model_path,
                vae_type=self.args.vae_type,
                unet_config=self.args.unet_config,
                device=self.device,
            )
            self.timesteps = torch.tensor([0], device=self.device)
            if self.args.use_float16:
                pe = pe.half()
                vae.vae = vae.vae.half()
                unet.model = unet.model.half()
            self.pe = pe.to(self.device)
            self.vae = vae
            self.vae.vae = self.vae.vae.to(self.device)
            self.unet = unet
            self.unet.model = self.unet.model.to(self.device)
            self.audio_processor = AudioProcessor(feature_extractor_path=self.args.whisper_dir)
            self.weight_dtype = self.unet.model.dtype
            self.whisper = WhisperModel.from_pretrained(self.args.whisper_dir)
            self.whisper = self.whisper.to(device=self.device, dtype=self.weight_dtype).eval()
            self.whisper.requires_grad_(False)
            self.fp = FaceParsing(
                left_cheek_width=self.args.left_cheek_width,
                right_cheek_width=self.args.right_cheek_width,
            )
            # 把模型注入上游 Avatar 实现，复用其预处理与推理逻辑
            import scripts.realtime_inference as ri
            ri.args = SimpleNamespace(
                version=self.args.version,
                extra_margin=self.args.extra_margin,
                parsing_mode=self.args.parsing_mode,
                audio_padding_length_left=self.args.audio_padding_length_left,
                audio_padding_length_right=self.args.audio_padding_length_right,
                skip_save_images=False,
            )
            ri.vae = self.vae
            ri.unet = self.unet
            ri.pe = self.pe
            ri.whisper = self.whisper
            ri.audio_processor = self.audio_processor
            ri.weight_dtype = self.weight_dtype
            ri.timesteps = self.timesteps
            ri.device = self.device
            ri.fp = self.fp
            self._ri = ri
            STATE["model_loaded"] = True
            log(f"模型加载完成 {time.time() - started:.1f}s device={self.device}")
        except Exception as exc:
            STATE["last_error"] = f"{exc}"
            log(f"模型加载失败: {exc}\n{traceback.format_exc()}")
            raise
        finally:
            STATE["loading"] = False

    def unload(self):
        with self.lock:
            self.avatar = None
            self.avatar_id = None
            STATE["avatar_ready"] = False
            self.vae = None
            self.unet = None
            self.pe = None
            self.whisper = None
            self.audio_processor = None
            self.fp = None
            STATE["model_loaded"] = False
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            log("已释放 MuseTalk 显存")

    # -- Avatar ----------------------------------------------------------- #
    def ensure_avatar(self, avatar_id, video_path):
        self.load_models()
        if self.avatar is not None and self.avatar_id == avatar_id:
            return self.avatar
        cache_dir = self._avatar_dir(avatar_id)
        prep = not os.path.isdir(cache_dir)
        if prep:
            log(f"首次预处理形象 {avatar_id}（{video_path}），可能需要数分钟...")
        else:
            log(f"加载已缓存的形象 {avatar_id}")
        started = time.time()
        avatar = self._ri.Avatar(
            avatar_id=avatar_id,
            video_path=video_path,
            bbox_shift=0,
            batch_size=self.args.batch_size,
            preparation=prep,
        )
        self.avatar = avatar
        self.avatar_id = avatar_id
        STATE["avatar_id"] = avatar_id
        STATE["avatar_ready"] = True
        log(f"形象就绪 {avatar_id} {time.time() - started:.1f}s cache={not prep}")
        return avatar

    def _avatar_dir(self, avatar_id):
        if self.args.version == "v15":
            return os.path.join("results", self.args.version, "avatars", avatar_id)
        return os.path.join("results", "avatars", avatar_id)

    # -- 推理 ------------------------------------------------------------- #
    def infer(self, avatar_id, video_path, audio_path, out_name):
        with self.lock:
            if not GPU_LOCK.acquire(wait_sec=self.args.gpu_wait_sec):
                raise RuntimeError("GPU 正被离线渲染占用，请稍后再试")
            try:
                STATE["busy"] = True
                started = time.time()
                avatar = self.ensure_avatar(avatar_id, video_path)
                t0 = time.time()
                avatar.inference(audio_path, out_name, self.args.fps, False)
                output = os.path.join(avatar.video_out_path, out_name + ".mp4")
                if not os.path.exists(output):
                    raise RuntimeError("推理结束但未生成视频文件")
                elapsed = time.time() - started
                log(f"口型推理完成 {out_name} {elapsed:.1f}s（模型/预处理 {t0 - started:.1f}s）")
                return os.path.abspath(output), elapsed
            finally:
                STATE["busy"] = False
                GPU_LOCK.release()

    # -- TTS -------------------------------------------------------------- #
    async def synthesize(self, text, voice, rate=None):
        import edge_tts

        os.makedirs("results/_realtime/audio", exist_ok=True)
        name = f"tts-{uuid.uuid4().hex[:10]}"
        mp3_path = os.path.join("results/_realtime/audio", name + ".mp3")
        wav_path = os.path.join("results/_realtime/audio", name + ".wav")
        tts_voice = voice or self.args.tts_voice
        tts_rate = rate or self.args.tts_rate

        # edge-tts 底层用 aiohttp，要求 SelectorEventLoop。
        # uvicorn 在 Windows 默认 ProactorEventLoop，直接 await 会触发 "No audio was received"。
        # 解决方案：把 edge-tts 调用放到独立线程 + 独立事件循环里。
        def _edge_tts_in_thread(attempt):
            """在线程里跑：创建 SelectorEventLoop → edge-tts save → 返回"""
            def _run():
                if sys.platform == "win32":
                    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
                loop = asyncio.new_event_loop()
                try:
                    asyncio.set_event_loop(loop)
                    comm = edge_tts.Communicate(text, tts_voice, rate=tts_rate)
                    loop.run_until_complete(comm.save(mp3_path))
                finally:
                    loop.close()
            with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                future = pool.submit(_run)
                future.result(timeout=30 + attempt * 10)  # 超时随重试递增

        last_error = None
        for attempt in range(3):
            try:
                _edge_tts_in_thread(attempt)
                if os.path.getsize(mp3_path) > 1024:
                    break
                raise RuntimeError("合成的音频文件为空")
            except Exception as exc:
                last_error = exc
                log(f"edge-tts 合成失败（第 {attempt + 1} 次）: {exc}")
                try:
                    os.remove(mp3_path)
                except OSError:
                    pass
                await asyncio.sleep(1.0 + attempt)
        else:
            raise RuntimeError(f"edge-tts 连续失败: {last_error}")
        proc = await asyncio.create_subprocess_exec(
            self.args.ffmpeg_path,
            "-y", "-v", "error", "-i", mp3_path,
            "-ar", "16000", "-ac", "1", wav_path,
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        _, err = await proc.communicate()
        if proc.returncode != 0:
            raise RuntimeError(f"ffmpeg 转码失败: {err.decode('utf-8', 'ignore')[-300:]}")
        return os.path.abspath(wav_path), os.path.abspath(mp3_path)

    # -- STT -------------------------------------------------------------- #
    def load_stt(self):
        if STATE["stt_ready"]:
            return STATE["stt_model"]
        from faster_whisper import WhisperModel

        started = time.time()
        log(f"加载 faster-whisper（{self.args.stt_model}，CPU int8）...")
        model = WhisperModel(
            self.args.stt_model,
            device="cpu",
            compute_type="int8",
            download_root=self.args.stt_dir,
        )
        STATE["stt_model"] = model
        STATE["stt_ready"] = True
        log(f"faster-whisper 就绪 {time.time() - started:.1f}s")
        return model

    def transcribe(self, audio_path, language=None):
        model = self.load_stt()
        segments, info = model.transcribe(audio_path, language=language or "zh", vad_filter=True, beam_size=1)
        text = "".join(seg.text for seg in segments).strip()
        return text, getattr(info, "language", None)


# --------------------------------------------------------------------------- #
# HTTP API
# --------------------------------------------------------------------------- #
app = FastAPI(title="MuseTalk Realtime Service")
engine = None


class AvatarReq(BaseModel):
    avatarId: str = "yongen"
    videoPath: str = "data/video/yongen.mp4"


class InferReq(BaseModel):
    avatarId: str = "yongen"
    videoPath: str = "data/video/yongen.mp4"
    audioPath: str
    outName: str = None


class TalkReq(BaseModel):
    avatarId: str = "yongen"
    videoPath: str = "data/video/yongen.mp4"
    text: str
    voice: str = None
    rate: str = None


def _abs_path(p):
    if not p:
        return p
    return p if os.path.isabs(p) else os.path.abspath(p)


@app.get("/health")
def health():
    busy = STATE["busy"]
    locked = os.path.exists(GPU_LOCK.path) if GPU_LOCK else False
    return {
        "ok": True,
        "version": ARGS.version if ARGS else None,
        "device": str(engine.device) if engine and engine.device else None,
        "modelLoaded": STATE["model_loaded"],
        "loading": STATE["loading"],
        "avatarId": STATE["avatar_id"],
        "avatarReady": STATE["avatar_ready"],
        "busy": busy,
        "gpuLocked": locked,
        "sttReady": STATE["stt_ready"],
        "sttModel": ARGS.stt_model if ARGS else None,
        "lastError": STATE["last_error"],
        "lastTurn": STATE["last_turn"],
        "uptimeSec": int(time.time() - STATE["started_at"]),
    }


@app.post("/admin/load")
async def admin_load():
    try:
        await asyncio.to_thread(engine.load_models)
        return {"ok": True, "device": str(engine.device)}
    except Exception as exc:
        raise HTTPException(500, f"模型加载失败: {exc}")


@app.post("/admin/unload")
async def admin_unload():
    if STATE["busy"]:
        raise HTTPException(409, "正在推理，稍后再试")
    await asyncio.to_thread(engine.unload)
    return {"ok": True}


@app.post("/avatar/prepare")
async def avatar_prepare(req: AvatarReq):
    def work():
        if not GPU_LOCK.acquire(wait_sec=ARGS.gpu_wait_sec):
            raise RuntimeError("GPU 正被离线渲染占用")
        try:
            engine.ensure_avatar(req.avatarId, req.videoPath)
            return True
        finally:
            GPU_LOCK.release()

    try:
        started = time.time()
        await asyncio.to_thread(work)
        return {"ok": True, "avatarId": req.avatarId, "elapsedMs": int((time.time() - started) * 1000)}
    except Exception as exc:
        raise HTTPException(500, f"形象预处理失败: {exc}")


@app.post("/synthesize")
async def synthesize(req: TalkReq):
    """仅 edge-tts 合成干声（返回 wav 路径），供外部 SVC 音色转换。"""
    if not req.text or not req.text.strip():
        raise HTTPException(400, "文本为空")
    started = time.time()
    try:
        wav_path, mp3_path = await engine.synthesize(req.text.strip(), req.voice, req.rate)
        tts_ms = int((time.time() - started) * 1000)
        return {
            "ok": True,
            "wavPath": os.path.abspath(wav_path),
            "mp3Path": os.path.abspath(mp3_path),
            "ttsMs": tts_ms,
        }
    except Exception as exc:
        raise HTTPException(500, f"edge-tts 合成失败: {exc}")


@app.post("/infer")
async def infer(req: InferReq):
    audio = _abs_path(req.audioPath)
    if not os.path.exists(audio):
        raise HTTPException(400, f"音频不存在: {req.audioPath}")
    out_name = req.outName or f"infer-{uuid.uuid4().hex[:8]}"
    try:
        path, elapsed = await asyncio.to_thread(
            engine.infer, req.avatarId, req.videoPath, audio, out_name
        )
        return {"ok": True, "videoPath": path, "elapsedMs": int(elapsed * 1000)}
    except Exception as exc:
        raise HTTPException(500, f"口型推理失败: {exc}")


@app.post("/talk")
async def talk(req: TalkReq):
    if not req.text or not req.text.strip():
        raise HTTPException(400, "文本为空")
    started = time.time()
    try:
        wav_path, mp3_path = await engine.synthesize(req.text.strip(), req.voice, req.rate)
        tts_ms = int((time.time() - started) * 1000)
        out_name = f"talk-{uuid.uuid4().hex[:10]}"
        video_path, infer_elapsed = await asyncio.to_thread(
            engine.infer, req.avatarId, req.videoPath, wav_path, out_name
        )
        total_ms = int((time.time() - started) * 1000)
        STATE["last_turn"] = {
            "text": req.text.strip(),
            "videoPath": video_path,
            "at": time.time(),
            "totalMs": total_ms,
        }
        return {
            "ok": True,
            "text": req.text.strip(),
            "videoPath": video_path,
            "audioPath": wav_path,
            "ttsMs": tts_ms,
            "inferMs": int(infer_elapsed * 1000),
            "totalMs": total_ms,
        }
    except Exception as exc:
        log(f"互动回合失败: {exc}\n{traceback.format_exc()}")
        raise HTTPException(500, f"互动回合失败: {exc}")


@app.post("/stt")
async def stt(file: UploadFile = File(...), language: str = "zh"):
    os.makedirs("results/_realtime/uploads", exist_ok=True)
    raw_path = os.path.join("results/_realtime/uploads", f"stt-{uuid.uuid4().hex[:10]}-{file.filename or 'audio.bin'}")
    with open(raw_path, "wb") as f:
        f.write(await file.read())
    wav_path = raw_path.rsplit(".", 1)[0] + ".wav"
    proc = await asyncio.create_subprocess_exec(
        ARGS.ffmpeg_path,
        "-y", "-v", "error", "-i", raw_path,
        "-ar", "16000", "-ac", "1", wav_path,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    _, err = await proc.communicate()
    if proc.returncode != 0:
        raise HTTPException(400, f"音频转码失败: {err.decode('utf-8', 'ignore')[-300:]}")
    try:
        text, lang = await asyncio.to_thread(engine.transcribe, wav_path, language)
        return {"ok": True, "text": text, "language": lang, "audioPath": os.path.abspath(wav_path)}
    except Exception as exc:
        raise HTTPException(503, f"语音识别不可用: {exc}")


def main():
    global ARGS, engine, GPU_LOCK
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7863)
    parser.add_argument("--version", default="v15", choices=["v1", "v15"])
    parser.add_argument("--gpu_id", type=int, default=0)
    parser.add_argument("--vae_type", default="sd-vae")
    parser.add_argument("--unet_config", default="models/musetalkV15/musetalk.json")
    parser.add_argument("--unet_model_path", default="models/musetalkV15/unet.pth")
    parser.add_argument("--whisper_dir", default="models/whisper")
    parser.add_argument("--ffmpeg_path", default="../ffmpeg/ffmpeg.exe")
    parser.add_argument("--extra_margin", type=int, default=10)
    parser.add_argument("--fps", type=int, default=25)
    parser.add_argument("--batch_size", type=int, default=4)
    parser.add_argument("--audio_padding_length_left", type=int, default=2)
    parser.add_argument("--audio_padding_length_right", type=int, default=2)
    parser.add_argument("--use_float16", action="store_true", default=True)
    parser.add_argument("--parsing_mode", default="jaw")
    parser.add_argument("--left_cheek_width", type=int, default=90)
    parser.add_argument("--right_cheek_width", type=int, default=90)
    parser.add_argument("--tts_voice", default="zh-CN-XiaoxiaoNeural")
    parser.add_argument("--tts_rate", default="+0%")
    parser.add_argument("--stt_model", default="small")
    parser.add_argument("--stt_dir", default="models/faster-whisper")
    parser.add_argument("--lock_file", default="")
    parser.add_argument("--gpu_wait_sec", type=int, default=600)
    parser.add_argument("--preload", action="store_true")
    ARGS = parser.parse_args()
    ARGS.ffmpeg_path = os.path.abspath(ARGS.ffmpeg_path)

    # ffmpeg 加入 PATH：Avatar.inference 内部使用 os.system 编码视频
    os.environ["PATH"] = os.path.dirname(ARGS.ffmpeg_path) + os.pathsep + os.environ.get("PATH", "")
    # 国内网络下载 faster-whisper 权重走镜像
    os.environ.setdefault("HF_ENDPOINT", "https://hf-mirror.com")

    lock_file = ARGS.lock_file or os.path.join(REPO_ROOT, "results", "_realtime", "gpu.lock")
    os.makedirs(os.path.dirname(lock_file), exist_ok=True)
    GPU_LOCK = GpuLock(lock_file, owner="realtime")

    engine = Engine(ARGS)
    log(f"实时服务启动 cwd={os.getcwd()} port={ARGS.port} lock={lock_file}")
    if ARGS.preload:
        threading.Thread(target=lambda: _safe_preload(engine), daemon=True).start()
    uvicorn.run(app, host=ARGS.host, port=ARGS.port, log_level="info")


def _safe_preload(eng):
    try:
        eng.load_models()
    except Exception as exc:
        log(f"预加载失败: {exc}")


if __name__ == "__main__":
    main()
