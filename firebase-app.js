import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  onAuthStateChanged,
  signInAnonymously,
  signInWithEmailAndPassword,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  orderBy,
  query,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const CODE_PATTERN = /^[A-HJ-NP-Z2-9]{6}$/;
const TYPE_LABELS = {
  choice: "Multiple choice",
  multi: "Select all that apply",
  truefalse: "True or false",
  short: "Short answer",
  number: "Number",
  written: "Written explanation",
};
const configured = firebaseConfig.apiKey && !firebaseConfig.apiKey.startsWith("YOUR_")
  && firebaseConfig.projectId && !firebaseConfig.projectId.startsWith("YOUR_")
  && firebaseConfig.appId && !firebaseConfig.appId.startsWith("YOUR_");

if (!configured) {
  const message = "Firebase is not configured yet. Follow the setup steps in README.md, then add your web app config to firebase-config.js.";
  $("#student-join-message").textContent = message;
  $("#student-join-message").classList.add("is-error");
  $("#join-session-button").disabled = true;
  $("#teacher-login-open").disabled = true;
} else {
  startQuickfire();
}

function startQuickfire() {
  const app = initializeApp(firebaseConfig);
  const auth = getAuth(app);
  const db = getFirestore(app);
  const functions = getFunctions(app, "us-central1");
  const studentApp = initializeApp(firebaseConfig, "quickfire-student");
  const studentAuth = getAuth(studentApp);
  const studentDb = getFirestore(studentApp);
  const studentFunctions = getFunctions(studentApp, "us-central1");
  const currentUrl = new URL(window.location.href);
  const codeParam = currentUrl.searchParams.get("code");
  if (codeParam) $("#student-code").value = codeParam.toUpperCase();

  let teacherUid = null;
  let tests = [];
  let selectedTest = null;
  let selectedQuestions = [];
  let editingQuestionId = null;
  let selectedSession = null;
  let activeQuiz = null;
  let activeQuestionIndex = 0;
  let activeAttemptId = null;
  let activeStudentName = "";
  let activeStartedAt = 0;
  let timerId = null;
  let answerSubmitted = false;
  let choiceSelection = new Set();
  let currentAnswers = [];
  let testDraftId = null;

  const teacherLoginDialog = $("#teacher-login-dialog");
  const studentQuizDialog = $("#student-quiz-dialog");

  function setMessage(element, text, isError = false) {
    element.textContent = text || "";
    element.classList.toggle("is-error", isError);
  }

  function explainError(error) {
    const code = error?.code || "";
    if (code.includes("permission-denied")) return "You do not have permission to do that.";
    if (code.includes("unauthenticated")) return "Sign in and try again.";
    if (code.includes("not-found")) return "That test code is not open. Check the code with your teacher.";
    if (code.includes("failed-precondition")) return error.message || "This action is not available right now.";
    if (code.includes("already-exists")) return "This answer was already submitted.";
    if (code.includes("unavailable")) return "Firebase is unreachable. Check your connection and project setup.";
    return error?.message || "Something went wrong. Please try again.";
  }

  function newId(collectionRef) { return doc(collectionRef).id; }

  function setTeacherMode(user) {
    teacherUid = user?.uid || null;
    $("#teacher-side").hidden = !teacherUid;
    $("#student-side").hidden = Boolean(teacherUid);
    $("#teacher-session-label").hidden = !teacherUid;
    $("#teacher-session-label").textContent = user?.email || "Teacher";
    $("#teacher-login-open").hidden = Boolean(teacherUid);
    $("#teacher-logout").hidden = !teacherUid;
    if (teacherUid) {
      loadTests().catch((error) => setMessage($("#teacher-message"), explainError(error), true));
      loadSessions().catch((error) => setMessage($("#teacher-message"), explainError(error), true));
    }
  }

  onAuthStateChanged(auth, async (user) => {
    if (!user) {
      setTeacherMode(null);
      return;
    }
    try {
      const teacherDoc = await getDoc(doc(db, "teacherUsers", user.uid));
      if (!teacherDoc.exists()) {
        await signOut(auth);
        setMessage($("#teacher-login-message"), "This account is not authorized as a teacher.", true);
        return;
      }
      setTeacherMode(user);
      teacherLoginDialog.close();
    } catch (error) {
      await signOut(auth);
      setMessage($("#teacher-login-message"), explainError(error), true);
    }
  });

  $("#teacher-login-open").addEventListener("click", () => {
    setMessage($("#teacher-login-message"), "");
    teacherLoginDialog.showModal();
  });
  $("#teacher-login-close").addEventListener("click", () => teacherLoginDialog.close());
  $("#teacher-login-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    setMessage($("#teacher-login-message"), "Signing in…");
    try {
      await signInWithEmailAndPassword(auth, $("#teacher-email").value.trim(), $("#teacher-password").value);
    } catch (error) {
      setMessage($("#teacher-login-message"), explainError(error), true);
    } finally {
      button.disabled = false;
    }
  });
  $("#teacher-logout").addEventListener("click", async () => {
    await signOut(auth);
    setTeacherMode(null);
  });

  function renderTypeEditor(question = null) {
    const type = $("#question-type").value;
    const host = $("#question-type-editor");
    host.replaceChildren();
    const addTextarea = (id, labelText, value = "", placeholder = "") => {
      const label = document.createElement("label");
      label.htmlFor = id;
      label.textContent = labelText;
      const textarea = document.createElement("textarea");
      textarea.id = id;
      textarea.rows = 3;
      textarea.maxLength = 2000;
      textarea.value = value;
      textarea.placeholder = placeholder;
      host.append(label, textarea);
      return textarea;
    };

    if (["choice", "multi", "truefalse"].includes(type)) {
      const choices = type === "truefalse" ? ["True", "False"] : (question?.choices || []);
      addTextarea("type-choice-list", "Answer choices (one per line)", choices.join("\n"), "Option A\nOption B\nOption C\nOption D");
      const correct = question?.correctIndices || (Number.isInteger(question?.correctIndex) ? [question.correctIndex] : []);
      addTextarea("type-correct-indices", type === "multi" ? "Correct options (letters, comma separated)" : "Correct option (letter)", correct.map((index) => String.fromCharCode(65 + index)).join(","), type === "multi" ? "A,C" : "B");
      if (type === "truefalse") $("#type-choice-list").readOnly = true;
    } else if (type === "short") {
      addTextarea("type-accepted-answers", "Accepted answers (one per line)", (question?.acceptedAnswers || []).join("\n"), "Example answer\nAlternate spelling");
    } else if (type === "number") {
      const row = document.createElement("div");
      row.className = "form-two-column cloud-type-fields";
      row.innerHTML = '<div><label for="type-correct-number">Correct number</label><input id="type-correct-number" type="number" step="any" required></div><div><label for="type-number-tolerance">Allowed tolerance</label><input id="type-number-tolerance" type="number" step="any" min="0" value="0"></div>';
      if (Number.isFinite(Number(question?.correctNumber))) row.querySelector("#type-correct-number").value = question.correctNumber;
      row.querySelector("#type-number-tolerance").value = String(question?.tolerance ?? 0);
      host.append(row);
    } else {
      const help = document.createElement("p");
      help.className = "cloud-type-help";
      help.textContent = "Students submit written answers for teacher review.";
      host.append(help);
    }
  }

  function clearQuestionEditor() {
    editingQuestionId = null;
    $("#cloud-question-form").reset();
    $("#question-form-heading").textContent = "Add a question";
    $("#save-question-button").textContent = "Add question";
    $("#cancel-question-edit").hidden = true;
    $("#question-marks").value = "2";
    $("#question-time").value = "30";
    renderTypeEditor();
  }

  function questionLabel(question) {
    const time = question.timeLimit ? `${question.timeLimit}s` : "timed by session";
    return `${TYPE_LABELS[question.type] || question.type} · ${question.marks} marks · ${time}`;
  }

  function renderQuestions() {
    const list = $("#test-question-list");
    list.replaceChildren();
    $("#selected-test-total").textContent = selectedQuestions.length ? `${selectedQuestions.length} · ${selectedQuestions.reduce((sum, q) => sum + (Number(q.marks) || 0), 0)} marks` : "0 questions";
      $("#select-test-message").hidden = Boolean(selectedTest);
      if (testDraftId) $("#select-test-message").textContent = "Save this test before adding questions.";
      else $("#select-test-message").textContent = "Choose or create a test to edit its questions.";
      $("#cloud-question-form").hidden = !selectedTest;
    $("#add-question-button").hidden = !selectedTest || Boolean(testDraftId);
    $("#test-question-list").hidden = !selectedTest;

    selectedQuestions.forEach((question, index) => {
      const row = document.createElement("article");
      row.className = "teacher-question-row cloud-question-row";
      const number = document.createElement("span");
      number.className = "teacher-question-number";
      number.textContent = String(index + 1).padStart(2, "0");
      const content = document.createElement("div");
      content.className = "teacher-question-content";
      const prompt = document.createElement("strong");
      prompt.textContent = question.prompt;
      const meta = document.createElement("span");
      meta.textContent = questionLabel(question);
      content.append(prompt, meta);
      const actions = document.createElement("div");
      actions.className = "question-actions";
      const edit = document.createElement("button");
      edit.className = "icon-button";
      edit.type = "button";
      edit.textContent = "✎";
      edit.setAttribute("aria-label", `Edit question ${index + 1}`);
      edit.addEventListener("click", () => editQuestion(question));
      const remove = document.createElement("button");
      remove.className = "icon-button";
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Delete question ${index + 1}`);
      remove.addEventListener("click", () => deleteQuestion(question.id));
      actions.append(edit, remove);
      row.append(number, content, actions);
      list.append(row);
    });
  }

  async function loadTests() {
    if (!teacherUid) return;
    const testsQuery = query(collection(db, "tests"), where("ownerUid", "==", teacherUid), orderBy("updatedAt", "desc"));
    const snapshot = await getDocs(testsQuery);
    tests = snapshot.docs.map((testDoc) => ({ id: testDoc.id, ...testDoc.data() }));
    renderTests();
  }

  function renderTests() {
    const host = $("#cloud-test-list");
    host.replaceChildren();
    $("#no-tests-message").hidden = tests.length > 0;
    const sessionSelect = $("#session-test-select");
    const selectedValue = sessionSelect.value;
    sessionSelect.replaceChildren();
    tests.forEach((test, index) => {
      const row = document.createElement("article");
      row.className = `cloud-test-row${selectedTest?.id === test.id ? " is-selected" : ""}`;
      const info = document.createElement("div");
      const title = document.createElement("button");
      title.className = "test-title-button";
      title.type = "button";
      title.textContent = test.title;
      title.addEventListener("click", () => selectTest(test.id));
      const details = document.createElement("span");
      details.textContent = `${test.questionCount || 0} questions · ${test.feedbackMode === "end" ? "feedback at end" : "immediate feedback"}`;
      info.append(title, details);
      const actions = document.createElement("div");
      actions.className = "cloud-row-actions";
      const deleteButton = document.createElement("button");
      deleteButton.className = "danger-button";
      deleteButton.type = "button";
      deleteButton.textContent = "Delete";
      deleteButton.addEventListener("click", () => deleteTest(test));
      actions.append(deleteButton);
      row.append(info, actions);
      host.append(row);

      const option = document.createElement("option");
      option.value = test.id;
      option.textContent = test.title;
      sessionSelect.append(option);
    });
    if (tests.some((test) => test.id === selectedValue)) sessionSelect.value = selectedValue;
    const legacy = parseLegacyTests();
    $("#import-local-tests").hidden = !legacy.length;
  }

  async function selectTest(testId) {
    const test = tests.find((item) => item.id === testId);
    if (!test) return;
    selectedTest = test;
    testDraftId = null;
    const questionQuery = query(collection(db, "tests", testId, "questions"), orderBy("order"));
    const questionSnapshot = await getDocs(questionQuery);
    selectedQuestions = questionSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
    $("#test-settings-form").hidden = false;
    $("#test-title-input").value = test.title;
    $("#test-feedback-mode").value = test.feedbackMode || "immediate";
    $("#test-speed-bonus").checked = test.speedBonus !== false;
    $("#test-no-time-limit").checked = test.noTimeLimit === true;
    clearQuestionEditor();
    renderQuestions();
    renderTests();
  }

  $("#new-test-button").addEventListener("click", () => {
    selectedTest = null;
    selectedQuestions = [];
    testDraftId = newId(collection(db, "tests"));
    $("#test-settings-form").hidden = false;
    $("#test-title-input").value = "";
    $("#test-feedback-mode").value = "immediate";
    $("#test-speed-bonus").checked = true;
    $("#test-no-time-limit").checked = false;
    clearQuestionEditor();
    $("#cloud-question-form").hidden = false;
    $("#add-question-button").hidden = true;
    renderQuestions();
  });

  $("#create-sample-test").addEventListener("click", async () => {
    if (!teacherUid) return;
    try {
      const result = await httpsCallable(functions, "createSampleTest")({});
      const testId = result.data.testId;
      await loadTests();
      await selectTest(testId);
      setMessage($("#teacher-message"), result.data.created ? "Sample test created with all six question types." : "Your sample test is ready.");
    } catch (error) {
      setMessage($("#teacher-message"), explainError(error), true);
    }
  });

  $("#cancel-test-edit").addEventListener("click", () => {
    testDraftId = null;
    selectedTest = null;
    selectedQuestions = [];
    $("#test-settings-form").hidden = true;
    clearQuestionEditor();
    renderQuestions();
  });

  $("#test-settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!teacherUid) return;
    const title = $("#test-title-input").value.trim();
    if (!title) return;
    const settings = {
      ownerUid: teacherUid,
      title,
      feedbackMode: $("#test-feedback-mode").value,
      speedBonus: $("#test-speed-bonus").checked,
      noTimeLimit: $("#test-no-time-limit").checked,
      questionCount: selectedQuestions.length,
      updatedAt: serverTimestamp(),
    };
    try {
      if (testDraftId) {
        settings.createdAt = serverTimestamp();
        await setDoc(doc(db, "tests", testDraftId), settings);
        selectedTest = { id: testDraftId, ...settings, updatedAt: new Date() };
        testDraftId = null;
      } else if (selectedTest) {
        await updateDoc(doc(db, "tests", selectedTest.id), settings);
        selectedTest = { ...selectedTest, ...settings };
      }
      setMessage($("#teacher-message"), "Test saved.");
      await loadTests();
      if (selectedTest) await selectTest(selectedTest.id);
    } catch (error) {
      setMessage($("#teacher-message"), explainError(error), true);
    }
  });

  $("#question-type").addEventListener("change", () => renderTypeEditor());
  $("#add-question-button").addEventListener("click", () => {
    editingQuestionId = null;
    $("#question-form-heading").textContent = "Add a question";
    $("#save-question-button").textContent = "Add question";
    $("#cancel-question-edit").hidden = true;
    $("#cloud-question-form").hidden = false;
    clearQuestionEditor();
  });

  function editQuestion(question) {
    editingQuestionId = question.id;
    $("#question-prompt").value = question.prompt || "";
    $("#question-type").value = question.type || "choice";
    $("#question-marks").value = String(question.marks || 2);
    $("#question-time").value = String(question.timeLimit || 30);
    $("#question-explanation").value = question.explanation || "";
    $("#question-option-feedback").value = (question.optionFeedback || []).join("\n");
    $("#question-guidance").value = question.teacherGuidance || "";
    $("#question-form-heading").textContent = "Edit question";
    $("#save-question-button").textContent = "Save changes";
    $("#cancel-question-edit").hidden = false;
    renderTypeEditor(question);
    $("#cloud-question-form").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function collectQuestion() {
    const type = $("#question-type").value;
    const question = {
      prompt: $("#question-prompt").value.trim(),
      type,
      marks: Number($("#question-marks").value),
      timeLimit: Number($("#question-time").value),
      explanation: $("#question-explanation").value.trim(),
      optionFeedback: $("#question-option-feedback").value.split(/\r?\n/).map((value) => value.trim()),
      teacherGuidance: $("#question-guidance").value.trim(),
    };
    if (!question.prompt) throw new Error("Enter the question text.");
    if (["choice", "multi", "truefalse"].includes(type)) {
      question.choices = type === "truefalse" ? ["True", "False"] : $("#type-choice-list").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      const letters = $("#type-correct-indices").value.toUpperCase().split(/[\s,]+/).filter(Boolean);
      question.correctIndices = [...new Set(letters.map((letter) => letter.charCodeAt(0) - 65))];
      if (type !== "truefalse" && question.choices.length < 2) throw new Error("Add at least two answer choices.");
      if (question.correctIndices.some((index) => index < 0 || index >= question.choices.length)) throw new Error("Correct options must refer to choices in the list.");
      if (type !== "multi" && question.correctIndices.length !== 1) throw new Error("Choose exactly one correct option.");
      if (type === "multi" && question.correctIndices.length < 1) throw new Error("Choose at least one correct option.");
    } else if (type === "short") {
      question.acceptedAnswers = $("#type-accepted-answers").value.split(/\r?\n/).map((value) => value.trim()).filter(Boolean);
      if (!question.acceptedAnswers.length) throw new Error("Add at least one accepted answer.");
    } else if (type === "number") {
      question.correctNumber = Number($("#type-correct-number").value);
      question.tolerance = Number($("#type-number-tolerance").value || 0);
      if (!Number.isFinite(question.correctNumber) || !Number.isFinite(question.tolerance) || question.tolerance < 0) throw new Error("Enter a valid number and a non-negative tolerance.");
    }
    return question;
  }

  $("#cloud-question-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const message = $("#question-editor-message");
    try {
      if (!selectedTest && !testDraftId) throw new Error("Save or create a test before adding questions.");
      const question = collectQuestion();
      const testId = selectedTest?.id || testDraftId;
      const questionCollection = collection(db, "tests", testId, "questions");
      if (editingQuestionId) {
        const oldQuestion = selectedQuestions.find((item) => item.id === editingQuestionId);
        await updateDoc(doc(questionCollection, editingQuestionId), { ...question, order: oldQuestion.order, updatedAt: serverTimestamp() });
      } else {
        const questionRef = doc(questionCollection);
        await setDoc(questionRef, { ...question, order: selectedQuestions.length, createdAt: serverTimestamp() });
      }
      if (testDraftId) {
        selectedQuestions = await readQuestionDocs(testDraftId);
      } else {
        selectedQuestions = await readQuestionDocs(testId);
      }
      clearQuestionEditor();
      renderQuestions();
      setMessage(message, "Question saved.");
      if (selectedTest) {
        await updateDoc(doc(db, "tests", testId), { questionCount: selectedQuestions.length, updatedAt: serverTimestamp() });
        await loadTests();
      }
    } catch (error) {
      setMessage(message, explainError(error), true);
    }
  });

  async function readQuestionDocs(testId) {
    const snapshot = await getDocs(query(collection(db, "tests", testId, "questions"), orderBy("order")));
    return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  }

  $("#cancel-question-edit").addEventListener("click", clearQuestionEditor);

  async function deleteQuestion(questionId) {
    if (!selectedTest || !confirm("Delete this question? Existing sessions keep their original snapshot.")) return;
    try {
      await deleteDoc(doc(db, "tests", selectedTest.id, "questions", questionId));
      const batch = writeBatch(db);
      selectedQuestions.filter((question) => question.id !== questionId).forEach((question, index) => {
        batch.update(doc(db, "tests", selectedTest.id, "questions", question.id), { order: index });
      });
      batch.update(doc(db, "tests", selectedTest.id), { questionCount: selectedQuestions.length - 1, updatedAt: serverTimestamp() });
      await batch.commit();
      await selectTest(selectedTest.id);
      await loadTests();
    } catch (error) {
      setMessage($("#teacher-message"), explainError(error), true);
    }
  }

  async function deleteTest(test) {
    if (!confirm(`Delete “${test.title}”? Existing sessions keep their snapshots.`)) return;
    try {
      const questionSnapshot = await getDocs(collection(db, "tests", test.id, "questions"));
      for (let offset = 0; offset < questionSnapshot.docs.length; offset += 450) {
        const batch = writeBatch(db);
        questionSnapshot.docs.slice(offset, offset + 450).forEach((item) => batch.delete(item.ref));
        await batch.commit();
      }
      await deleteDoc(doc(db, "tests", test.id));
      if (selectedTest?.id === test.id) {
        selectedTest = null;
        selectedQuestions = [];
        $("#test-settings-form").hidden = true;
        clearQuestionEditor();
        renderQuestions();
      }
      await loadTests();
    } catch (error) {
      setMessage($("#teacher-message"), explainError(error), true);
    }
  }

  $("#create-session-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const testId = $("#session-test-select").value;
    if (!testId) return;
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    try {
      const result = await httpsCallable(functions, "createSession")({ testId });
      setMessage($("#teacher-message"), `Session opened. Join code: ${result.data.joinCode}`);
      await loadSessions();
    } catch (error) {
      setMessage($("#teacher-message"), explainError(error), true);
    } finally {
      button.disabled = false;
    }
  });

  async function loadSessions() {
    if (!teacherUid) return;
    const sessionQuery = query(collection(db, "sessions"), where("ownerUid", "==", teacherUid), orderBy("createdAt", "desc"));
    const snapshot = await getDocs(sessionQuery);
    renderSessions(snapshot.docs.map((item) => ({ id: item.id, ...item.data() })));
  }

  function renderSessions(sessions) {
    const host = $("#session-list");
    host.replaceChildren();
    $("#no-sessions-message").hidden = sessions.length > 0;
    sessions.forEach((session) => {
      const row = document.createElement("article");
      row.className = "cloud-session-row";
      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = session.title;
      const code = document.createElement("span");
      code.className = "session-code";
      code.textContent = session.joinCode;
      const status = document.createElement("span");
      status.className = `session-status${session.status === "closed" ? " is-closed" : ""}`;
      status.textContent = session.status;
      info.append(title, code, status);
      const actions = document.createElement("div");
      actions.className = "cloud-row-actions";
      const copyLink = document.createElement("button");
      copyLink.type = "button";
      copyLink.textContent = "Copy link";
      copyLink.addEventListener("click", async () => {
        const link = new URL("./", window.location.href);
        link.searchParams.set("code", session.joinCode);
        await navigator.clipboard.writeText(link.href);
        setMessage($("#teacher-message"), "Join link copied.");
      });
      const copyCode = document.createElement("button");
      copyCode.type = "button";
      copyCode.textContent = "Copy code";
      copyCode.addEventListener("click", async () => {
        await navigator.clipboard.writeText(session.joinCode);
        setMessage($("#teacher-message"), "Join code copied.");
      });
      const toggle = document.createElement("button");
      toggle.type = "button";
      toggle.textContent = session.status === "open" ? "Close" : "Reopen";
      toggle.addEventListener("click", async () => {
        try {
          await updateDoc(doc(db, "sessions", session.id), { status: session.status === "open" ? "closed" : "open" });
          await loadSessions();
        } catch (error) {
          setMessage($("#teacher-message"), explainError(error), true);
        }
      });
      const results = document.createElement("button");
      results.type = "button";
      results.textContent = "Results";
      results.addEventListener("click", () => loadSessionResults(session));
      actions.append(copyLink, copyCode, toggle, results);
      row.append(info, actions);
      host.append(row);
    });
  }

  let currentResultRows = [];
  async function loadSessionResults(session) {
    selectedSession = session;
    $("#session-results-panel").hidden = false;
    $("#session-results-title").textContent = `Students · ${session.title} (${session.joinCode})`;
    const body = $("#session-attempts-body");
    body.replaceChildren();
    const attemptSnapshot = await getDocs(query(collection(db, "sessions", session.id, "attempts"), orderBy("createdAt")));
    currentResultRows = [];
    for (const attemptDoc of attemptSnapshot.docs) {
      const attempt = { id: attemptDoc.id, ...attemptDoc.data() };
      const responses = await getDocs(collection(db, "sessions", session.id, "attempts", attempt.id, "responses"));
      const responseItems = responses.docs.map((item) => ({ id: item.id, ...item.data() }));
      currentResultRows.push({ attempt, responses: responseItems });
      const row = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = attempt.studentName;
      const score = document.createElement("td");
      score.textContent = `${attempt.score || 0} / ${attempt.maxMarks}`;
      const status = document.createElement("td");
      const pending = responseItems.filter((response) => response.pending).length;
      status.textContent = attempt.status === "submitted" ? pending ? `${pending} to mark` : "Submitted" : "In progress";
      const submitted = document.createElement("td");
      submitted.textContent = attempt.submittedAt?.toDate ? attempt.submittedAt.toDate().toLocaleString() : "—";
      const written = document.createElement("td");
      written.className = "written-review-cell";
      responseItems.filter((response) => response.type === "written").forEach((response) => {
        const item = document.createElement("div");
        const answer = document.createElement("p");
        answer.textContent = response.answer || "No response";
        item.append(answer);
        if (response.pending) {
          const select = document.createElement("select");
          select.setAttribute("aria-label", `Marks for written answer out of ${response.maxMarks}`);
          for (let mark = 0; mark <= response.maxMarks; mark += 1) {
            const option = document.createElement("option");
            option.value = String(mark);
            option.textContent = `${mark}/${response.maxMarks}`;
            select.append(option);
          }
          const save = document.createElement("button");
          save.type = "button";
          save.className = "grade-written";
          save.textContent = "Save mark";
          save.addEventListener("click", async () => {
            try {
              await httpsCallable(functions, "gradeWrittenResponse")({ sessionId: session.id, attemptId: attempt.id, questionId: response.questionId, mark: Number(select.value) });
              await loadSessionResults(session);
            } catch (error) {
              setMessage($("#teacher-message"), explainError(error), true);
            }
          });
          item.append(select, save);
        } else {
          const mark = document.createElement("span");
          mark.textContent = `${response.score}/${response.maxMarks} marks`;
          item.append(mark);
        }
        written.append(item);
      });
      row.append(name, score, status, submitted, written);
      body.append(row);
    }
    $("#no-attempts-message").hidden = currentResultRows.length > 0;
  }

  $("#export-csv-button").addEventListener("click", () => {
    if (!selectedSession) return;
    const fields = ["session_code", "student_name", "score", "max_marks", "status", "submitted_at", "written_answers"];
    const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const lines = [fields.map(quote).join(",")];
    currentResultRows.forEach(({ attempt, responses }) => {
      const written = responses.filter((response) => response.type === "written")
        .map((response) => `${response.prompt}: ${response.answer || "No response"} (${response.score || 0}/${response.maxMarks})`).join(" | ");
      lines.push([
        selectedSession.joinCode,
        attempt.studentName,
        attempt.score || 0,
        attempt.maxMarks,
        attempt.status,
        attempt.submittedAt?.toDate ? attempt.submittedAt.toDate().toISOString() : "",
        written,
      ].map(quote).join(","));
    });
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `quickfire-${selectedSession.joinCode}-results.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  function parseLegacyTests() {
    try {
      const quizzes = JSON.parse(localStorage.getItem("quickfire-quizzes-v2") || "[]");
      return Array.isArray(quizzes) ? quizzes.filter((quiz) => quiz && Array.isArray(quiz.questions)) : [];
    } catch {
      return [];
    }
  }

  $("#import-local-tests").addEventListener("click", async () => {
    if (!teacherUid) return;
    const legacy = parseLegacyTests();
    const importedIds = new Set(tests.map((test) => test.legacyId).filter(Boolean));
    let importedCount = 0;
    try {
      for (const oldQuiz of legacy) {
        if (importedIds.has(oldQuiz.id)) continue;
        const testRef = await addDoc(collection(db, "tests"), {
          ownerUid: teacherUid,
          title: cleanClientText(oldQuiz.title, 100) || "Imported test",
          legacyId: oldQuiz.id,
          feedbackMode: oldQuiz.feedbackMode === "end" ? "end" : "immediate",
          speedBonus: oldQuiz.speedBonus !== false,
          noTimeLimit: oldQuiz.noTimeLimit === true,
          questionCount: oldQuiz.questions.length,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        const batch = writeBatch(db);
        oldQuiz.questions.forEach((question, order) => {
          const id = String(question.id || `legacy-${order}`);
          const legacyIndices = Array.isArray(question.correctIndices) ? question.correctIndices : Number.isInteger(question.correctIndex) ? [question.correctIndex] : [];
          const oldType = ["choice", "multi", "truefalse", "short", "number", "written"].includes(question.type) ? question.type : "choice";
          batch.set(doc(db, "tests", testRef.id, "questions", id), {
            prompt: cleanClientText(question.prompt, 1000),
            type: oldType,
            marks: Number(question.marks) || 2,
            timeLimit: Number(question.timeLimit) || (oldType === "written" ? 120 : 30),
            choices: oldType === "truefalse" ? ["True", "False"] : Array.isArray(question.choices) ? question.choices : [],
            correctIndices: legacyIndices,
            acceptedAnswers: Array.isArray(question.acceptedAnswers) ? question.acceptedAnswers : [],
            correctNumber: Number.isFinite(Number(question.correctNumber)) ? Number(question.correctNumber) : null,
            tolerance: Number(question.tolerance) || 0,
            explanation: cleanClientText(question.explanation, 2000),
            optionFeedback: Array.isArray(question.optionFeedback) ? question.optionFeedback : [],
            teacherGuidance: cleanClientText(question.guidance || question.teacherGuidance, 2000),
            order,
          });
        });
        await batch.commit();
        importedCount += 1;
      }
      await loadTests();
      setMessage($("#teacher-message"), `${importedCount} local ${importedCount === 1 ? "test" : "tests"} imported. Local data was not deleted.`);
    } catch (error) {
      setMessage($("#teacher-message"), explainError(error), true);
    }
  });

  function cleanClientText(value, max) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }

  $("#student-join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = $("#student-code").value.trim().toUpperCase();
    const name = $("#student-display-name").value.trim();
    if (!CODE_PATTERN.test(code)) {
      setMessage($("#student-join-message"), "Enter a 6-character code. 0, O, 1, and I are not used.", true);
      return;
    }
    if (!name || name.length > 60) {
      setMessage($("#student-join-message"), "Enter your name (up to 60 characters).", true);
      return;
    }
    const button = $("#join-session-button");
    button.disabled = true;
    setMessage($("#student-join-message"), "Checking code…");
    try {
      if (studentAuth.currentUser) await signOut(studentAuth);
      const credential = await signInAnonymously(studentAuth);
      const joined = await httpsCallable(studentFunctions, "joinSession")({ code });
      const session = { id: joined.data.sessionId, ...joined.data };
      const attemptRef = doc(studentDb, "sessions", session.id, "attempts", credential.user.uid);
      await setDoc(attemptRef, {
        ownerUid: credential.user.uid,
        studentName: name,
        status: "inProgress",
        score: 0,
        maxMarks: session.maxMarks,
        createdAt: serverTimestamp(),
      });
      activeQuiz = {
        ...session,
        questions: session.questions,
      };
      activeAttemptId = credential.user.uid;
      activeStudentName = name;
      activeQuestionIndex = 0;
      currentAnswers = [];
      $("#active-session-code").textContent = `JOIN CODE · ${session.joinCode}`;
      $("#active-session-title").textContent = `${session.title} · ${name}`;
      $("#student-question-screen").hidden = false;
      $("#student-result-screen").hidden = true;
      const firstQuestion = await httpsCallable(studentFunctions, "startQuestion")({ sessionId: session.id, questionId: session.questions[0].id });
      renderStudentQuestion(firstQuestion.data.startedAt);
      studentQuizDialog.showModal();
      setMessage($("#student-join-message"), "");
    } catch (error) {
      setMessage($("#student-join-message"), explainError(error), true);
    } finally {
      button.disabled = false;
    }
  });

  function getCurrentQuestion() { return activeQuiz.questions[activeQuestionIndex]; }

  function renderStudentQuestion(serverStartedAt = Date.now()) {
    stopStudentTimer();
    answerSubmitted = false;
    choiceSelection = new Set();
    const question = getCurrentQuestion();
    const host = $("#student-answer-controls");
    host.replaceChildren();
    $("#student-question-count").textContent = `QUESTION ${activeQuestionIndex + 1} / ${activeQuiz.questions.length}`;
    $("#student-question-marks").textContent = `UP TO ${question.marks} MARKS`;
    $("#student-question-progress").style.width = `${activeQuestionIndex / activeQuiz.questions.length * 100}%`;
    $("#student-question-prompt").textContent = question.prompt;
    $("#student-question-type").textContent = TYPE_LABELS[question.type] || "QUESTION";
    $("#student-timer-row").hidden = activeQuiz.noTimeLimit || !question.timeLimit;
    $("#student-time-text").textContent = question.timeLimit ? `Time allowed: ${formatSeconds(question.timeLimit)}` : "No time limit";
    $("#student-timer").textContent = question.timeLimit ? formatSeconds(question.timeLimit) : "";
    $("#student-answer-feedback").textContent = "";
    $("#student-answer-feedback").className = "modal-answer-feedback";
    $("#student-submit-answer").disabled = question.type === "choice" || question.type === "truefalse" ? true : true;
    $("#student-submit-answer").dataset.advance = "false";
    $("#student-submit-answer").textContent = "Submit answer";

    if (["choice", "multi", "truefalse"].includes(question.type)) {
      if (question.type === "multi") {
        const hint = document.createElement("p");
        hint.className = "choice-select-hint";
        hint.textContent = "Select every answer that applies, then submit.";
        host.append(hint);
      }
      const choices = question.type === "truefalse" ? ["True", "False"] : question.choices;
      choices.forEach((choice, index) => {
        const button = document.createElement("button");
        button.className = "modal-answer-option student-answer-option";
        button.type = "button";
        const key = document.createElement("span");
        key.className = "modal-option-key";
        key.textContent = String.fromCharCode(65 + index);
        const label = document.createElement("span");
        label.textContent = choice;
        button.append(key, label);
        button.addEventListener("click", () => {
          if (question.type === "multi") {
            if (choiceSelection.has(index)) choiceSelection.delete(index);
            else choiceSelection.add(index);
            button.classList.toggle("is-selected", choiceSelection.has(index));
          } else {
            choiceSelection = new Set([index]);
            $$(".student-answer-option", host).forEach((other) => other.classList.toggle("is-selected", other === button));
          }
          $("#student-submit-answer").disabled = choiceSelection.size === 0;
        });
        host.append(button);
      });
    } else {
      const input = document.createElement(question.type === "written" ? "textarea" : "input");
      input.className = `student-answer-input${question.type === "written" ? " text-long" : ""}`;
      input.id = "student-answer-input";
      input.autocomplete = "off";
      input.placeholder = question.type === "written" ? "Write your explanation…" : question.type === "number" ? "Enter a number" : "Type your answer";
      if (question.type === "written") input.rows = 5;
      if (question.type === "number") { input.type = "number"; input.step = "any"; }
      input.addEventListener("input", () => { $("#student-submit-answer").disabled = !input.value.trim(); });
      host.append(input);
      $("#student-submit-answer").disabled = true;
    }
    activeStartedAt = serverStartedAt;
    if (!activeQuiz.noTimeLimit && question.timeLimit) startStudentTimer(question.timeLimit, serverStartedAt);
  }

  function formatSeconds(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    return remainder ? `${minutes}:${String(remainder).padStart(2, "0")}` : `${minutes}:00`;
  }

  function startStudentTimer(seconds, serverStartedAt) {
    const deadline = serverStartedAt + seconds * 1000;
    const timer = () => {
      const remaining = Math.max(0, deadline - Date.now());
      $("#student-timer").textContent = formatSeconds(Math.ceil(remaining / 1000));
      if (remaining <= 0) {
        stopStudentTimer();
        submitCurrentAnswer(true).catch((error) => {
          answerSubmitted = false;
          setMessage($("#student-answer-feedback"), explainError(error), true);
        });
      }
    };
    timer();
    timerId = setInterval(timer, 200);
  }

  function stopStudentTimer() {
    clearInterval(timerId);
    timerId = null;
  }

  function answerValue() {
    const type = getCurrentQuestion().type;
    if (type === "multi") return [...choiceSelection].sort((a, b) => a - b);
    if (type === "choice" || type === "truefalse") return [...choiceSelection][0];
    const value = $("#student-answer-input")?.value.trim() || "";
    return type === "number" && value !== "" ? Number(value) : value;
  }

  async function submitCurrentAnswer(timedOut = false) {
    if (answerSubmitted) return;
    const question = getCurrentQuestion();
    const answer = timedOut ? null : answerValue();
    if (!timedOut && (answer === "" || answer === undefined || (Array.isArray(answer) && !answer.length))) {
      setMessage($("#student-answer-feedback"), "Choose or enter an answer first.", true);
      return;
    }
    answerSubmitted = true;
    stopStudentTimer();
    $("#student-submit-answer").disabled = true;
    setMessage($("#student-answer-feedback"), "Checking answer…");
    try {
      const result = await httpsCallable(studentFunctions, "submitAnswer")({
        sessionId: activeQuiz.id,
        questionId: question.id,
        answer,
      });
      currentAnswers.push({ questionId: question.id, answer, ...result.data });
      const feedback = $("#student-answer-feedback");
      feedback.textContent = result.data.feedback || "Answer recorded.";
      feedback.className = `modal-answer-feedback${result.data.pending ? " is-pending" : result.data.correct === true ? " is-correct" : result.data.correct === false ? " is-wrong" : " is-muted"}`;
      $$(".student-answer-option").forEach((button) => { button.disabled = true; });
      const input = $("#student-answer-input");
      if (input) input.disabled = true;
      const next = $("#student-submit-answer");
      next.disabled = false;
      next.innerHTML = activeQuestionIndex === activeQuiz.questions.length - 1 ? 'Finish test <span aria-hidden="true">→</span>' : 'Continue <span aria-hidden="true">→</span>';
      next.dataset.advance = "true";
    } catch (error) {
      answerSubmitted = false;
      const submit = $("#student-submit-answer");
      submit.dataset.advance = "false";
      submit.disabled = false;
      setMessage($("#student-answer-feedback"), explainError(error), true);
    }
  }

  $("#student-submit-answer").addEventListener("click", async () => {
    const button = $("#student-submit-answer");
    if (button.dataset.advance === "true") {
      button.dataset.advance = "false";
      if (activeQuestionIndex < activeQuiz.questions.length - 1) {
        const nextIndex = activeQuestionIndex + 1;
        const nextQuestion = activeQuiz.questions[nextIndex];
        button.disabled = true;
        setMessage($("#student-answer-feedback"), "Loading next question…");
        try {
          const startResult = await httpsCallable(studentFunctions, "startQuestion")({ sessionId: activeQuiz.id, questionId: nextQuestion.id });
          activeQuestionIndex = nextIndex;
          renderStudentQuestion(startResult.data.startedAt);
        } catch (error) {
          button.disabled = false;
          button.dataset.advance = "true";
          setMessage($("#student-answer-feedback"), explainError(error), true);
        }
      } else {
        await finishStudentAttempt();
      }
      return;
    }
    await submitCurrentAnswer();
  });

  async function finishStudentAttempt() {
    $("#student-submit-answer").disabled = true;
    setMessage($("#student-answer-feedback"), "Saving your result…");
    try {
      const result = await httpsCallable(studentFunctions, "finishAttempt")({ sessionId: activeQuiz.id });
      stopStudentTimer();
      $("#student-question-screen").hidden = true;
      $("#student-result-screen").hidden = false;
      $("#student-result-summary").textContent = `${result.data.score} / ${result.data.maxMarks} marks · ${result.data.pending} written ${result.data.pending === 1 ? "answer" : "answers"} waiting for teacher review.`;
      renderStudentEndFeedback(result.data.feedback || []);
    } catch (error) {
      $("#student-submit-answer").disabled = false;
      setMessage($("#student-answer-feedback"), explainError(error), true);
    }
  }

  function renderStudentEndFeedback(items) {
    const host = $("#student-end-feedback");
    host.replaceChildren();
    host.hidden = !items.length;
    items.forEach((item, index) => {
      const article = document.createElement("article");
      article.className = "end-feedback-item";
      const title = document.createElement("strong");
      title.textContent = `${index + 1}. ${item.prompt}`;
      article.append(title);
      if (item.type !== "written") {
        const status = document.createElement("p");
        status.textContent = item.correct ? `Correct · ${item.score}/${item.maxMarks} marks` : `Incorrect · 0/${item.maxMarks} marks${item.correctAnswer ? ` · Answer: ${item.correctAnswer}` : ""}`;
        article.append(status);
      }
      const options = (item.selectedIndices || []).map((selected) => item.optionFeedback?.[selected]).filter(Boolean);
      [...options, item.explanation].filter(Boolean).forEach((text) => {
        const paragraph = document.createElement("p");
        paragraph.textContent = text;
        article.append(paragraph);
      });
      if (article.children.length > 1) host.append(article);
    });
    host.hidden = host.children.length === 0;
  }

  $("#exit-session").addEventListener("click", () => {
    stopStudentTimer();
    studentQuizDialog.close();
  });
  $("#student-done-button").addEventListener("click", async () => {
    studentQuizDialog.close();
    if (studentAuth.currentUser?.isAnonymous) await signOut(studentAuth);
    activeQuiz = null;
    activeAttemptId = null;
    $("#student-result-screen").hidden = true;
    $("#student-question-screen").hidden = false;
  });
  studentQuizDialog.addEventListener("close", stopStudentTimer);

  async function loadSessionResults(session) {
    selectedSession = session;
    $("#session-results-panel").hidden = false;
    $("#session-results-title").textContent = `Students · ${session.title} (${session.joinCode})`;
    const body = $("#session-attempts-body");
    body.replaceChildren();
    const attemptsSnapshot = await getDocs(query(collection(db, "sessions", session.id, "attempts"), orderBy("createdAt")));
    currentResultRows = [];
    for (const attemptDoc of attemptsSnapshot.docs) {
      const attempt = { id: attemptDoc.id, ...attemptDoc.data() };
      const responsesSnapshot = await getDocs(collection(db, "sessions", session.id, "attempts", attempt.id, "responses"));
      const responses = responsesSnapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      currentResultRows.push({ attempt, responses });
      const row = document.createElement("tr");
      const name = document.createElement("td");
      name.textContent = attempt.studentName;
      const score = document.createElement("td");
      score.textContent = `${attempt.score || 0} / ${attempt.maxMarks}`;
      const status = document.createElement("td");
      const pending = responses.filter((response) => response.pending).length;
      status.textContent = attempt.status === "submitted" ? pending ? `${pending} to mark` : "Submitted" : "In progress";
      const submitted = document.createElement("td");
      submitted.textContent = attempt.submittedAt?.toDate ? attempt.submittedAt.toDate().toLocaleString() : "—";
      const written = document.createElement("td");
      written.className = "written-review-cell";
      responses.filter((response) => response.type === "written").forEach((response) => {
        const item = document.createElement("div");
        const answer = document.createElement("p");
        answer.textContent = response.answer || "No response";
        item.append(answer);
        if (response.pending) {
          const select = document.createElement("select");
          select.setAttribute("aria-label", `Marks for written answer out of ${response.maxMarks}`);
          for (let mark = 0; mark <= response.maxMarks; mark += 1) {
            const option = document.createElement("option");
            option.value = String(mark);
            option.textContent = `${mark}/${response.maxMarks}`;
            select.append(option);
          }
          const save = document.createElement("button");
          save.type = "button";
          save.className = "grade-written";
          save.textContent = "Save mark";
          save.addEventListener("click", async () => {
            try {
              await httpsCallable(functions, "gradeWrittenResponse")({ sessionId: session.id, attemptId: attempt.id, questionId: response.questionId, mark: Number(select.value) });
              await loadSessionResults(session);
            } catch (error) {
              setMessage($("#teacher-message"), explainError(error), true);
            }
          });
          item.append(select, save);
        } else {
          const grade = document.createElement("span");
          grade.textContent = `${response.score}/${response.maxMarks} marks`;
          item.append(grade);
        }
        written.append(item);
      });
      row.append(name, score, status, submitted, written);
      body.append(row);
    }
    $("#no-attempts-message").hidden = currentResultRows.length > 0;
  }

  $("#export-csv-button").addEventListener("click", () => {
    if (!selectedSession) return;
    const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const lines = [["join_code", "student_name", "score", "max_marks", "status", "submitted_at", "written_answers"].map(quote).join(",")];
    currentResultRows.forEach(({ attempt, responses }) => {
      const written = responses.filter((response) => response.type === "written")
        .map((response) => `${response.prompt}: ${response.answer || "No response"} (${response.score || 0}/${response.maxMarks})`).join(" | ");
      lines.push([selectedSession.joinCode, attempt.studentName, attempt.score || 0, attempt.maxMarks, attempt.status,
        attempt.submittedAt?.toDate ? attempt.submittedAt.toDate().toISOString() : "", written].map(quote).join(","));
    });
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `quickfire-${selectedSession.joinCode}-results.csv`;
    link.click();
    URL.revokeObjectURL(url);
  });

  function parseLegacyTests() {
    try {
      const old = JSON.parse(localStorage.getItem("quickfire-quizzes-v2") || "[]");
      return Array.isArray(old) ? old.filter((test) => test && Array.isArray(test.questions)) : [];
    } catch {
      return [];
    }
  }

  $("#import-local-tests").addEventListener("click", async () => {
    if (!teacherUid) return;
    try {
      const oldTests = parseLegacyTests();
      const importedLegacyIds = new Set(tests.map((test) => test.legacyId).filter(Boolean));
      let count = 0;
      for (const oldTest of oldTests) {
        if (importedLegacyIds.has(oldTest.id)) continue;
        const testRef = await addDoc(collection(db, "tests"), {
          ownerUid: teacherUid,
          title: cleanClientText(oldTest.title, 100) || "Imported test",
          legacyId: oldTest.id,
          feedbackMode: oldTest.feedbackMode === "end" ? "end" : "immediate",
          speedBonus: oldTest.speedBonus !== false,
          noTimeLimit: oldTest.noTimeLimit === true,
          questionCount: oldTest.questions.length,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        const batch = writeBatch(db);
        oldTest.questions.forEach((question, order) => {
          const type = ["choice", "multi", "truefalse", "short", "number", "written"].includes(question.type) ? question.type : "choice";
          const correctIndices = Array.isArray(question.correctIndices) ? question.correctIndices : Number.isInteger(question.correctIndex) ? [question.correctIndex] : [];
          batch.set(doc(db, "tests", testRef.id, "questions", `legacy-${order}`), {
            prompt: cleanClientText(question.prompt, 1000), type, marks: Number(question.marks) || 2,
            timeLimit: Number(question.timeLimit) || (type === "written" ? 120 : 30),
            choices: type === "truefalse" ? ["True", "False"] : Array.isArray(question.choices) ? question.choices : [],
            correctIndices, acceptedAnswers: Array.isArray(question.acceptedAnswers) ? question.acceptedAnswers : [],
            correctNumber: Number.isFinite(Number(question.correctNumber)) ? Number(question.correctNumber) : null,
            tolerance: Number(question.tolerance) || 0, explanation: cleanClientText(question.explanation, 2000),
            optionFeedback: Array.isArray(question.optionFeedback) ? question.optionFeedback : [],
            teacherGuidance: cleanClientText(question.guidance || question.teacherGuidance, 2000), order,
          });
        });
        await batch.commit();
        count += 1;
      }
      await loadTests();
      setMessage($("#teacher-message"), `${count} local ${count === 1 ? "test" : "tests"} imported. The original local data was not removed.`);
    } catch (error) {
      setMessage($("#teacher-message"), explainError(error), true);
    }
  });

  function cleanClientText(value, maxLength) { return typeof value === "string" ? value.trim().slice(0, maxLength) : ""; }

  renderTypeEditor();
}
