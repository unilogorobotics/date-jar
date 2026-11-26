# 🫙 Date Jar

A shared jar of date ideas for couples. Sign in with Google, create a jar, send your partner the invite link, and fill it with ideas together. When you can't decide, shake the jar for a random date, with optional filters for vibe and budget. Dates you mark as done move to a "Memories" list.

- **Google login.** Everyone has their own account through Firebase Authentication.
- **Shared jars.** Invite links let your partner join, and changes sync live between you both.
- **Private by default.** Firestore security rules (`firestore.rules`) only let jar members read or change a jar. Joining requires the secret code in the invite link, and you can reset the link at any time.
- **Multiple jars.** For example, one with your partner and one with friends.

Stack: Vite + vanilla JS + Firebase (Auth + Firestore). There is no server to run.

---

## Setup (about 10 minutes)

### 1. Create a Firebase project

1. Go to <https://console.firebase.google.com> → **Add project**. Google Analytics is optional.
2. **Build → Authentication → Get started → Sign-in method → Google → Enable** → Save.
3. **Build → Firestore Database → Create database** → choose a location → start in **production mode**.
4. **Project settings (⚙️) → Your apps → Web (`</>`)** → register an app. Copy the `apiKey`, `authDomain`, `projectId` and `appId` values.

### 2. Run locally

```bash
npm install
npm run dev
```

### 3. Deploy the security rules

The app is only safe once these rules are live:

```bash
npx firebase login
npx firebase use --add     # pick your project
npx firebase deploy --only firestore:rules
```

### 4. Put it on the internet (pick one)

**Option A: Firebase Hosting (simplest).** You get a URL like `https://your-project.web.app`.

```bash
npm run deploy             # builds and deploys hosting + rules
```

**Option B: GitHub Pages.** Every push to `main` deploys automatically.

1. Repo **Settings → Pages → Source: GitHub Actions**.
2. The Firebase config for `date-jar-99346` is built into `src/firebase.js`. To point at another project, set the `FIREBASE_API_KEY`, `FIREBASE_AUTH_DOMAIN`, `FIREBASE_PROJECT_ID` and `FIREBASE_APP_ID` repository variables.
3. In Firebase: **Authentication → Settings → Authorized domains → Add domain** → `<your-github-username>.github.io`.
4. Push to `main`. The site will be at `https://<user>.github.io/date-jar/`.

If you use a custom domain, add it to the Authorized domains list too.

---

## How sharing works

1. You sign in and create a jar.
2. Tap **💌 Invite**. On a phone this opens the share sheet. On a computer it copies the link.
3. Your partner opens the link and signs in with Google, then joins the jar automatically.
4. Under **⚙️ Settings** you can rename the jar, reset the invite link (old links stop working), see members, or leave the jar.

## Local testing with emulators

```bash
npm run emulators          # terminal 1 (needs Java)
npm run dev:emulated       # terminal 2
```

In emulator mode, the browser console exposes `__signInAs(uid, name, email)` so you can fake several users without real Google accounts.

## Data model

```
jars/{jarId}                 name, createdBy, createdAt, inviteCode, members[], memberInfo{uid: {name, photo}}
jars/{jarId}/ideas/{ideaId}  text, category, budget (0–3), done, doneAt, addedBy, addedByName, createdAt
```
