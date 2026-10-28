# Reelkeep — install guide

Your own video downloader for Chrome, Edge, Brave and Firefox. Every feature is unlocked: no account, no limits, no ads, nothing sent anywhere.

## Install in Chrome, Edge, Brave, Opera (2 minutes)

Use **`Reelkeep-chrome.zip`**.

1. **Unzip** it. You get a folder called `Reelkeep`. Move it somewhere permanent (for example `Documents/Reelkeep`). The browser loads it from there, so don't delete it later.
2. Go to **`chrome://extensions`** (Edge: `edge://extensions`, Brave: `brave://extensions`).
3. Turn on **Developer mode**.
4. Click **Load unpacked** and select the `Reelkeep` folder (the one containing `manifest.json`).
5. Pin Reelkeep from the puzzle-piece menu.

If Chrome shows a "Disable developer mode extensions" bubble at startup, click the X. It's normal for extensions you load yourself.

## Install in Firefox (128 or newer)

Use **`Reelkeep-firefox.zip`**. Firefox only keeps add-ons that Mozilla has signed, so pick one:

**Option A: permanent (recommended, free, about 5 minutes once)**
1. Sign in at **addons.mozilla.org/developers** with a free Firefox account.
2. Click **Submit a New Add-on**, choose **On your own** (self-distribution, not listed in the store), and upload `Reelkeep-firefox.zip`.
3. The automatic check usually finishes in a few minutes. Download the **signed `.xpi`** it gives you.
4. Drag the `.xpi` into Firefox and click **Add**. It stays installed and updates only when you repeat this with a new version.

**Option B: quick test (removed when Firefox closes)**
1. Go to **`about:debugging#/runtime/this-firefox`**.
2. Click **Load Temporary Add-on…** and pick `Reelkeep-firefox.zip`.

**Option C: Firefox Developer Edition or Nightly only:** set `xpinstall.signatures.required` to `false` in `about:config`, then open `about:addons` → gear → **Install Add-on From File…** → pick the zip.

After installing in Firefox:
- Open the Reelkeep popup once. If it says **"Reelkeep needs access to websites"**, click **Allow on all sites**. Without it Firefox hides every video from the extension.
- While a download runs, Firefox shows a small pinned **"Reelkeep downloads"** tab. Firefox has no hidden background pages for long jobs, so the work happens there. Leave it open; it closes itself when the downloads finish.

## Use it

1. Open a page with a video and **press play**. The icon shows a number when it finds media.
2. Click the icon. Under **On this page**, pick a **quality** and a **format**, then **Download** (or **Record** for a live stream).
3. Watch it in **Downloads**: progress bar, **time left countdown** (e.g. `0:59 left`), speed and size. You can close the popup; it keeps going.
4. Files go to `Downloads/Reelkeep/`. Everything you saved is in **Library** (Open, Show in folder, Source page, search).

| format | what you get |
| --- | --- |
| MP4 | video + audio in one file (default) |
| MKV | same, in an MKV container |
| MP3 audio | audio only, converted to MP3 |
| M4A audio | audio only, original quality, no re-encode |
| As is | exactly what the site sends, no processing |

**Live streams:** press **Record**, then **Stop & save** in Downloads when you're done. A timer counts up while recording.

## Settings (gear icon)

Default format · folder inside Downloads · ask where to save · hide files smaller than X KB · sites to ignore · light/dark theme · badge as number or dot.

## What it supports

- MP4, WebM, MOV, MP3, M4A and other direct media files
- HLS (`.m3u8`): every quality, separate audio tracks merged in, MPEG-TS and fMP4 segments, AES-128 encrypted streams that the site plays openly
- DASH (`.mpd`): every quality, audio and video merged
- Live HLS recording
- Sites that only serve video to their own pages (the page address is sent along automatically)

## What it doesn't do

- **DRM-protected video** (Netflix, Prime Video, Disney+, Hulu, Spotify and similar) shows as *Protected* and can't be saved.
- **YouTube** isn't blocked, but its player streams in a way that usually can't be captured from the page, so it often won't show up.
- **Live DASH** can't be recorded (live HLS can).
- Converting or merging happens inside the browser, so a single video over about **1.6 GB** can't be merged; pick a lower quality. Plain files of any size download normally.

Only save videos you have the right to keep, and respect each site's terms.

## Troubleshooting

- **"No videos found yet" after pressing play:** reload the page (F5) and play again. Pages that were open before you installed or updated Reelkeep don't report their videos until they reload.
- **Still nothing on one site:** the site may use DRM (Netflix-style protection), which can't be saved. Otherwise tell me the site and I'll look at it.
- **Brave:** if a site shows nothing, click the lion icon, turn **Shields** off for that site, reload and play again.
- **Firefox shows nothing at all:** open the popup and click **Allow on all sites**, or go to `about:addons` → Reelkeep → Permissions and turn on access to all websites.
- **"Couldn't read this stream":** the link expired. Reload the page, play again, retry.
- **Download fails partway:** the site's links may expire quickly; start it again right after pressing play.
- **Update to a new version (Chrome):** replace the folder's contents, click the reload ↻ icon on Reelkeep in `chrome://extensions`, then reload your open pages.

## Inside

Manifest V3 · no remote code · no analytics · all data stays in your browser. Merging and conversion use ffmpeg.wasm (`vendor/ffmpeg`, ffmpeg.wasm is MIT; the ffmpeg core is GPL/LGPL).
