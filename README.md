# Quickfire

Quickfire is a static GitHub Pages quiz site backed by Firebase Authentication, Cloud Firestore, and callable Cloud Functions. Students join one session with a code and name; teachers sign in to manage reusable tests, sessions, and results.

## Firestore structure

- `teacherUsers/{uid}`: administrator-managed teacher allowlist. The app cannot grant teacher access.
- `tests/{testId}`: reusable test metadata and settings.
- `tests/{testId}/questions/{questionId}`: authored questions and answer keys, readable only by an authorized teacher.
- `sessionCodes/{code}`: private reservation mapping from a six-character code to a session.
- `sessions/{sessionId}`: one run of a test, with owner, code, status, scoring settings, and maximum marks.
- `sessions/{sessionId}/publicQuestions/{questionId}`: prompts and options only. Students receive these from the join callable while the session is open.
- `sessions/{sessionId}/answerKeys/{questionId}`: private answer-key snapshot. Firestore rules deny all client access.
- `sessions/{sessionId}/attempts/{anonymousUid}`: student name, progress, score, status, and timestamps.
- `sessions/{sessionId}/attempts/{anonymousUid}/responses/{questionId}`: submitted answer, grade, and post-submission feedback. Only the session's teacher can read response documents; student feedback is returned by callable Functions after submission.
- `joinRateLimits/{hash}`: server-only rate-limit counters for failed code lookups.

## Security and grading

Students use Firebase Anonymous Authentication, giving Firestore rules a per-attempt UID without requiring student accounts. Teachers use Email/Password Authentication and must also have a `teacherUsers/{uid}` allowlist document.

Firestore rules cannot hide selected fields from an otherwise-readable document. Therefore the browser never reads answer keys. `createSession` copies prompts/options to a public snapshot and answer keys to a private snapshot. `joinSession` validates the code and returns only the public snapshot. `startQuestion` records a server timestamp; `submitAnswer` grades from that timestamp rather than trusting the browser clock. `finishAttempt` releases end-of-test feedback only after every response is submitted. `gradeWrittenResponse` applies teacher marks on the server. `createSampleTest` seeds a six-type sample without including its answer key in the browser bundle.

Cloud Functions require the Firebase project to use the Blaze billing plan. The Pages workflow publishes only the static client files; the Functions source and Firestore rules are excluded from the Pages artifact.

## Exact Firebase setup

1. Create a Firebase project and a Cloud Firestore database.
2. Enable **Authentication → Sign-in method → Email/Password** and **Anonymous**.
3. Register a Firebase Web App. Copy its `apiKey`, `authDomain`, `projectId`, and `appId` into `firebase-config.js`. These web config values are public. Never put a service-account key or Admin SDK credentials in the client project.
4. In **Authentication → Users**, create your teacher's email/password account. Copy the user's UID. In Firestore, create `teacherUsers/{UID}` with a field such as `authorized: true`. Only an administrator should create this allowlist document.
5. Add the GitHub Pages domain to **Authentication → Settings → Authorized domains** after Pages is published. Add `localhost` for local testing if it is not already listed.
6. Install Node.js 20 and the Firebase CLI. In a terminal, from this project folder (`copilot-playground`), select your Firebase project and deploy the backend:

   ```powershell
   npm install --global firebase-tools
   firebase login
   firebase use --add
   cd functions
   npm install
   cd ..
   firebase deploy --only firestore:rules,firestore:indexes,functions
   ```

7. Restrict the Firebase web API key to your GitHub Pages domain and localhost in Google Cloud Console. The key itself is not a secret; Firestore rules and server Functions enforce access.

## GitHub Pages setup

This project has `.github/workflows/pages.yml`. Publish the **contents of this `copilot-playground` folder as the repository root** so the workflow is at `.github/workflows/pages.yml` and its static file paths match.

1. Create a GitHub repository and push this project's files to its `main` branch. Do not commit `functions/node_modules` or credentials.
2. In **Repository Settings → Pages**, set **Source** to **GitHub Actions**.
3. The workflow deploys on pushes to `main` (or run it manually from **Actions**). If your default branch is named differently, update the workflow branch filter.
4. Add the resulting `https://<account>.github.io` host to Firebase Auth's authorized domains.
5. Share the Pages URL with students. They enter a code and name, or use the teacher's copied link with `?code=ABC234`.

The Pages workflow intentionally copies only `index.html`, `secure.html`, `styles.css`, `firebase.css`, `firebase-app.js`, and `firebase-config.js` into the site artifact. Firebase rules and Functions need a separate Firebase CLI deploy after changes.

## Existing local quizzes

The teacher workspace offers **Import tests from this browser** when it finds reusable quiz records under the earlier `quickfire-quizzes-v2` localStorage key on the same browser origin. Importing copies test templates to Firestore and does not delete local data. Old `quickfire-attempts-v2` records are not uploaded because they are not tied to Firebase sessions. The Firebase version does not save new tests or attempts to localStorage.
