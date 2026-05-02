# SpeakUp — 15-Day Speaking Coach

## What this is
Local AI speaking coach with premium features. 2 hours daily. 15 days. Freemium model with Pro upgrades.

## Features
- **Core**: 15-day structured speaking program with AI feedback
- **Growth**: Friend challenges, streak emails, leaderboard, referrals
- **Premium**: Mock interviews, voice comparison, coach personas
- **Business**: Team plans, certificates, affiliate program

## Prerequisites
- Node.js 18+
- Ollama (ollama.com — free download)
- Chrome or Edge browser (for Speech API)
- Stripe account (for payments)
- SMTP email service (for reminders)

## Setup (4 steps)

1. **Clone and install dependencies:**
```bash
git clone <your-repo-url>
cd speaking-coach
npm install
```

2. **Set up environment variables:**
```bash
cp .env.example .env
# Edit .env with your actual API keys
```

3. **Set up Ollama:**
```bash
ollama pull llama3
ollama pull llava  # for body language analysis
```

4. **Start the server:**
```bash
node server.js
```
Open http://localhost:3000

## Environment Variables Required

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY`: For AI feedback (Claude API)
- `STRIPE_SECRET_KEY`: Stripe secret key for payments
- `STRIPE_WEBHOOK_SECRET`: Stripe webhook secret
- `SMTP_*`: Email credentials for daily reminders
- `BASE_URL`: Your deployment URL

## Daily routine
1. Open app at same time each day
2. Complete 7 habits in order (2 hours total)
3. Review your adapted plan for tomorrow
4. Share progress or challenge friends
5. Close app. Rest. Come back tomorrow.

## Monetization
- Days 1-3: Free forever
- Day 4+: Pro subscription required ($9/month or $49/lifetime)
- Team plans: 5+ seats for organizations
- Affiliate program: 30% commission

## Troubleshooting
- "Ollama not running": open terminal, run `ollama serve`
- "Mic not working": check browser permissions (lock icon in address bar)
- "No model": run `ollama pull llama3` or `ollama pull mistral`
- "Stripe errors": check webhook configuration
- "Email not sending": verify SMTP credentials
- "Slow feedback": normal for first response — Ollama loads model into memory

The app runs entirely locally - no internet required after setup.