# Ruchi backend (Supabase)

Shared, realtime database for every phone: spots, reviews, confirms, profiles, photos.

## One-time setup
1. Create a free project at supabase.com (region: **Mumbai / ap-south-1**).
2. **SQL Editor** → run `schema.sql`, then `seed.sql` (20 starter spots).
3. **Authentication → Sign In / Providers** → turn on **Allow anonymous sign-ins**.
4. **Project Settings → API** → copy the Project URL and the `anon` public key into
   `src/config.js` (`supabaseUrl`, `supabaseAnonKey`), then build the APK.

## How it works
- Each install signs in silently (anonymous account), so every write has a real owner.
- Rules (row-level security): anyone can read the map; you can only create, edit
  or delete your own spots and your own profile/reviews/confirms. A/B data is private.
- Photos are uploaded to the public `photos` bucket (max 3 MB, jpg/png/webp) under
  `photos/<userId>/…`; rows only store the URL.
- The phone keeps a cached copy (opens instantly, works offline). Changes made offline
  wait in an outbox and sync when the connection returns. Other phones get changes
  live through Supabase Realtime.
- First cloud launch moves the phone's old local-only data (profile, reviews, own spots)
  to the cloud once.

## Data model
`public.docs (collection, id, owner, data jsonb, created_at, updated_at)` — PK `(collection, id)`.
| collection  | id        | holds |
|-------------|-----------|-------|
| spots       | random    | one pinned place (`data.by` = poster) |
| reviews     | user id   | that user's reviews, keyed by spot id |
| confirms    | user id   | that user's "still open" confirms |
| profiles    | user id   | nickname, avatar, home area, onboarding |
| experiments | user id   | A/B test data (owner-only) |

## Before Play Store launch
- Add Google / phone sign-in and link it to the anonymous account (keeps data on reinstall).
- Turn on CAPTCHA for sign-ups (Auth → Attack Protection) to block bot accounts.
- Free projects pause after 7 days with no activity; any app use keeps it awake.
