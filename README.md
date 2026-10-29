# Quickfire

Quickfire is a static GitHub Pages quiz site backed by Firebase Authentication and Cloud Firestore. Its modular Firebase Web SDK imports load directly from Google's CDN; there is no frontend build step or Cloud Functions backend.

## Spark-plan behavior

- Teachers sign in with Email/Password and must have an administrator-created `teacherUsers/{uid}` document.
- Students use Firebase Anonymous Authentication and join with a 12-character code.
- The browser writes quiz sessions and answers directly to Firestore. Security Rules allow students to read only public question documents and submit their own responses.
- Correct answers remain in teacher-only `answerKeys` documents. To keep them private without a trusted backend, this Spark version does **not** automatically grade answers; teachers review and mark each response.
- The question timer is only displayed in the student's browser. Without a trusted server, students can bypass it. Do not use this version for high-stakes or proctored tests.
- 12-character codes reduce guessing risk, but direct client access has no server-side rate limiting.

## Firestore structure

- `teacherUsers/{uid}`: administrator-managed teacher allowlist. The app cannot grant teacher access.
- `tests/{testId}` and `tests/{testId}/questions/{questionId}`: teacher-owned reusable tests and their answer keys.
- `sessionCodes/{code}`: 12-character code-to-session mapping. Students may get a single code document but cannot list codes.
- `sessions/{sessionId}`: session metadata, owner, status, and maximum marks.
- `sessions/{sessionId}/publicQuestions/{questionId}`: prompts/options available to signed-in anonymous students while the session is open.
- `sessions/{sessionId}/answerKeys/{questionId}`: private answer-key snapshots readable only by the session's teacher.
- `sessions/{sessionId}/attempts/{anonymousUid}`: student name and submission status.
- `sessions/{sessionId}/attempts/{anonymousUid}/responses/{questionId}`: submitted answer and teacher-entered mark. Students cannot read response documents.

The rules in `firestore.rules` enforce these access boundaries. Never leave the database in **Test Mode**: Test Mode permits broad access and can expose or allow modification of student data and answer keys.

## Firebase setup (no Node.js or CLI required)

1. In the [Firebase Console](https://console.firebase.google.com/), select project `quikfire-1`. Keep it on the **Spark** plan if you want to avoid linking a billing account. Firebase services still have usage quotas and limits.
2. In **Authentication → Sign-in method**, enable **Email/Password** and **Anonymous**.
3. In **Authentication → Users**, create your teacher account. Copy its UID.
4. In **Firestore → Data**, create `teacherUsers/{UID}` (replace `{UID}` with the copied UID). Add a Boolean field such as `authorized: true`. Do this before publishing the restrictive rules because the rules intentionally block clients from creating teacher access.
5. In **Firestore → Rules**, replace the Test Mode rules with the complete contents of `firestore.rules`, then click **Publish**. Do this before using the live site. The app's answer keys and student data are not safe while Test Mode rules remain active.
6. In **Project settings → Your apps**, register a Web App and confirm its configuration. The config in `firebase-config.js` uses project `quikfire-1`; its `authDomain` should be `quikfire-1.firebaseapp.com`. Web app config values, including the API key, are public identifiers, not server credentials.
7. In **Authentication → Settings → Authorized domains**, add `derro-g.github.io` (domain only, no path).
8. Publish the site change from the project folder:

   ```powershell
   git add -A
   git commit -m "Connect Quickfire to Firebase Spark"
   git push
   ```

   GitHub Pages will redeploy from `main`. No Functions deployment, Node.js install, or frontend build is needed.
9. Open [the deployed site](https://derro-g.github.io/copilot-playground/), sign in as the teacher, create a test, and open a session. Use its 12-character code in a separate private/incognito window to verify the student flow.

If Firestore reports a missing index for a teacher query, follow the error's link in the browser to create the requested index in the Firebase Console.

## GitHub Pages

The workflow at `.github/workflows/pages.yml` publishes only the static website files. Firestore Rules are not deployed by that workflow; after changing `firestore.rules`, publish the file manually in **Firestore → Rules**.

## Existing local quizzes

The teacher workspace offers **Import tests from this browser** when it finds reusable quiz records under the earlier `quickfire-quizzes-v2` localStorage key on the same browser origin. Importing copies test templates to Firestore and does not delete local data. Old `quickfire-attempts-v2` records are not uploaded because they are not tied to Firebase sessions. The Firebase version does not save new tests or attempts to localStorage.
