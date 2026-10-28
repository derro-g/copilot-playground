const crypto = require("node:crypto");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");

initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const db = getFirestore();
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const CODE_LENGTH = 6;

function requireAuth(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Sign in to continue.");
  return request.auth.uid;
}

async function requireTeacher(uid) {
  const teacher = await db.collection("teacherUsers").doc(uid).get();
  if (!teacher.exists) throw new HttpsError("permission-denied", "Teacher access is required.");
}

function makeJoinCode() {
  let code = "";
  for (let index = 0; index < CODE_LENGTH; index += 1) {
    code += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  }
  return code;
}

function cleanString(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function applySpeedBonus(baseMark, maximum, question, session, elapsedMs) {
  if (baseMark <= 0) return 0;
  if (!session.speedBonus || session.noTimeLimit || !question.timeLimit) return Math.min(maximum, baseMark);
  const boundedElapsed = Math.min(Math.max(elapsedMs, 0), question.timeLimit * 1000);
  const multiplier = 0.5 + 0.5 * (1 - boundedElapsed / (question.timeLimit * 1000));
  return Math.min(maximum, Math.round(baseMark * multiplier));
}

function scoreFor(question, session, elapsedMs, correct) {
  if (!correct) return 0;
  if (!session.speedBonus || session.noTimeLimit || !question.timeLimit) return question.marks;
  return applySpeedBonus(question.marks, question.marks, question, session, elapsedMs);
}

function isEmptyAnswer(answer) {
  return answer === null || answer === undefined || answer === "" || (Array.isArray(answer) && answer.length === 0);
}

function validateAnswer(question, answer) {
  if (isEmptyAnswer(answer)) return null;
  const choiceCount = question.type === "truefalse" ? 2 : (question.choices || []).length;
  if (question.type === "choice" || question.type === "truefalse") {
    if (!Number.isInteger(answer) || answer < 0 || answer >= choiceCount) throw new HttpsError("invalid-argument", "Choose one of the listed options.");
    return answer;
  }
  if (question.type === "multi") {
    if (!Array.isArray(answer) || answer.length > choiceCount || !answer.every((index) => Number.isInteger(index) && index >= 0 && index < choiceCount)) {
      throw new HttpsError("invalid-argument", "Choose from the listed options.");
    }
    return [...new Set(answer)];
  }
  if (question.type === "short" || question.type === "written") {
    if (typeof answer !== "string" || answer.length > 3000) throw new HttpsError("invalid-argument", "Enter a text answer of at most 3,000 characters.");
    return cleanString(answer, 3000);
  }
  if (question.type === "number") {
    if (typeof answer !== "number" || !Number.isFinite(answer)) throw new HttpsError("invalid-argument", "Enter a valid number.");
    return answer;
  }
  throw new HttpsError("failed-precondition", "Unsupported question type.");
}

function checkAnswer(question, answer) {
  const choices = Array.isArray(question.choices) ? question.choices : [];
  const correctIndices = Array.isArray(question.correctIndices)
    ? question.correctIndices
    : Number.isInteger(question.correctIndex) ? [question.correctIndex] : [];
  let isCorrect = false;
  let correctAnswer = "";
  let selectedIndices = [];
  const optionFeedback = Array.isArray(question.optionFeedback) ? question.optionFeedback : [];

  if (question.type === "choice" || question.type === "truefalse") {
    const selected = Number.isInteger(answer) ? answer : -1;
    selectedIndices = selected >= 0 ? [selected] : [];
    isCorrect = correctIndices.includes(selected);
    correctAnswer = choices[correctIndices[0]] || "";
  } else if (question.type === "multi") {
    const selected = Array.isArray(answer) && answer.every(Number.isInteger) ? [...new Set(answer)].sort((a, b) => a - b) : [];
    const expected = [...new Set(correctIndices)].sort((a, b) => a - b);
    selectedIndices = selected;
    isCorrect = selected.length > 0 && selected.length === expected.length && selected.every((value, index) => value === expected[index]);
    correctAnswer = expected.map((index) => choices[index]).filter(Boolean).join(", ");
  } else if (question.type === "short") {
    const entered = typeof answer === "string" ? answer.trim().toLocaleLowerCase() : "";
    const accepted = Array.isArray(question.acceptedAnswers) ? question.acceptedAnswers : [];
    isCorrect = entered.length > 0 && accepted.some((value) => String(value).trim().toLocaleLowerCase() === entered);
    correctAnswer = accepted[0] || "";
  } else if (question.type === "number") {
    const entered = typeof answer === "number" ? answer : Number.NaN;
    const expected = Number(question.correctNumber);
    const tolerance = Number(question.tolerance) || 0;
    isCorrect = Number.isFinite(entered) && Number.isFinite(expected) && Math.abs(entered - expected) <= tolerance;
    correctAnswer = Number.isFinite(expected) ? String(expected) : "";
  } else if (question.type === "written") {
    const text = typeof answer === "string" ? answer.trim() : "";
    return { isCorrect: null, pending: text.length > 0, correctAnswer: "", selectedIndices, optionFeedback };
  }

  return { isCorrect, pending: false, correctAnswer, selectedIndices, optionFeedback };
}

function publicQuestion(question, questionId, session) {
  return {
    id: questionId,
    order: Number(question.order) || 0,
    prompt: question.prompt,
    type: question.type,
    marks: Number(question.marks) || 2,
    timeLimit: session.noTimeLimit ? null : Number(question.timeLimit) || 30,
    choices: question.type === "truefalse" ? ["True", "False"] : Array.isArray(question.choices) ? question.choices : [],
  };
}

async function enforceJoinLookupLimit(request) {
  const ip = request.rawRequest?.ip || "unknown";
  const rateId = crypto.createHash("sha256").update(ip).digest("hex").slice(0, 40);
  const rateRef = db.collection("joinRateLimits").doc(rateId);
  const now = Date.now();
  const windowMs = 10 * 60 * 1000;
  const maximumLookups = 60;
  await db.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(rateRef);
    const data = snapshot.data();
    const startedAt = data?.windowStartedAt?.toMillis?.() || 0;
    if (!snapshot.exists || now - startedAt >= windowMs) {
      transaction.set(rateRef, { windowStartedAt: Timestamp.fromMillis(now), lookups: 1 });
      return;
    }
    if ((data.lookups || 0) >= maximumLookups) throw new HttpsError("resource-exhausted", "Too many code attempts. Wait a few minutes and try again.");
    transaction.update(rateRef, { lookups: FieldValue.increment(1) });
  });
}

exports.joinSession = onCall(async (request) => {
  const uid = requireAuth(request);
  if (request.auth.token.firebase?.sign_in_provider !== "anonymous") {
    throw new HttpsError("permission-denied", "Join a test using student access.");
  }
  const code = typeof request.data?.code === "string" ? request.data.code.trim().toUpperCase() : "";
  if (!/^[A-HJ-NP-Z2-9]{6}$/.test(code)) throw new HttpsError("invalid-argument", "Enter a valid six-character code.");

  const codeSnap = await db.collection("sessionCodes").doc(code).get();
  if (!codeSnap.exists) {
    await enforceJoinLookupLimit(request);
    throw new HttpsError("not-found", "That code is not open. Check it with your teacher.");
  }
  const sessionSnap = await db.collection("sessions").doc(codeSnap.data().sessionId).get();
  if (!sessionSnap.exists || sessionSnap.data().status !== "open") {
    await enforceJoinLookupLimit(request);
    throw new HttpsError("not-found", "That code is not open. Check it with your teacher.");
  }
  const session = sessionSnap.data();
  const questionSnap = await sessionSnap.ref.collection("publicQuestions").orderBy("order").get();
  if (questionSnap.empty) throw new HttpsError("failed-precondition", "This session has no questions yet.");

  return {
    sessionId: sessionSnap.id,
    title: session.title,
    joinCode: session.joinCode,
    maxMarks: session.maxMarks,
    feedbackMode: session.feedbackMode,
    speedBonus: session.speedBonus,
    noTimeLimit: session.noTimeLimit,
    questions: questionSnap.docs.map((item) => ({ id: item.id, ...item.data() })),
  };
});

exports.createSession = onCall(async (request) => {
  const uid = requireAuth(request);
  await requireTeacher(uid);
  const testId = cleanString(request.data?.testId, 128);
  if (!testId) throw new HttpsError("invalid-argument", "Choose a test first.");

  const testRef = db.collection("tests").doc(testId);
  const testSnap = await testRef.get();
  if (!testSnap.exists || testSnap.data().ownerUid !== uid) throw new HttpsError("not-found", "Test not found.");
  const test = testSnap.data();
  const questionsSnap = await testRef.collection("questions").orderBy("order").get();
  if (questionsSnap.empty) throw new HttpsError("failed-precondition", "Add at least one question before opening a session.");
  if (questionsSnap.size > 200) throw new HttpsError("failed-precondition", "A session can contain at most 200 questions.");

  const sessionRef = db.collection("sessions").doc();
  const questionDocs = questionsSnap.docs.map((doc) => ({ id: doc.id, data: doc.data() }));
  const questions = questionDocs.map(({ id, data }) => ({ ...data, id }));
  const maxMarks = questions.reduce((sum, question) => sum + (Number(question.marks) || 0), 0);
  const sessionSettings = {
    title: test.title,
    ownerUid: uid,
    testId,
    feedbackMode: test.feedbackMode === "end" ? "end" : "immediate",
    speedBonus: test.speedBonus !== false,
    noTimeLimit: test.noTimeLimit === true,
    maxMarks,
    status: "creating",
    createdAt: FieldValue.serverTimestamp(),
  };

  let joinCode = "";
  let reserved = false;
  for (let attempt = 0; attempt < 12 && !reserved; attempt += 1) {
    const candidate = makeJoinCode();
    const codeRef = db.collection("sessionCodes").doc(candidate);
    try {
      await db.runTransaction(async (transaction) => {
        const codeSnap = await transaction.get(codeRef);
        if (codeSnap.exists) throw new HttpsError("already-exists", "Retry session code.");
        transaction.create(codeRef, { sessionId: sessionRef.id, createdAt: FieldValue.serverTimestamp() });
        transaction.create(sessionRef, { ...sessionSettings, joinCode: candidate });
      });
      joinCode = candidate;
      reserved = true;
    } catch (error) {
      if (!(error instanceof HttpsError) || error.code !== "already-exists") throw error;
    }
  }
  if (!reserved) throw new HttpsError("resource-exhausted", "Could not create a unique join code. Try again.");

  const batch = db.batch();
  questionDocs.forEach(({ id, data }, order) => {
    const session = { ...sessionSettings, noTimeLimit: sessionSettings.noTimeLimit };
    batch.set(sessionRef.collection("publicQuestions").doc(id), publicQuestion({ ...data, order }, id, session));
    batch.set(sessionRef.collection("answerKeys").doc(id), {
      ...data,
      id,
      order,
      marks: Number(data.marks) || 2,
      timeLimit: sessionSettings.noTimeLimit ? null : Number(data.timeLimit) || 30,
      explanation: cleanString(data.explanation, 2000),
      teacherGuidance: cleanString(data.teacherGuidance, 2000),
      optionFeedback: Array.isArray(data.optionFeedback) ? data.optionFeedback : [],
    });
  });
  batch.update(sessionRef, { status: "open" });
  await batch.commit();
  return { sessionId: sessionRef.id, joinCode, title: test.title, maxMarks };
});

exports.createSampleTest = onCall(async (request) => {
  const uid = requireAuth(request);
  await requireTeacher(uid);
  const testRef = db.collection("tests").doc(`sample-${uid}`);
  if ((await testRef.get()).exists) return { testId: testRef.id, created: false };

  const sampleQuestions = [
    { prompt: "Which planet is known as the Red Planet?", type: "choice", marks: 2, timeLimit: 15, choices: ["Venus", "Mars", "Jupiter", "Mercury"], correctIndices: [1], acceptedAnswers: [], explanation: "Iron-rich dust gives Mars its red appearance.", optionFeedback: ["Venus is the second planet from the Sun.", "Mars is often called the Red Planet.", "Jupiter is the largest planet.", "Mercury is closest to the Sun."], teacherGuidance: "" },
    { prompt: "Which of these are prime numbers? Select all that apply.", type: "multi", marks: 5, timeLimit: 30, choices: ["2", "9", "11", "15"], correctIndices: [0, 2], acceptedAnswers: [], explanation: "A prime number has exactly two positive factors.", optionFeedback: [], teacherGuidance: "" },
    { prompt: "A year on Earth is the time it takes Earth to orbit the Sun.", type: "truefalse", marks: 2, timeLimit: 15, choices: ["True", "False"], correctIndices: [0], acceptedAnswers: [], explanation: "Earth completes one orbit in about 365.25 days.", optionFeedback: [], teacherGuidance: "" },
    { prompt: "What is the chemical symbol for gold?", type: "short", marks: 5, timeLimit: 30, choices: [], correctIndices: [], acceptedAnswers: ["Au", "Aurum"], explanation: "Au comes from the Latin word aurum.", optionFeedback: [], teacherGuidance: "" },
    { prompt: "How many degrees are in the interior angles of a triangle, in total?", type: "number", marks: 5, timeLimit: 30, choices: [], correctIndices: [], acceptedAnswers: [], correctNumber: 180, tolerance: 0, explanation: "The interior angles of a triangle add up to 180 degrees.", optionFeedback: [], teacherGuidance: "" },
    { prompt: "Explain one way that exercise benefits the body.", type: "written", marks: 10, timeLimit: 120, choices: [], correctIndices: [], acceptedAnswers: [], explanation: "For example, regular exercise can strengthen the heart and improve circulation.", optionFeedback: [], teacherGuidance: "Award marks for a clear, accurate explanation of a physical benefit." },
  ];
  const batch = db.batch();
  batch.create(testRef, {
    ownerUid: uid,
    title: "Question type sampler",
    sampleTemplate: "six-question-types-v1",
    feedbackMode: "immediate",
    speedBonus: true,
    noTimeLimit: false,
    questionCount: sampleQuestions.length,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });
  sampleQuestions.forEach((question, order) => {
    batch.create(testRef.collection("questions").doc(`sample-${order + 1}`), { ...question, order });
  });
  await batch.commit();
  return { testId: testRef.id, created: true };
});

exports.startQuestion = onCall(async (request) => {
  const uid = requireAuth(request);
  const { sessionId, questionId } = request.data || {};
  if (typeof sessionId !== "string" || typeof questionId !== "string") throw new HttpsError("invalid-argument", "Missing session or question.");
  const sessionRef = db.collection("sessions").doc(sessionId);
  const attemptRef = sessionRef.collection("attempts").doc(uid);
  const questionRef = sessionRef.collection("publicQuestions").doc(questionId);
  const [attemptSnap, questionSnap] = await Promise.all([attemptRef.get(), questionRef.get()]);
  if (!attemptSnap.exists || !questionSnap.exists) throw new HttpsError("not-found", "Attempt or question not found.");
  if (attemptSnap.data().ownerUid !== uid || attemptSnap.data().status !== "inProgress") throw new HttpsError("permission-denied", "This attempt is not active for your account.");

  return db.runTransaction(async (transaction) => {
    const freshAttempt = await transaction.get(attemptRef);
    if (!freshAttempt.exists || freshAttempt.data().ownerUid !== uid || freshAttempt.data().status !== "inProgress") {
      throw new HttpsError("failed-precondition", "This attempt is no longer active.");
    }
    const attempt = freshAttempt.data();
    if (Number(questionSnap.data().order) !== Number(attempt.answeredCount || 0)) {
      throw new HttpsError("failed-precondition", "Answer the questions in order.");
    }
    if (attempt.questionStartedAt) throw new HttpsError("failed-precondition", "This question has already started.");
    const startedAt = Timestamp.now();
    transaction.update(attemptRef, { questionStartedAt: startedAt });
    return { startedAt: startedAt.toMillis() };
  });
});

exports.submitAnswer = onCall(async (request) => {
  const uid = requireAuth(request);
  const { sessionId, questionId, answer } = request.data || {};
  const attemptId = uid;
  if (typeof sessionId !== "string" || typeof questionId !== "string") throw new HttpsError("invalid-argument", "Missing session or question.");

  const sessionRef = db.collection("sessions").doc(sessionId);
  const attemptRef = sessionRef.collection("attempts").doc(attemptId);
  const questionRef = sessionRef.collection("answerKeys").doc(questionId);
  const [sessionSnap, attemptSnap, questionSnap] = await Promise.all([sessionRef.get(), attemptRef.get(), questionRef.get()]);
  if (!sessionSnap.exists || !attemptSnap.exists || !questionSnap.exists) throw new HttpsError("not-found", "Session, attempt, or question not found.");
  const session = sessionSnap.data();
  const attempt = attemptSnap.data();
  if (attempt.ownerUid !== uid || attempt.status !== "inProgress") throw new HttpsError("permission-denied", "This attempt is not active for your account.");
  const question = questionSnap.data();
  const submittedAnswer = validateAnswer(question, answer);
  const responseRef = attemptRef.collection("responses").doc(questionId);
  if ((await responseRef.get()).exists) throw new HttpsError("already-exists", "This answer has already been submitted.");
  const stored = await db.runTransaction(async (transaction) => {
    const [freshAttempt, freshResponse] = await Promise.all([
      transaction.get(attemptRef),
      transaction.get(responseRef),
    ]);
    if (!freshAttempt.exists || freshAttempt.data().status !== "inProgress" || freshAttempt.data().ownerUid !== uid) {
      throw new HttpsError("failed-precondition", "This attempt is no longer active.");
    }
    if (freshResponse.exists) throw new HttpsError("already-exists", "This answer has already been submitted.");
    const attemptData = freshAttempt.data();
    if (Number(question.order) !== Number(attemptData.answeredCount || 0)) {
      throw new HttpsError("failed-precondition", "Answer the questions in order.");
    }

    const now = Timestamp.now();
    const startedAt = attemptData.questionStartedAt?.toMillis?.();
    if (!startedAt) throw new HttpsError("failed-precondition", "Start this question before submitting an answer.");
    const elapsedMs = Math.max(0, Math.min(now.toMillis() - startedAt, 7 * 24 * 60 * 60 * 1000));
    const timedOut = !session.noTimeLimit && question.timeLimit && elapsedMs >= question.timeLimit * 1000;
    const acceptedAnswer = timedOut ? null : submittedAnswer;
    const result = checkAnswer(question, acceptedAnswer);
    const score = result.pending ? 0 : scoreFor(question, session, elapsedMs, result.isCorrect === true);
    const answerText = typeof acceptedAnswer === "string" ? cleanString(acceptedAnswer, 3000) : acceptedAnswer;
    const response = {
      questionId,
      order: Number(question.order) || 0,
      prompt: question.prompt,
      type: question.type,
      answer: answerText,
      isCorrect: result.isCorrect,
      pending: result.pending,
      score,
      maxMarks: Number(question.marks) || 0,
      elapsedMs,
      correctAnswer: result.correctAnswer,
      explanation: question.explanation || "",
      selectedIndices: result.selectedIndices,
      optionFeedback: result.optionFeedback,
      teacherGuidance: question.teacherGuidance || "",
      submittedAt: now,
    };
    transaction.create(responseRef, response);
    transaction.update(attemptRef, {
      score: FieldValue.increment(score),
      pendingCount: FieldValue.increment(result.pending ? 1 : 0),
      answeredCount: FieldValue.increment(1),
      lastResponseAt: now,
      questionStartedAt: null,
    });
    return { result, response, score, acceptedAnswer };
  });
  const { result, response, score, acceptedAnswer } = stored;
  if (session.feedbackMode === "end") {
    return { saved: true, pending: result.pending, feedback: result.pending ? "Answer saved for teacher review." : "Answer saved. Feedback will appear when the session is submitted." };
  }
  if (result.pending) return { correct: null, pending: true, score, feedback: acceptedAnswer ? "Written answer saved for teacher review." : "No written answer was submitted." };

  const selectedFeedback = result.selectedIndices.map((index) => result.optionFeedback[index]).filter(Boolean).join(" ");
  const lines = result.isCorrect
    ? ["Correct!", `${score} of ${question.marks} marks.`, selectedFeedback, response.explanation]
    : ["Not quite.", result.correctAnswer ? `Correct answer: ${result.correctAnswer}.` : "No marks awarded.", selectedFeedback, response.explanation];
  return { correct: result.isCorrect, pending: false, score, feedback: lines.filter(Boolean).join(" ") };
});

exports.finishAttempt = onCall(async (request) => {
  const uid = requireAuth(request);
  const sessionId = request.data?.sessionId;
  if (typeof sessionId !== "string") throw new HttpsError("invalid-argument", "Missing session.");
  const sessionRef = db.collection("sessions").doc(sessionId);
  const attemptRef = sessionRef.collection("attempts").doc(uid);
  const [sessionSnap, attemptSnap, publicQuestionsSnap] = await Promise.all([
    sessionRef.get(), attemptRef.get(), sessionRef.collection("publicQuestions").get(),
  ]);
  if (!sessionSnap.exists || !attemptSnap.exists || attemptSnap.data().ownerUid !== uid) throw new HttpsError("not-found", "Attempt not found.");
  const session = sessionSnap.data();
  const attempt = attemptSnap.data();
  if (attempt.status === "submitted") return { score: attempt.score, maxMarks: attempt.maxMarks, pending: attempt.pendingCount || 0, feedback: attempt.finalFeedback || [] };
  const responseSnaps = await attemptRef.collection("responses").get();
  if (responseSnaps.size !== publicQuestionsSnap.size) throw new HttpsError("failed-precondition", "Answer every question before submitting the test.");

  const responses = responseSnaps.docs.map((doc) => doc.data()).sort((a, b) => {
    const qa = publicQuestionsSnap.docs.find((questionDoc) => questionDoc.id === a.questionId)?.data().order ?? 0;
    const qb = publicQuestionsSnap.docs.find((questionDoc) => questionDoc.id === b.questionId)?.data().order ?? 0;
    return qa - qb;
  });
  const finalFeedback = session.feedbackMode === "end" ? responses.map((response) => ({
    prompt: response.prompt,
    type: response.type,
    answer: response.answer,
    correct: response.isCorrect,
    pending: response.pending,
    score: response.score,
    maxMarks: response.maxMarks,
    correctAnswer: response.correctAnswer,
    explanation: response.explanation,
    optionFeedback: response.optionFeedback,
    selectedIndices: response.selectedIndices,
  })) : [];
  const totalScore = responses.reduce((sum, response) => sum + (Number(response.score) || 0), 0);
  const pendingCount = responses.filter((response) => response.pending).length;
  const correctCount = responses.filter((response) => response.isCorrect === true).length;

  await attemptRef.update({
    status: "submitted",
    submittedAt: FieldValue.serverTimestamp(),
    score: totalScore,
    pendingCount,
    correctCount,
    finalFeedback,
  });
  return { score: totalScore, maxMarks: attempt.maxMarks, pending: pendingCount, correct: correctCount, feedback: finalFeedback };
});

exports.gradeWrittenResponse = onCall(async (request) => {
  const uid = requireAuth(request);
  await requireTeacher(uid);
  const { sessionId, attemptId, questionId, mark } = request.data || {};
  if (![sessionId, attemptId, questionId].every((value) => typeof value === "string")) throw new HttpsError("invalid-argument", "Missing response details.");
  const sessionRef = db.collection("sessions").doc(sessionId);
  const attemptRef = sessionRef.collection("attempts").doc(attemptId);
  const responseRef = attemptRef.collection("responses").doc(questionId);
  const [sessionSnap, attemptSnap, responseSnap, keySnap] = await Promise.all([
    sessionRef.get(), attemptRef.get(), responseRef.get(), sessionRef.collection("answerKeys").doc(questionId).get(),
  ]);
  if (!sessionSnap.exists || sessionSnap.data().ownerUid !== uid) throw new HttpsError("permission-denied", "This session is not yours.");
  if (!attemptSnap.exists || !responseSnap.exists || !keySnap.exists) throw new HttpsError("not-found", "Written response not found.");
  const response = responseSnap.data();
  const question = keySnap.data();
  const session = sessionSnap.data();
  if (question.type !== "written" || !response.pending) throw new HttpsError("failed-precondition", "This response is not awaiting a written mark.");
  const baseMark = Number(mark);
  if (!Number.isInteger(baseMark) || baseMark < 0 || baseMark > question.marks) throw new HttpsError("invalid-argument", "Mark must be within the question total.");
  const score = applySpeedBonus(baseMark, question.marks, question, session, response.elapsedMs);
  await responseRef.update({ pending: false, isCorrect: baseMark > 0, score, teacherMark: baseMark, markedAt: FieldValue.serverTimestamp() });
  const allResponses = await attemptRef.collection("responses").get();
  const totalScore = allResponses.docs.reduce((sum, doc) => sum + (doc.id === questionId ? score : Number(doc.data().score) || 0), 0);
  const pendingCount = allResponses.docs.filter((doc) => doc.id !== questionId && doc.data().pending).length;
  await attemptRef.update({ score: totalScore, pendingCount });
  return { score, totalScore, pendingCount };
});
