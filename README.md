# Retain

A daily study app for students: an AI tutor that gives hints or answers, a Notebook that remembers everything they've asked and learned, an assignment tracker with a calendar, quick topic lessons with practice questions, and a plan for today with a focus timer.

## How it fits together

- **Next.js** app. The interface lives in `lib/app.js` (plain DOM code), started by `app/RetainApp.tsx`.
- **Supabase** handles sign-in (email link or Google) and stores each student's data. Row level security in `supabase/schema.sql` means a student can only read their own rows.
- **`app/api/ai/route.ts`** is the only place the Anthropic API key is used. It checks the student is signed in, counts the request against a daily limit, and streams Claude's answer back.

## Setup

1. **Supabase**: create a project. In *SQL Editor*, run `supabase/schema.sql`. In *Authentication > URL Configuration*, set the Site URL to your website's address. Email sign-in works out of the box; to offer Google, turn it on under *Authentication > Providers*.
2. **Anthropic**: create an API key at console.anthropic.com. Set a monthly spend limit there too.
3. **Vercel**: import this repository, then add these environment variables (see `.env.example`):
   - `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` (Supabase *Project Settings > API*)
   - `ANTHROPIC_API_KEY`
   - optional: `RETAIN_DAILY_AI_LIMIT` (tutor requests per student per day, default 80) and `RETAIN_MODEL` (default `claude-opus-5-5`)

## Running locally

```bash
cp .env.example .env.local   # fill in the values
npm install
npm run dev
```
