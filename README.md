# Video Clipper

Split a long video into short clips, **preview every clip in the page**, and
download the ones you want (one by one, or all at once).

There are two ways to run it:

| | Web version (`public/`) | Local server version (`app.py`) |
|---|---|---|
| Where it runs | Entirely in the visitor's browser (mediabunny, ffmpeg.wasm fallback) | Flask + ffmpeg on your own computer |
| Hosting | Any static host: **Vercel**, Netlify, GitHub Pages | Your machine only |
| Upload | None: the video never leaves the device | Uploaded to your local server |
| Best for | Sharing the tool with others | Very large files on your own PC |

## Deploy the web version to Vercel

The web version is a static site. Vercel runs `npm install` + `npm run build`
(which copies the video libraries into `public/vendor/`) and serves `public/`.
All settings are in `vercel.json`; `.vercelignore` keeps the Flask app,
`clips/` and `uploads/` out of the deployment.

**Option A: Vercel CLI**
```bash
npm i -g vercel
vercel          # first time: log in and link the project (accept the defaults)
vercel --prod   # deploy to production
```

**Option B: GitHub.** Push this folder to a GitHub repo, then on
vercel.com choose *Add New → Project*, import the repo, and click *Deploy*.
No settings need changing: `vercel.json` already sets the build.

**Run the web version locally:**
```bash
npm install
npm run dev     # http://localhost:3000
```

Notes for the web version:
- **Speed:** clips are copied without re-encoding using
  [mediabunny](https://mediabunny.dev), which reads only the parts of the
  file each clip needs. In Chrome a 1-hour, 900 MB MP4 splits in about
  10 seconds. The page shows time taken, time left and speed while it works.
- **Formats:** MP4, MOV, M4V, WebM and MKV use the fast engine. Other files
  (e.g. AVI) fall back to ffmpeg.wasm, which downloads once (~30 MB) and is slower.
- **Shorts / Reels:** pick 60s, 90s or 3-minute clips. The *Vertical 9:16*
  option center-crops and re-encodes each clip with the device's H.264
  encoder. That is much slower than the default (roughly 5-10x faster than
  real time rather than hundreds), and needs Chrome, Edge or Safari.
- Clips are kept in the browser tab's memory. The page warns you before you
  close it. "Download all" saves straight into a folder in Chrome/Edge, and
  builds a ZIP in other browsers.
- Phones and older computers have less memory, so for very large files the
  local server version is the safer choice.

## Local server version: Windows one-command setup

Just double-click **`run.bat`** (or run it from Command Prompt).

It automatically:
1. Checks for Python — installs it via `winget` if missing.
2. Checks for ffmpeg — installs it via `winget`, or downloads a portable
   copy into `ffmpeg_bin\` if `winget` isn't available.
3. Creates a virtual environment (`venv\`) and installs Python dependencies.
4. Starts the server and opens **http://localhost:5000** in your browser.

Just re-run `run.bat` any time you want to start the app again — after the
first run, steps 1-3 are already done, so it starts in a couple of seconds.

If it had to install Python or ffmpeg for the first time, it will ask you to
close the window and run `run.bat` again once, so the new PATH takes effect.

To stop the server, close the window or press `Ctrl+C` in it.

## Local server version: Mac / Linux setup

**Install ffmpeg** (does the actual video splitting):
- Mac: `brew install ffmpeg`
- Linux: `sudo apt install ffmpeg`

**Install Python packages:**
```bash
pip install -r requirements.txt
```

(Python 3.8+ required. Check with `python --version` or `python3 --version`.)

**Run the app:**
```bash
python app.py
```

Then open **http://localhost:5000** in your browser.

## Use it

1. Drag and drop your long video onto the page (or click to choose a file).
2. Pick a clip length: 30, 45, or 60 seconds.
3. Click "Upload & Split".
4. Wait for processing — for a 5-6 hour video this typically takes a few
   minutes, since clips are cut without re-encoding (fast "stream copy" mode).
5. Preview each clip right on the page, then download clips individually,
   or click "Download all as ZIP".

## Notes & tips

- **Supported formats:** mp4, mov, mkv, avi, webm, m4v.
- **Cut accuracy:** clips snap to the nearest keyframe in the source video
  (usually within a second), which keeps splitting nearly instant even on
  very long files. If you need perfectly exact clip lengths, open `app.py`
  and see the comment about adding `-c:v libx264 -c:a aac` re-encoding —
  this is slower but frame-accurate.
- **Very large files:** the app allows uploads up to 20 GB by default. To
  change this, edit `MAX_CONTENT_LENGTH` near the top of `app.py`.
- **Where files go:** uploaded videos are temporarily stored in `uploads/`
  and deleted once clips are made. Clips are stored in `clips/<job_id>/`.
  Delete old folders in `clips/` any time to free up disk space.
- **Stopping the server:** press `Ctrl+C` in the terminal.

## Project structure

```
video-clipper-project/
├── public/
│   ├── index.html       # Web version: splits + previews clips in the browser
│   └── vendor/          # mediabunny, ffmpeg.wasm fallback, client-zip (generated by `npm run build`)
├── scripts/
│   └── copy-vendor.mjs  # Build step: copies browser libraries into public/vendor
├── package.json         # Web version dependencies + build/dev scripts
├── vercel.json          # Vercel build + output settings
├── .vercelignore        # Keeps the Flask app and media out of Vercel deploys
├── run.bat              # Windows: one-click install + start (local server version)
├── app.py               # Flask backend (upload, split with ffmpeg, serve/preview clips)
├── requirements.txt     # Python dependencies
├── templates/
│   └── index.html       # Local server version: upload page + clip previews
├── venv/                # Virtual environment (auto-created by run.bat)
├── ffmpeg_bin/          # Portable ffmpeg, only if winget wasn't available (auto-created)
├── uploads/             # Temporary storage for uploaded videos (auto-created)
└── clips/               # Output clips, one subfolder per job (auto-created)
```
