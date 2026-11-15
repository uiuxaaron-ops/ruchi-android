# Ruchi for Android

This is the Ruchi prototype packaged as a real Android app with **Capacitor**. It's the same design and code as the live prototype, plus a small adapter that runs it on a phone.

## What you need (one time, on your Windows laptop)
1. **Node.js LTS**: https://nodejs.org
2. **Android Studio**: https://developer.android.com/studio. On first launch, let it install the Android SDK.
3. An Android phone and a USB cable, or the emulator built into Android Studio.

## Run it on your phone
1. Unzip this folder, open a terminal inside it, and run:
   ```
   npm install
   npm run sync
   npm run open
   ```
   `npm run open` launches Android Studio with the project. You can also open the `android` folder there yourself.
2. Wait for **Gradle sync** to finish. The first time can take 5–10 minutes.
3. On your phone, turn on **Developer options**: go to Settings → About phone and tap **Build number** 7 times. Then turn on **USB debugging**.
4. Plug in the phone, pick it in Android Studio's device menu, and press **Run ▶**.

## Make an APK to share with friends
In Android Studio, go to **Build → Build App Bundle(s) / APK(s) → Build APK(s)**, then click **locate** to find `app-debug.apk`. Send that file to any Android phone and install it there. The phone will ask to allow installs from that source.

## Publish on Google Play
1. Go to **Build → Generate Signed App Bundle** and choose **Android App Bundle**. Create a keystore and **back it up**: you need the same keystore for every future update.
2. Create a Google Play Console developer account (one-time fee).
3. Create the app, upload the `.aab` to **Internal testing**, and invite testers.
4. Before going public you'll need a privacy policy URL, the store listing, screenshots and the Data safety form. Ruchi stores profile data on the phone and uses the microphone for voice.

## Update the app after changing the prototype
1. Copy the latest prototype HTML over `web/index.html`.
2. Run `npm run sync`.
3. Press **Run ▶** again. For Play, also increase `versionCode` and `versionName` in `android/app/build.gradle`.

## How it works
| Prototype (inside Claude) | Android app |
|---|---|
| Shared database | Saved **on the phone** (`src/ruchi-native.js`), starting with the 20 spots in `src/seed.js` |
| Ask Ruchi AI | Your own server (`server/`). Without it, the **offline planner** answers. |
| Voice input | Android speech recognition (Indian English) |
| Haptics, back button, share | Native Android |
| Google Fonts | Poppins bundled, so it works offline |

Weather, Google Maps and Uber links still need internet.

### Files
- `web/index.html`: the prototype (don't edit it here; copy it in from the prototype).
- `src/config.js`: **your settings** (AI server URL).
- `src/seed.js`: starter spots and sample reviews.
- `src/ruchi-native.js`: the phone adapter.
- `build.js`: builds `www/` from the files above.
- `android/`: the Android Studio project (icon, splash and permissions are already set up).
- `assets/`: source images for the icon and splash. To regenerate after editing them, run `npx capacitor-assets generate --android`.
- `server/`: the Ask Ruchi AI server (Cloudflare Worker). See `server/README.md`.

## Limits of this first version
- **Data stays on each phone.** Spots and reviews you add aren't shared with other users yet, so the Insiders leaderboard only shows you. Sharing needs a cloud database such as Supabase or Firebase. The adapter is built so you swap only `ruchi-native.js` and nothing else.
- **Sign-in is still the prototype flow.** The code is shown on screen and no real SMS is sent.
- **"Near me" uses your home turf, not GPS.** Adding live location is the next native feature.
- **Voice input** needs Google's speech service on the phone, which almost every Android phone has.
