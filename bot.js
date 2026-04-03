const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const admin = require('firebase-admin');

// =====================
// CONFIG
// =====================
const token = process.env.TOKEN;
const ADMIN_ID = 1983262664;

const bot = new TelegramBot(token, { polling: true });

// =====================
// FIRESTORE SETUP
// =====================
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

console.log("🔥 Bot + Firestore running...");

// =====================
// STATE
// =====================
let adminState = {};
let blockedUsers = new Set();

// =====================
// START
// =====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id.toString();

  await db.collection('users').doc(chatId).set({
    chatId,
    username: msg.from.username || "",
    firstName: msg.from.first_name || "",
    score: 0,
    bestScore: 0,
    current: 0
  }, { merge: true });

  bot.sendMessage(chatId, "Welcome!\nType /quiz to start.");
});

// =====================
// QUIZ START
// =====================
bot.onText(/\/quiz/, async (msg) => {
  const chatId = msg.chat.id.toString();

  await db.collection('users').doc(chatId).update({
    current: 0,
    score: 0
  });

  sendQuestion(chatId);
});

// =====================
// SEND QUESTION
// =====================
async function sendQuestion(chatId) {
  const userDoc = await db.collection('users').doc(chatId).get();
  const user = userDoc.data();

  const snapshot = await db.collection('questions').get();
  const questions = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));

  const q = questions[user.current];

  if (!q) {
    let best = user.bestScore || 0;

    if (user.score > best) {
      best = user.score;
    }

    await db.collection('users').doc(chatId).update({
      bestScore: best
    });

    return bot.sendMessage(
      chatId,
      `✅ Finished!\nScore: ${user.score}/${questions.length}\n🏆 Best: ${best}`
    );
  }

  bot.sendPoll(chatId, q.question, q.options, {
    type: "quiz",
    correct_option_id: q.correct,
    is_anonymous: false
  });
}

// =====================
// HANDLE ANSWER
// =====================
bot.on('poll_answer', async (answer) => {
  const userId = answer.user.id.toString();

  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();

  if (!userDoc.exists) return;

  const user = userDoc.data();

  const snapshot = await db.collection('questions').get();
  const questions = snapshot.docs.map(doc => doc.data());

  const q = questions[user.current];
  const selected = answer.option_ids[0];

  let newScore = user.score;
  if (selected === q.correct) newScore++;

  await userRef.update({
    score: newScore,
    current: user.current + 1
  });

  setTimeout(() => sendQuestion(userId), 1000);
});

// =====================
// ADMIN ADD QUESTION
// =====================
bot.onText(/\/addquestion/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;

  adminState[msg.chat.id] = { step: 1 };
  bot.sendMessage(msg.chat.id, "📝 Send the question:");
});

// =====================
// ADMIN EDIT
// =====================
bot.onText(/\/editquestion (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;

  const index = parseInt(match[1]);

  const snapshot = await db.collection('questions').get();
  const questions = snapshot.docs;

  if (!questions[index]) return bot.sendMessage(msg.chat.id, "Invalid index");

  adminState[msg.chat.id] = {
    step: 1,
    editId: questions[index].id
  };

  bot.sendMessage(msg.chat.id, "✏️ Send new question:");
});

// =====================
// DELETE QUESTION
// =====================
bot.onText(/\/deletequestion (\d+)/, async (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;

  const index = parseInt(match[1]);

  const snapshot = await db.collection('questions').get();
  const docs = snapshot.docs;

  if (!docs[index]) return bot.sendMessage(msg.chat.id, "Invalid index");

  await db.collection('questions').doc(docs[index].id).delete();

  bot.sendMessage(msg.chat.id, "🗑 Question deleted");
});

// =====================
// LIST QUESTIONS
// =====================
bot.onText(/\/listquestions/, async (msg) => {
  if (msg.from.id !== ADMIN_ID) return;

  const snapshot = await db.collection('questions').get();

  let text = "📋 Questions:\n\n";

  snapshot.docs.forEach((doc, i) => {
    text += `${i}. ${doc.data().question}\n`;
  });

  bot.sendMessage(msg.chat.id, text);
});

// =====================
// MESSAGE HANDLER
// =====================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  if (blockedUsers.has(chatId)) {
    return bot.sendMessage(chatId, "🚫 You are blocked.");
  }

  // Update user info
  await db.collection('users').doc(chatId).set({
    username: msg.from.username || "",
    firstName: msg.from.first_name || ""
  }, { merge: true });

  const state = adminState[msg.chat.id];

  // ===== ADD =====
  if (userId === ADMIN_ID && state && !state.editId) {
    if (state.step === 1) {
      state.question = text;
      state.step = 2;
      return bot.sendMessage(chatId, "Send options: A,B,C,D");
    }

    if (state.step === 2) {
      state.options = text.split(",");
      state.step = 3;
      return bot.sendMessage(chatId, "Correct index (0-3):");
    }

    if (state.step === 3) {
      await db.collection('questions').add({
        question: state.question,
        options: state.options,
        correct: parseInt(text)
      });

      delete adminState[msg.chat.id];
      return bot.sendMessage(chatId, "✅ Question added!");
    }
  }

  // ===== EDIT =====
  if (userId === ADMIN_ID && state && state.editId) {
    if (state.step === 1) {
      state.question = text;
      state.step = 2;
      return bot.sendMessage(chatId, "New options:");
    }

    if (state.step === 2) {
      state.options = text.split(",");
      state.step = 3;
      return bot.sendMessage(chatId, "Correct index:");
    }

    if (state.step === 3) {
      await db.collection('questions').doc(state.editId).update({
        question: state.question,
        options: state.options,
        correct: parseInt(text)
      });

      delete adminState[msg.chat.id];
      return bot.sendMessage(chatId, "✅ Updated!");
    }
  }

  // Forward to admin
  if (userId !== ADMIN_ID) {
    bot.sendMessage(
      ADMIN_ID,
      `📩 User:\nID: ${userId}\nMessage: ${text}`
    );
  }
});

// =====================
// LEADERBOARD
// =====================
bot.onText(/\/leaderboard/, async (msg) => {
  const snapshot = await db.collection('users').get();

  const users = snapshot.docs.map(doc => doc.data());

  const sorted = users.sort((a, b) => (b.bestScore || 0) - (a.bestScore || 0)).slice(0, 5);

  let text = "🏆 Leaderboard:\n\n";

  sorted.forEach((u, i) => {
    text += `${i + 1}. ${u.firstName || "User"} (@${u.username || ""}) → ${u.bestScore || 0}\n`;
  });

  bot.sendMessage(msg.chat.id, text);
});

// =====================
// EXPRESS (Render fix)
// =====================
const app = express();

app.get('/', (req, res) => {
  res.send("Bot is running ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on ${PORT}`);
});