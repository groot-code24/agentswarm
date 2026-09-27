"""
Video Clipper — upload a long video, get it back as short downloadable clips.

Run with:
    python app.py

Then open http://localhost:5000 in your browser.

Requires ffmpeg installed and on PATH: https://ffmpeg.org/download.html
"""

import os
import shutil
import subprocess
import threading
import uuid
import zipfile

from flask import Flask, jsonify, render_template, request, send_from_directory

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
UPLOAD_DIR = os.path.join(BASE_DIR, "uploads")
CLIPS_DIR = os.path.join(BASE_DIR, "clips")
ALLOWED_EXT = {".mp4", ".mov", ".mkv", ".avi", ".webm", ".m4v"}

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(CLIPS_DIR, exist_ok=True)

app = Flask(__name__)
# Allow big uploads — long videos can be several GB. Raise further if needed.
app.config["MAX_CONTENT_LENGTH"] = 20 * 1024 * 1024 * 1024  # 20 GB

# In-memory job tracker: {job_id: {"status": ..., "clips": [...], "error": ...}}
jobs = {}


def check_ffmpeg():
    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "ffmpeg was not found on this system. Install it first:\n"
            "  Mac:     brew install ffmpeg\n"
            "  Windows: winget install ffmpeg\n"
            "  Linux:   sudo apt install ffmpeg"
        )


def process_video(job_id, input_path, duration):
    job_dir = os.path.join(CLIPS_DIR, job_id)
    os.makedirs(job_dir, exist_ok=True)
    out_pattern = os.path.join(job_dir, "clip_%04d.mp4")

    cmd = [
        "ffmpeg", "-y",
        "-i", input_path,
        "-f", "segment",
        "-segment_time", str(duration),
        "-reset_timestamps", "1",
        "-c", "copy",
        out_pattern,
    ]

    jobs[job_id]["status"] = "processing"
    try:
        subprocess.run(cmd, check=True, capture_output=True)
        clips = sorted(f for f in os.listdir(job_dir) if f.endswith(".mp4"))
        if not clips:
            raise RuntimeError("No clips were produced. The video file may be corrupted or unsupported.")
        jobs[job_id]["status"] = "done"
        jobs[job_id]["clips"] = clips
    except subprocess.CalledProcessError as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = e.stderr.decode(errors="ignore")[-2000:]
    except Exception as e:
        jobs[job_id]["status"] = "error"
        jobs[job_id]["error"] = str(e)
    finally:
        # Remove the original upload to save disk space once clips exist.
        try:
            os.remove(input_path)
        except OSError:
            pass


@app.route("/")
def index():
    return render_template("index.html")


@app.route("/upload", methods=["POST"])
def upload():
    try:
        check_ffmpeg()
    except RuntimeError as e:
        return jsonify({"error": str(e)}), 500

    file = request.files.get("video")
    if not file or file.filename == "":
        return jsonify({"error": "No file selected."}), 400

    ext = os.path.splitext(file.filename)[1].lower()
    if ext not in ALLOWED_EXT:
        return jsonify({"error": f"Unsupported file type '{ext}'."}), 400

    try:
        duration = int(request.form.get("duration", 45))
    except ValueError:
        duration = 45
    duration = max(5, min(duration, 600))  # sanity clamp: 5s–10min

    job_id = uuid.uuid4().hex[:10]
    input_path = os.path.join(UPLOAD_DIR, f"{job_id}{ext}")
    file.save(input_path)

    jobs[job_id] = {"status": "queued", "clips": []}
    threading.Thread(target=process_video, args=(job_id, input_path, duration), daemon=True).start()

    return jsonify({"job_id": job_id})


@app.route("/status/<job_id>")
def status(job_id):
    job = jobs.get(job_id)
    if not job:
        return jsonify({"error": "Job not found."}), 404
    return jsonify(job)


@app.route("/clip/<job_id>/<filename>")
def clip(job_id, filename):
    # Served inline (with HTTP range support) so the browser can preview/seek.
    job_dir = os.path.join(CLIPS_DIR, job_id)
    return send_from_directory(job_dir, filename, mimetype="video/mp4")


@app.route("/download/<job_id>/<filename>")
def download(job_id, filename):
    job_dir = os.path.join(CLIPS_DIR, job_id)
    return send_from_directory(job_dir, filename, as_attachment=True)


@app.route("/download-all/<job_id>")
def download_all(job_id):
    job_dir = os.path.join(CLIPS_DIR, job_id)
    zip_path = os.path.join(CLIPS_DIR, f"{job_id}.zip")
    if not os.path.exists(zip_path):
        with zipfile.ZipFile(zip_path, "w") as zf:
            for fname in sorted(os.listdir(job_dir)):
                if fname.endswith(".mp4"):
                    zf.write(os.path.join(job_dir, fname), fname)
    return send_from_directory(CLIPS_DIR, f"{job_id}.zip", as_attachment=True)


if __name__ == "__main__":
    app.run(debug=True, host="0.0.0.0", port=5000)
