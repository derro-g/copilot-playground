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
  onSnapshot,
  orderBy,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  updateDoc,
  where,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const CODE_PATTERN = /^(?:[A-HJ-NP-Z2-9]{6}|[A-HJ-NP-Z2-9]{12})$/;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const SUPPORTED_QUESTION_TYPES = ["choice", "multi", "truefalse"];
function makeJoinCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}
const TYPE_LABELS = {
  choice: "Multiple choice",
  multi: "Select all that apply",
  truefalse: "True or false",
};
function gradeAnswer(question, answer) {
  const expected = Array.isArray(question.correctIndices)
    ? [...new Set(question.correctIndices)].sort((a, b) => a - b)
    : Number.isInteger(question.correctIndex) ? [question.correctIndex] : [];
  const selected = question.type === "multi" && Array.isArray(answer)
    ? [...new Set(answer)].sort((a, b) => a - b)
    : Number.isInteger(answer) ? [answer] : [];
  const correct = expected.length > 0
    && selected.length === expected.length
    && selected.every((index, position) => index === expected[position]);
  const choices = question.type === "truefalse" ? ["True", "False"] : question.choices || [];
  return {
    correct,
    score: correct ? Number(question.marks) || 0 : 0,
    maxMarks: Number(question.marks) || 0,
    correctAnswer: expected.map((index) => choices[index]).filter(Boolean).join(", "),
    selectedIndices: selected,
  };
}
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
  const studentApp = initializeApp(firebaseConfig, "quickfire-student");
  const studentAuth = getAuth(studentApp);
  const studentDb = getFirestore(studentApp);
  const currentUrl = new URL(window.location.href);
  const codeParam = currentUrl.searchParams.get("code");
  if (codeParam) $("#student-code").value = codeParam.toUpperCase();

  let teacherUid = null;
  let tests = [];
  let selectedTest = null;
  let selectedQuestions = [];
  let editingQuestionId = null;
  let selectedSession = null;
  let loadedSessions = [];
  let resultsOpenSessionId = null;
  let activeQuiz = null;
  let activeQuestionIndex = 0;
  let activeAttemptId = null;
  let currentResultSessionId = null;
  let timerId = null;
  let answerSubmitted = false;
  let currentAnswerSaved = false;
  let currentQuestionTimedOut = false;
  let choiceSelection = new Set();
  let currentAnswers = [];
  let testDraftId = null;
  let questionEditorChoices = [];
  let questionEditorCorrect = new Set();
  let questionEditorType = "choice";
  let attemptSubmitted = false;
  let sessionListUnsubscribe = null;
  const sessionAttemptUnsubscribers = new Map();
  const sessionAttemptCounts = new Map();
  let resultsUnsubscribe = null;

  const teacherLoginDialog = $("#teacher-login-dialog");
  const studentQuizDialog = $("#student-quiz-dialog");
  const questionEditorDialog = $("#question-editor-dialog");

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
    if (!teacherUid && sessionListUnsubscribe) {
      sessionListUnsubscribe();
      sessionListUnsubscribe = null;
    }
    if (!teacherUid) {
      sessionAttemptUnsubscribers.forEach((unsubscribe) => unsubscribe());
      sessionAttemptUnsubscribers.clear();
      sessionAttemptCounts.clear();
    }
    if (!teacherUid && resultsUnsubscribe) {
      resultsUnsubscribe();
      resultsUnsubscribe = null;
    }
    $("#teacher-side").hidden = !teacherUid;
    $("#student-side").hidden = Boolean(teacherUid);
    $("#teacher-session-label").hidden = !teacherUid;
    $("#teacher-session-label").textContent = user?.email || "Teacher";
    $("#teacher-login-open").hidden = Boolean(teacherUid);
    $("#teacher-logout").hidden = !teacherUid;
    if (teacherUid) {
      loadTests().catch((error) => setMessage($("#teacher-message"), explainError(error), true));
      loadSessions();
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
    if (question) {
      questionEditorChoices = [...(question.choices || [])];
      questionEditorCorrect = new Set(question.correctIndices || []);
    } else if (type === "truefalse") {
      questionEditorChoices = ["True", "False"];
      questionEditorCorrect.clear();
    } else if (questionEditorType === "truefalse") {
      questionEditorChoices = ["", "", "", ""];
      questionEditorCorrect.clear();
    } else if (questionEditorChoices.length < 2) {
      questionEditorChoices = ["", "", "", ""];
      questionEditorCorrect.clear();
    }

    questionEditorType = type;
    if (type === "truefalse") questionEditorChoices = ["True", "False"];
    if (questionEditorChoices.length < 2) questionEditorChoices = ["", ""];
    if (type !== "multi" && questionEditorCorrect.size > 1) {
      questionEditorCorrect = new Set([questionEditorCorrect.values().next().value]);
    }

    const help = document.createElement("p");
    help.className = "cloud-type-help";
    help.textContent = type === "multi"
      ? "Select every correct answer. Students will choose the same boxes."
      : "Mark one correct answer. Students will choose one box.";
    host.append(help);

    questionEditorChoices.forEach((choice, index) => {
      const row = document.createElement("div");
      row.className = "question-choice-editor-row";
      const letter = document.createElement("span");
      letter.className = "question-choice-letter";
      letter.textContent = String.fromCharCode(65 + index);
      const input = document.createElement("input");
      input.className = "question-choice-input";
      input.type = "text";
      input.maxLength = 200;
      input.value = choice;
      input.disabled = type === "truefalse";
      input.placeholder = `Answer ${String.fromCharCode(65 + index)}`;
      input.setAttribute("aria-label", `Answer ${String.fromCharCode(65 + index)}`);
      input.addEventListener("input", () => { questionEditorChoices[index] = input.value; });
      const correctLabel = document.createElement("label");
      correctLabel.className = "question-choice-correct";
      const correct = document.createElement("input");
      correct.type = type === "multi" ? "checkbox" : "radio";
      correct.name = "question-correct-answer";
      correct.checked = questionEditorCorrect.has(index);
      correct.setAttribute("aria-label", `Mark answer ${String.fromCharCode(65 + index)} correct`);
      correct.addEventListener("change", () => {
        if (type !== "multi") questionEditorCorrect.clear();
        if (correct.checked) questionEditorCorrect.add(index);
        else questionEditorCorrect.delete(index);
        if (type !== "multi") {
          $$(".question-choice-correct input", host).forEach((choiceInput) => {
            choiceInput.checked = choiceInput === correct;
          });
        }
      });
      correctLabel.append(correct, document.createTextNode("Correct"));
      row.append(letter, input, correctLabel);

      if (type !== "truefalse") {
        const remove = document.createElement("button");
        remove.className = "question-choice-remove";
        remove.type = "button";
        remove.textContent = "×";
        remove.setAttribute("aria-label", `Remove answer ${String.fromCharCode(65 + index)}`);
        remove.disabled = questionEditorChoices.length <= 2;
        remove.addEventListener("click", () => {
          questionEditorChoices.splice(index, 1);
          questionEditorCorrect = new Set([...questionEditorCorrect]
            .filter((correctIndex) => correctIndex !== index)
            .map((correctIndex) => correctIndex > index ? correctIndex - 1 : correctIndex));
          renderTypeEditor();
        });
        row.append(remove);
      }
      host.append(row);
    });

    if (type !== "truefalse") {
      const addChoice = document.createElement("button");
      addChoice.className = "secondary-button question-choice-add";
      addChoice.type = "button";
      addChoice.textContent = "Add answer choice";
      addChoice.disabled = questionEditorChoices.length >= 20;
      addChoice.addEventListener("click", () => {
        questionEditorChoices.push("");
        renderTypeEditor();
        $$(".question-choice-input", host).at(-1)?.focus();
      });
      host.append(addChoice);
    }
  }

  function clearQuestionEditor() {
    editingQuestionId = null;
    $("#cloud-question-form").reset();
    $("#question-form-heading").textContent = "Add a question";
    $("#save-question-button").textContent = "Add question";
    $("#question-marks").value = "2";
    $("#question-time").value = "30";
    questionEditorChoices = ["", "", "", ""];
    questionEditorCorrect = new Set();
    questionEditorType = $("#question-type").value;
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
    const hasSelectedTest = Boolean(selectedTest || testDraftId);
    $("#open-question-builder-button").hidden = !hasSelectedTest;
    $("#test-question-list").hidden = !hasSelectedTest;
    $("#question-overview-empty").hidden = selectedQuestions.length > 0;

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
    tests.forEach((test) => {
      const row = document.createElement("article");
      row.className = `cloud-test-row${selectedTest?.id === test.id ? " is-selected" : ""}`;
      const info = document.createElement("div");
      const title = document.createElement("button");
      title.className = "test-title-button";
      title.type = "button";
      title.textContent = test.title;
      title.addEventListener("click", () => selectTest(test.id));
      const details = document.createElement("span");
      details.textContent = `${test.questionCount || 0} questions · automatic scoring`;
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
    $("#test-speed-bonus").checked = false;
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
    $("#test-speed-bonus").checked = false;
    $("#test-no-time-limit").checked = false;
    clearQuestionEditor();
    renderQuestions();
  });

  $("#cancel-test-edit").addEventListener("click", () => {
    testDraftId = null;
    selectedTest = null;
    selectedQuestions = [];
    $("#test-settings-form").hidden = true;
    clearQuestionEditor();
    renderQuestions();
  });

  async function saveTestSettings() {
    if (!teacherUid) throw new Error("Sign in as a teacher before saving this test.");
    const title = $("#test-title-input").value.trim();
    if (!title) throw new Error("Enter a test title.");
    const settings = {
      ownerUid: teacherUid,
      title,
      feedbackMode: "end",
      speedBonus: false,
      noTimeLimit: $("#test-no-time-limit").checked,
      questionCount: selectedQuestions.length,
    };
    if (testDraftId) {
      const testId = testDraftId;
      await setDoc(doc(db, "tests", testId), {
        ...settings,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      selectedTest = { id: testId, ...settings, createdAt: new Date(), updatedAt: new Date() };
      testDraftId = null;
    } else if (selectedTest) {
      await updateDoc(doc(db, "tests", selectedTest.id), {
        ...settings,
        updatedAt: serverTimestamp(),
      });
      selectedTest = { ...selectedTest, ...settings, updatedAt: new Date() };
    } else {
      throw new Error("Create or select a test before saving.");
    }
    await loadTests();
  }

  $("#test-settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      const creatingTest = Boolean(testDraftId);
      await saveTestSettings();
      setMessage($("#teacher-message"), "Test saved.");
      renderQuestions();
      if (creatingTest) openNewQuestionEditor();
    } catch (error) {
      setMessage($("#teacher-message"), explainError(error), true);
    }
  });

  $("#finish-test-button").addEventListener("click", async () => {
    try {
      if ($("#question-prompt").value.trim()) await saveCurrentQuestion();
      else if (editingQuestionId) throw new Error("Enter the question text before finishing the test.");
      if (!selectedQuestions.length) throw new Error("Add at least one question before finishing this test.");
      await saveTestSettings();
      renderQuestions();
      questionEditorDialog.close();
      setMessage($("#teacher-message"), "Test saved and ready to use.");
    } catch (error) {
      setMessage($("#question-editor-message"), explainError(error), true);
    }
  });

  $("#question-type").addEventListener("change", () => renderTypeEditor());
  function openNewQuestionEditor() {
    editingQuestionId = null;
    $("#question-form-heading").textContent = "Add a question";
    $("#save-question-button").textContent = "Add question";
    clearQuestionEditor();
    setMessage($("#question-editor-message"), "");
    questionEditorDialog.showModal();
  }

  $("#open-question-builder-button").addEventListener("click", openNewQuestionEditor);

  $("#close-question-editor").addEventListener("click", () => questionEditorDialog.close());

  questionEditorDialog.addEventListener("close", () => {
    if (!$("#question-prompt").value.trim()) clearQuestionEditor();
  });

  function editQuestion(question) {
    if (!SUPPORTED_QUESTION_TYPES.includes(question.type)) {
      setMessage($("#teacher-message"), "This older question type cannot be auto-marked. Delete it and create a multiple-choice, select-all, or true/false question.", true);
      return;
    }
    editingQuestionId = question.id;
    $("#question-prompt").value = question.prompt || "";
    $("#question-type").value = question.type || "choice";
    $("#question-marks").value = String(question.marks || 2);
    $("#question-time").value = String(question.timeLimit || 30);
    $("#question-form-heading").textContent = "Edit question";
    $("#save-question-button").textContent = "Save changes";
    renderQuestions();
    renderTypeEditor(question);
    setMessage($("#question-editor-message"), "");
    questionEditorDialog.showModal();
  }

  function collectQuestion() {
    const type = $("#question-type").value;
    const question = {
      prompt: $("#question-prompt").value.trim(),
      type,
      marks: Number($("#question-marks").value),
      timeLimit: Number($("#question-time").value),
    };
    if (!question.prompt) throw new Error("Enter the question text.");
    if (!SUPPORTED_QUESTION_TYPES.includes(type)) throw new Error("Choose a supported automatic-marking question type.");
    question.choices = type === "truefalse"
      ? ["True", "False"]
      : questionEditorChoices.map((value) => value.trim());
    if (question.choices.some((choice) => !choice)) throw new Error("Fill in each answer box or remove the empty choice.");
    question.correctIndices = [...questionEditorCorrect]
      .filter((index) => index >= 0 && index < question.choices.length);
    if (type !== "truefalse" && question.choices.length < 2) throw new Error("Add at least two answer choices.");
    if (question.choices.length > 20) throw new Error("Use at most 20 answer choices.");
    if (question.correctIndices.some((index) => index < 0 || index >= question.choices.length)) throw new Error("Correct options must refer to choices in the list.");
    if (type !== "multi" && question.correctIndices.length !== 1) throw new Error("Choose exactly one correct option.");
    if (type === "multi" && question.correctIndices.length < 1) throw new Error("Choose at least one correct option.");
    return question;
  }

  async function saveCurrentQuestion() {
    if (!selectedTest && !testDraftId) throw new Error("Save or create a test before adding questions.");
    const question = collectQuestion();
    await saveTestSettings();
    const testId = selectedTest.id;
    const questionCollection = collection(db, "tests", testId, "questions");
    if (editingQuestionId) {
      const oldQuestion = selectedQuestions.find((item) => item.id === editingQuestionId);
      if (!oldQuestion) throw new Error("This question is no longer available. Reopen the test and try again.");
      await updateDoc(doc(questionCollection, editingQuestionId), {
        ...question,
        order: oldQuestion.order,
        updatedAt: serverTimestamp(),
      });
    } else {
      const questionRef = doc(questionCollection);
      await setDoc(questionRef, {
        ...question,
        order: selectedQuestions.length,
        createdAt: serverTimestamp(),
      });
    }
    selectedQuestions = await readQuestionDocs(testId);
    await updateDoc(doc(db, "tests", testId), {
      questionCount: selectedQuestions.length,
      updatedAt: serverTimestamp(),
    });
    selectedTest = { ...selectedTest, questionCount: selectedQuestions.length };
    await loadTests();
    clearQuestionEditor();
    renderQuestions();
  }

  $("#cloud-question-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      await saveCurrentQuestion();
      setMessage($("#question-editor-message"), "Question saved. Add another, or finish and save the test.");
    } catch (error) {
      setMessage($("#question-editor-message"), explainError(error), true);
    }
  });

  async function readQuestionDocs(testId) {
    const snapshot = await getDocs(query(collection(db, "tests", testId, "questions"), orderBy("order")));
    return snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
  }

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
      const test = tests.find((item) => item.id === testId);
      if (!test || test.ownerUid !== teacherUid) throw new Error("Choose one of your own tests.");
      const questionSnapshot = await getDocs(query(collection(db, "tests", testId, "questions"), orderBy("order")));
      if (questionSnapshot.empty) throw new Error("Add at least one question before opening a session.");
      if (questionSnapshot.size > 200) throw new Error("A session can contain at most 200 questions.");

      const sessionRef = doc(collection(db, "sessions"));
      const sessionQuestions = questionSnapshot.docs.map((item, order) => {
        const question = item.data();
        if (!SUPPORTED_QUESTION_TYPES.includes(question.type)) {
          throw new Error(`Question ${order + 1} is not an auto-markable option question. Remove it or change it to multiple choice, select all, or true/false.`);
        }
        const marks = Number(question.marks) || 2;
        if (!Number.isSafeInteger(marks) || marks < 1 || marks > 100) {
          throw new Error(`Question ${order + 1} has an invalid mark value. Edit it and try again.`);
        }
        return {
          id: item.id,
          order,
          prompt: question.prompt,
          type: question.type,
          marks,
          timeLimit: test.noTimeLimit ? null : Number(question.timeLimit) || 30,
          choices: question.type === "truefalse" ? ["True", "False"] : Array.isArray(question.choices) ? question.choices : [],
          answerKey: question,
        };
      });
      const maxMarks = sessionQuestions.reduce((sum, question) => sum + question.marks, 0);
      const sessionSettings = {
        title: test.title,
        ownerUid: teacherUid,
        testId,
        feedbackMode: "end",
        speedBonus: false,
        noTimeLimit: test.noTimeLimit === true,
        maxMarks,
        questionCount: sessionQuestions.length,
        status: "creating",
        createdAt: serverTimestamp(),
      };
      let joinCode = "";
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const candidate = makeJoinCode();
        const codeRef = doc(db, "sessionCodes", candidate);
        try {
          await runTransaction(db, async (transaction) => {
            const existing = await transaction.get(codeRef);
            if (existing.exists()) throw new Error("join-code-collision");
            transaction.set(sessionRef, { ...sessionSettings, joinCode: candidate });
            transaction.set(codeRef, { sessionId: sessionRef.id, createdAt: serverTimestamp() });
          });
          joinCode = candidate;
          break;
        } catch (error) {
          if (error.message !== "join-code-collision") throw error;
        }
      }
      if (!joinCode) throw new Error("Could not reserve a unique join code. Please try again.");
      const batch = writeBatch(db);
      sessionQuestions.forEach(({ answerKey, ...publicQuestion }) => {
        batch.set(doc(db, "sessions", sessionRef.id, "publicQuestions", publicQuestion.id), publicQuestion);
        batch.set(doc(db, "sessions", sessionRef.id, "answerKeys", publicQuestion.id), {
          ...answerKey,
          ...publicQuestion,
          id: publicQuestion.id,
        });
      });
      batch.update(sessionRef, { status: "open" });
      try {
        await batch.commit();
      } catch (error) {
        try {
          await deleteDoc(doc(db, "sessionCodes", joinCode));
          await deleteDoc(sessionRef);
        } catch (cleanupError) {
          throw new Error(`${explainError(error)} The incomplete session could not be cleaned up: ${explainError(cleanupError)}`);
        }
        throw error;
      }
      setMessage($("#teacher-message"), `Session opened. Join code: ${joinCode}`);
    } catch (error) {
      setMessage($("#teacher-message"), explainError(error), true);
    } finally {
      button.disabled = false;
    }
  });

  function loadSessions() {
    if (!teacherUid) return;
    const sessionQuery = query(collection(db, "sessions"), where("ownerUid", "==", teacherUid), orderBy("createdAt", "desc"));
    if (sessionListUnsubscribe) sessionListUnsubscribe();
    sessionListUnsubscribe = onSnapshot(sessionQuery, (snapshot) => {
      loadedSessions = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      renderSessions(loadedSessions);
    }, (error) => setMessage($("#teacher-message"), explainError(error), true));
  }

  function renderSessions(sessions) {
    const host = $("#session-list");
    host.replaceChildren();
    $("#no-sessions-message").hidden = sessions.length > 0;
    const sessionIds = new Set(sessions.map((session) => session.id));
    sessionAttemptUnsubscribers.forEach((unsubscribe, sessionId) => {
      if (!sessionIds.has(sessionId)) {
        unsubscribe();
        sessionAttemptUnsubscribers.delete(sessionId);
        sessionAttemptCounts.delete(sessionId);
      }
    });
    sessions.forEach((session) => {
      const row = document.createElement("article");
      row.className = "cloud-session-row";
      row.dataset.sessionId = session.id;
      const info = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = session.title;
      const code = document.createElement("span");
      code.className = "session-code";
      code.textContent = session.joinCode;
      const status = document.createElement("span");
      status.className = `session-status${session.status === "closed" ? " is-closed" : ""}`;
      status.textContent = session.status;
      const attempts = document.createElement("span");
      attempts.className = "session-attempt-count";
      const attemptCount = sessionAttemptCounts.get(session.id);
      attempts.textContent = attemptCount === undefined
        ? "Loading attempts…"
        : `${attemptCount} ${attemptCount === 1 ? "attempt" : "attempts"}`;
      const created = document.createElement("span");
      created.className = "session-created-date";
      const createdAt = session.createdAt?.toDate?.();
      created.textContent = createdAt ? `Created ${createdAt.toLocaleDateString()}` : "Creation date unavailable";
      info.append(title, code, status, attempts, created);
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
          loadSessions();
        } catch (error) {
          setMessage($("#teacher-message"), explainError(error), true);
        }
      });
      const results = document.createElement("button");
      results.type = "button";
      results.textContent = resultsOpenSessionId === session.id ? "Hide results" : "Results";
      results.setAttribute("aria-expanded", String(resultsOpenSessionId === session.id));
      results.addEventListener("click", () => {
        resultsOpenSessionId = resultsOpenSessionId === session.id ? null : session.id;
        if (resultsUnsubscribe) {
          resultsUnsubscribe();
          resultsUnsubscribe = null;
        }
        renderSessions(loadedSessions);
      });
      actions.append(copyLink, copyCode, toggle, results);
      row.append(info, actions);
      const resultsPanel = document.createElement("section");
      resultsPanel.className = "review-panel session-results-panel";
      resultsPanel.hidden = resultsOpenSessionId !== session.id;
      resultsPanel.setAttribute("aria-label", `Results for ${session.title}`);
      const resultsHeading = document.createElement("div");
      resultsHeading.className = "section-heading";
      const resultsTitle = document.createElement("h3");
      resultsTitle.className = "session-results-title";
      resultsTitle.textContent = `Students · ${session.title} (${session.joinCode})`;
      const exportButton = document.createElement("button");
      exportButton.className = "small-button export-csv-button";
      exportButton.type = "button";
      exportButton.textContent = "Export CSV";
      exportButton.addEventListener("click", exportSessionCsv);
      resultsHeading.append(resultsTitle, exportButton);
      const tableWrap = document.createElement("div");
      tableWrap.className = "attempt-table-wrap";
      const table = document.createElement("table");
      table.className = "attempt-table";
      table.innerHTML = "<thead><tr><th>Student</th><th>Score</th><th>Status</th><th>Submitted</th><th>Answers and automatic marks</th></tr></thead>";
      const body = document.createElement("tbody");
      body.className = "session-attempts-body";
      table.append(body);
      tableWrap.append(table);
      const empty = document.createElement("p");
      empty.className = "empty-state no-attempts-message";
      empty.textContent = "No students have joined this session yet.";
      resultsPanel.append(resultsHeading, tableWrap, empty);
      row.append(resultsPanel);
      host.append(row);
      if (resultsOpenSessionId === session.id) loadSessionResults(session, resultsPanel);
      if (!sessionAttemptUnsubscribers.has(session.id)) {
        const unsubscribe = onSnapshot(
          collection(db, "sessions", session.id, "attempts"),
          (snapshot) => {
            sessionAttemptCounts.set(session.id, snapshot.size);
            const currentRow = $$(".cloud-session-row", host).find((item) => item.dataset.sessionId === session.id);
            const attemptLabel = currentRow && $(".session-attempt-count", currentRow);
            if (attemptLabel) {
              attemptLabel.textContent = `${snapshot.size} ${snapshot.size === 1 ? "attempt" : "attempts"}`;
            }
          },
          (error) => {
            setMessage($("#teacher-message"), explainError(error), true);
            const currentRow = $$(".cloud-session-row", host).find((item) => item.dataset.sessionId === session.id);
            const attemptLabel = currentRow && $(".session-attempt-count", currentRow);
            if (attemptLabel) attemptLabel.textContent = "Attempts unavailable";
          },
        );
        sessionAttemptUnsubscribers.set(session.id, unsubscribe);
      }
    });
  }

  let currentResultRows = [];
  function cleanClientText(value, max) { return typeof value === "string" ? value.trim().slice(0, max) : ""; }

  $("#student-join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const code = $("#student-code").value.trim().toUpperCase();
    const name = $("#student-display-name").value.trim();
    if (!CODE_PATTERN.test(code)) {
      setMessage($("#student-join-message"), "Enter a 6-character code. Older sessions may still use 12 characters; 0, O, 1, and I are not used.", true);
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
      let codeSnapshot;
      try {
        codeSnapshot = await getDoc(doc(studentDb, "sessionCodes", code));
      } catch (error) {
        if (error?.code?.includes("permission-denied")) throw new Error("That code is not open. Check it with your teacher.");
        throw error;
      }
      if (!codeSnapshot.exists()) throw new Error("That code is not open. Check it with your teacher.");
      let sessionSnapshot;
      try {
        sessionSnapshot = await getDoc(doc(studentDb, "sessions", codeSnapshot.data().sessionId));
      } catch (error) {
        if (error?.code?.includes("permission-denied")) throw new Error("That code is not open. Check it with your teacher.");
        throw error;
      }
      if (!sessionSnapshot.exists() || sessionSnapshot.data().status !== "open") {
        throw new Error("That code is not open. Check it with your teacher.");
      }
      const questionsSnapshot = await getDocs(query(
        collection(studentDb, "sessions", sessionSnapshot.id, "publicQuestions"),
        orderBy("order"),
      ));
      if (questionsSnapshot.empty) throw new Error("This session has no questions yet.");
      const session = {
        id: sessionSnapshot.id,
        ...sessionSnapshot.data(),
        questions: questionsSnapshot.docs.map((item) => ({ id: item.id, ...item.data() })),
      };
      if (session.questions.some((question) => !SUPPORTED_QUESTION_TYPES.includes(question.type))) {
        throw new Error("This session has an older question type that cannot be auto-marked. Ask the teacher to create a new option-based session.");
      }
      const attemptRef = doc(studentDb, "sessions", session.id, "attempts", credential.user.uid);
      await setDoc(attemptRef, {
        ownerUid: credential.user.uid,
        studentName: name,
        status: "inProgress",
        createdAt: serverTimestamp(),
      });
      activeQuiz = {
        ...session,
        questions: session.questions,
      };
      activeAttemptId = credential.user.uid;
      activeQuestionIndex = 0;
      currentAnswers = [];
      attemptSubmitted = false;
      $("#active-session-code").textContent = `JOIN CODE · ${session.joinCode}`;
      $("#active-session-title").textContent = `${session.title} · ${name}`;
      $("#student-question-screen").hidden = false;
      $("#student-result-screen").hidden = true;
      renderStudentQuestion(Date.now());
      studentQuizDialog.showModal();
      setMessage($("#student-join-message"), "");
    } catch (error) {
      setMessage($("#student-join-message"), explainError(error), true);
    } finally {
      button.disabled = false;
    }
  });

  function getCurrentQuestion() { return activeQuiz.questions[activeQuestionIndex]; }

  function renderStudentQuestion(startedAt = Date.now()) {
    stopStudentTimer();
    answerSubmitted = false;
    currentAnswerSaved = false;
    currentQuestionTimedOut = false;
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
    $("#student-answer-feedback").textContent = "Choose an answer to stop the timer, then press Next.";
    $("#student-answer-feedback").className = "modal-answer-feedback";
    $("#student-submit-answer").disabled = true;
    $("#student-submit-answer").textContent = "Select an answer";

    if (["choice", "multi", "truefalse"].includes(question.type)) {
      if (question.type === "multi") {
        const hint = document.createElement("p");
        hint.className = "choice-select-hint";
        hint.textContent = "The timer stops after your first selection. Select all that apply, then press Next.";
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
          if (choiceSelection.size) {
            stopStudentTimer();
            $("#student-time-text").textContent = "Timer paused";
          }
          const next = $("#student-submit-answer");
          next.disabled = choiceSelection.size === 0;
          next.innerHTML = activeQuestionIndex === activeQuiz.questions.length - 1
            ? 'Finish test <span aria-hidden="true">→</span>'
            : 'Next <span aria-hidden="true">→</span>';
        });
        host.append(button);
      });
    } else {
      throw new Error("This session contains an unsupported question type. Ask the teacher to create a new option-based session.");
    }
    if (!activeQuiz.noTimeLimit && question.timeLimit) startStudentTimer(question.timeLimit, startedAt);
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
        $("#student-time-text").textContent = "Time is up";
        currentQuestionTimedOut = true;
        $$(".student-answer-option").forEach((button) => { button.disabled = true; });
        $("#student-submit-answer").textContent = "Saving…";
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
    throw new Error("This session contains an unsupported question type.");
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
    setMessage($("#student-answer-feedback"), "Saving your answer…");
    try {
      await setDoc(doc(studentDb, "sessions", activeQuiz.id, "attempts", activeAttemptId, "responses", question.id), {
        questionId: question.id,
        prompt: question.prompt,
        type: question.type,
        answer,
        maxMarks: question.marks,
        submittedAt: serverTimestamp(),
      });
      currentAnswerSaved = true;
      currentAnswers.push({ questionId: question.id, answer });
      const feedback = $("#student-answer-feedback");
      feedback.textContent = "";
      feedback.className = "modal-answer-feedback";
      if (activeQuestionIndex < activeQuiz.questions.length - 1) {
        activeQuestionIndex += 1;
        renderStudentQuestion(Date.now());
      } else {
        await finishStudentAttempt();
      }
    } catch (error) {
      answerSubmitted = false;
      const submit = $("#student-submit-answer");
      submit.disabled = false;
      if (timedOut) submit.textContent = "Retry save";
      setMessage($("#student-answer-feedback"), explainError(error), true);
    }
  }

  $("#student-submit-answer").addEventListener("click", async () => {
    if (currentAnswerSaved && activeQuestionIndex === activeQuiz.questions.length - 1) {
      await finishStudentAttempt();
    } else {
      await submitCurrentAnswer(currentQuestionTimedOut);
    }
  });

  async function finishStudentAttempt() {
    $("#student-submit-answer").disabled = true;
    $("#student-result-retry").disabled = true;
    setMessage($("#student-answer-feedback"), "Saving your result…");
    try {
      if (!attemptSubmitted) {
        const attemptRef = doc(studentDb, "sessions", activeQuiz.id, "attempts", activeAttemptId);
        try {
          await updateDoc(attemptRef, {
            status: "submitted",
            submittedAt: serverTimestamp(),
          });
        } catch (error) {
          const attemptSnapshot = await getDoc(attemptRef);
          if (!attemptSnapshot.exists() || attemptSnapshot.data().status !== "submitted") throw error;
        }
        attemptSubmitted = true;
      }
      stopStudentTimer();
      $("#student-question-screen").hidden = true;
      $("#student-result-screen").hidden = false;
      $("#student-result-score").textContent = "…";
      $("#student-result-summary").textContent = "Calculating your total marks";
      $("#student-result-error").textContent = "";
      $("#student-result-retry").hidden = true;
      const answersByQuestion = new Map(currentAnswers.map((item) => [item.questionId, item.answer]));
      const results = await Promise.all(activeQuiz.questions.map(async (question) => {
        const keySnapshot = await getDoc(doc(studentDb, "sessions", activeQuiz.id, "answerKeys", question.id));
        if (!keySnapshot.exists()) throw new Error("The answer key for this session is unavailable.");
        const result = gradeAnswer(keySnapshot.data(), answersByQuestion.get(question.id));
        return { prompt: question.prompt, type: question.type, ...result };
      }));
      const score = results.reduce((sum, result) => sum + result.score, 0);
      const correctCount = results.filter((result) => result.correct).length;
      $("#student-result-score").textContent = `${score} / ${activeQuiz.maxMarks}`;
      $("#student-result-summary").textContent = `Your total marks · ${correctCount} of ${results.length} correct`;
      renderStudentEndFeedback(results);
      $("#student-result-retry").disabled = false;
    } catch (error) {
      if (attemptSubmitted) {
        stopStudentTimer();
        $("#student-question-screen").hidden = true;
        $("#student-result-screen").hidden = false;
        $("#student-result-score").textContent = "—";
        $("#student-result-summary").textContent = "Your answers were submitted, but we couldn't calculate the score.";
        setMessage($("#student-result-error"), explainError(error), true);
        $("#student-result-retry").hidden = false;
        $("#student-result-retry").disabled = false;
      } else {
        const submit = $("#student-submit-answer");
        submit.disabled = false;
        submit.textContent = "Retry finish";
        setMessage($("#student-answer-feedback"), explainError(error), true);
        $("#student-result-retry").disabled = false;
      }
    }
  }

  $("#student-result-retry").addEventListener("click", finishStudentAttempt);

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
      const status = document.createElement("p");
      status.textContent = item.correct
        ? `Correct · ${item.score}/${item.maxMarks} marks`
        : `Incorrect · 0/${item.maxMarks} marks${item.correctAnswer ? ` · Correct answer: ${item.correctAnswer}` : ""}`;
      article.append(status);
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

  function loadSessionResults(session, panel) {
    selectedSession = session;
    currentResultSessionId = session.id;
    currentResultRows = [];
    const body = $(".session-attempts-body", panel);
    const emptyMessage = $(".no-attempts-message", panel);
    body.replaceChildren();
    if (resultsUnsubscribe) resultsUnsubscribe();
    const attemptsQuery = query(collection(db, "sessions", session.id, "attempts"), orderBy("createdAt"));
    resultsUnsubscribe = onSnapshot(attemptsQuery, async (attemptsSnapshot) => {
      try {
        if (!panel.isConnected || resultsOpenSessionId !== session.id) return;
        body.replaceChildren();
        currentResultRows = [];
        for (const attemptDoc of attemptsSnapshot.docs) {
          const attempt = { id: attemptDoc.id, ...attemptDoc.data() };
          const responsesSnapshot = await getDocs(collection(db, "sessions", session.id, "attempts", attempt.id, "responses"));
          if (!panel.isConnected || resultsOpenSessionId !== session.id) return;
          const responses = await Promise.all(responsesSnapshot.docs.map(async (item) => {
            const response = { id: item.id, ...item.data() };
            const answerKeySnapshot = await getDoc(doc(db, "sessions", session.id, "answerKeys", response.id));
            if (!answerKeySnapshot.exists()) throw new Error("An answer key is missing for this session.");
            const answerKey = answerKeySnapshot.data();
            const grade = gradeAnswer(answerKey, response.answer);
            const choices = answerKey.type === "truefalse" ? ["True", "False"] : answerKey.choices || [];
            return {
              ...response,
              ...grade,
              answerLabel: Array.isArray(response.answer)
                ? response.answer.map((index) => choices[index]).filter(Boolean).join(", ")
                : Number.isInteger(response.answer) ? choices[response.answer] || "" : "No answer",
            };
          }));
          if (!panel.isConnected || resultsOpenSessionId !== session.id) return;
          currentResultRows.push({ attempt, responses });
          const row = document.createElement("tr");
          const name = document.createElement("td");
          name.textContent = attempt.studentName;
          const score = document.createElement("td");
          const earned = responses.reduce((sum, response) => sum + (Number(response.score) || 0), 0);
          score.textContent = `${earned} / ${session.maxMarks}`;
          const status = document.createElement("td");
          const correctCount = responses.filter((response) => response.correct).length;
          status.textContent = attempt.status === "submitted" ? `${correctCount}/${session.questionCount} correct` : "In progress";
          const submitted = document.createElement("td");
          submitted.textContent = attempt.submittedAt?.toDate ? attempt.submittedAt.toDate().toLocaleString() : "—";
          const answers = document.createElement("td");
          answers.className = "answer-review-cell";
          responses.forEach((response) => {
            const item = document.createElement("div");
            const prompt = document.createElement("strong");
            prompt.textContent = response.prompt;
            const answer = document.createElement("p");
            answer.textContent = `${response.answerLabel || "No answer"} · ${response.correct ? "Correct" : `Incorrect${response.correctAnswer ? ` · Correct answer: ${response.correctAnswer}` : ""}`} (${response.score}/${response.maxMarks})`;
            item.append(prompt, answer);
            answers.append(item);
          });
          row.append(name, score, status, submitted, answers);
          body.append(row);
        }
        emptyMessage.hidden = currentResultRows.length > 0;
      } catch (error) {
        setMessage($("#teacher-message"), explainError(error), true);
      }
    }, (error) => setMessage($("#teacher-message"), explainError(error), true));
  }

  function exportSessionCsv(event) {
    const panel = event.currentTarget.closest(".session-results-panel");
    const row = panel?.closest(".cloud-session-row");
    const session = loadedSessions.find((item) => item.id === row?.dataset.sessionId);
    if (!session) throw new Error("Could not find the session for this export.");
    if (!selectedSession || currentResultSessionId !== session.id) return;
    const quote = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const lines = [["join_code", "student_name", "score", "max_marks", "status", "submitted_at", "answers"].map(quote).join(",")];
    currentResultRows.forEach(({ attempt, responses }) => {
      const answers = responses
        .map((response) => `${response.prompt}: ${response.answerLabel || "No answer"} (${response.score}/${response.maxMarks})`).join(" | ");
      lines.push([session.joinCode, attempt.studentName,
        responses.reduce((sum, response) => sum + (Number(response.score) || 0), 0), session.maxMarks, attempt.status,
        attempt.submittedAt?.toDate ? attempt.submittedAt.toDate().toISOString() : "", answers].map(quote).join(","));
    });
    const blob = new Blob([lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `quickfire-${session.joinCode}-results.csv`;
    link.click();
    URL.revokeObjectURL(url);
  }

  function parseLegacyTests() {
    try {
      const old = JSON.parse(localStorage.getItem("quickfire-quizzes-v2") || "[]");
      return Array.isArray(old) ? old.filter((test) => test && Array.isArray(test.questions)) : [];
    } catch {
      return [];
    }
  }

  function normalizeLegacyQuestion(question, order) {
    if (!question || !SUPPORTED_QUESTION_TYPES.includes(question.type)) return null;
    const prompt = cleanClientText(question.prompt, 1000);
    if (!prompt) return null;
    const type = question.type;
    const choices = type === "truefalse"
      ? ["True", "False"]
      : Array.isArray(question.choices)
        ? question.choices.map((choice) => cleanClientText(choice, 200)).filter(Boolean).slice(0, 20)
        : [];
    const correctIndices = Array.isArray(question.correctIndices)
      ? [...new Set(question.correctIndices.filter(Number.isInteger))]
      : Number.isInteger(question.correctIndex) ? [question.correctIndex] : [];
    if (type !== "truefalse" && choices.length < 2) return null;
    if (correctIndices.length < 1 || correctIndices.some((index) => index < 0 || index >= choices.length)) return null;
    if (type !== "multi" && correctIndices.length !== 1) return null;
    const marks = Number(question.marks);
    return {
      prompt,
      type,
      marks: Number.isSafeInteger(marks) && marks >= 1 && marks <= 100 ? marks : 2,
      timeLimit: Number.isSafeInteger(Number(question.timeLimit)) && Number(question.timeLimit) > 0
        ? Number(question.timeLimit)
        : 30,
      choices,
      correctIndices,
      order,
    };
  }

  $("#import-local-tests").addEventListener("click", async () => {
    if (!teacherUid) return;
    try {
      const oldTests = parseLegacyTests();
      const importedLegacyIds = new Set(tests.map((test) => test.legacyId).filter(Boolean));
      let count = 0;
      let skippedQuestions = 0;
      for (const oldTest of oldTests) {
        if (importedLegacyIds.has(oldTest.id)) continue;
        const questions = oldTest.questions
          .map((question, order) => normalizeLegacyQuestion(question, order))
          .filter(Boolean);
        skippedQuestions += oldTest.questions.length - questions.length;
        if (!questions.length) continue;
        const testRef = await addDoc(collection(db, "tests"), {
          ownerUid: teacherUid,
          title: cleanClientText(oldTest.title, 100) || "Imported test",
          legacyId: oldTest.id,
          feedbackMode: "end",
          speedBonus: false,
          noTimeLimit: oldTest.noTimeLimit === true,
          questionCount: questions.length,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        const batch = writeBatch(db);
        questions.forEach((question) => {
          batch.set(doc(db, "tests", testRef.id, "questions", `legacy-${question.order}`), question);
        });
        await batch.commit();
        count += 1;
      }
      await loadTests();
      const skippedMessage = skippedQuestions ? ` Skipped ${skippedQuestions} unsupported or invalid ${skippedQuestions === 1 ? "question" : "questions"}.` : "";
      setMessage($("#teacher-message"), `${count} local ${count === 1 ? "test" : "tests"} imported.${skippedMessage} The original local data was not removed.`);
    } catch (error) {
      setMessage($("#teacher-message"), explainError(error), true);
    }
  });

  renderTypeEditor();
}
