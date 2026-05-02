# SpeakUp — 15-Day Speaking Coach

## What this is
Local AI speaking coach. 2 hours daily. 15 days. Free forever.

## Prerequisites
- Node.js 18+
- Ollama (ollama.com — free download)
- Chrome or Edge browser (for Speech API)

## Setup (3 steps)
```bash
npm install
ollama pull llama3
node server.js
```
Open http://localhost:3000

## Daily routine
1. Open app at same time each day
2. Complete 7 habits in order (2 hours total)
3. Review your adapted plan for tomorrow
4. Close app. Rest. Come back tomorrow.

## Troubleshooting
- "Ollama not running": open terminal, run `ollama serve`
- "Mic not working": check browser permissions (lock icon in address bar)
- "No model": run `ollama pull llama3` or `ollama pull mistral`
- "Slow feedback": normal for first response — Ollama loads model into memory

The app runs entirely locally - no internet required after setup.