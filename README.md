# Lottie AI Studio

Lottie AI Studio is a browser-based dashboard for inspecting, exporting, and AI-editing many Lottie JSON files at once.

## What it does

- Drag and drop multiple JSON files
- Drop folders and scan nested files
- Search the loaded list by filename
- Preview one animation in a larger stage
- Show file size, dimensions, frame count, and duration
- Export selected animations as MP4
- Generate or edit Lottie files with fal.ai Omnilottie or a Wiro model runner
- Keep AI edit history inside the current browser session

## Why it exists

This was built for batch checks and fast iteration. Load a pile of exports, spot the wrong file fast, inspect the selected animation, then create AI-assisted variants without losing the batch view.

## Privacy

- Runs in the browser
- Accepts `.json` Lottie files
- Skips invalid files and keeps the rest of the batch
- Uses `lottie-web` for playback
- Does not include a backend database
- Does not store uploaded files or API keys on a server
- fal.ai and Wiro keys are stored only in `sessionStorage`
- AI requests are sent to the selected provider only when you run an edit

## Run it

```bash
npm install
npm run dev
```

Open `http://localhost:5173`.

## Build

```bash
npm run build
```

## Deploy

The repository includes a GitHub Pages workflow. Push to `main`, then enable GitHub Pages with **Source: GitHub Actions** in the repository settings.

Public URL: `https://hasaneyldrm.github.io/lottie-ai-studio/`
