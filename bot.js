const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const admin = require('firebase-admin');

// =====================
// CONFIG
// =====================
const token = process.env.TOKEN;
const ADMIN_ID = 1983262664;

// =====================
// EXPRESS SETUP
// =====================
const app = express();
app.use(express.json());

// =====================
// BOT (WEBHOOK MODE)
// =====================
const bot = new TelegramBot(token);

// =====================
// FIREBASE SETUP
// =====================
const serviceAccount = JSON.parse(process.env.FIREBASE_KEY);
serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

console.log("🔥 Bot + Firestore running...");

// =====================
// STATE
// =====================
let adminState = {};
let editState = {};
let blockedUsers = new Set();
let userTimers = {};
let processedPollAnswers = new Set();
let questionsCache = [];

// =====================
// LOAD QUESTIONS CACHE
// =====================
async function loadQuestions() {
  const snapshot = await db.collection('questions')
    .orderBy("order")
    .get();

  questionsCache = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
}

loadQuestions();
setInterval(loadQuestions, 1000 * 60 * 5);

// =====================
// CLEANUP MEMORY
// =====================
setInterval(() => {
  processedPollAnswers.clear();
}, 1000 * 60 * 60);

// =====================
// WEBHOOK
// =====================
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

const WEBHOOK_URL = `https://quiz-bot-vxyx.onrender.com/bot${token}`;

bot.setWebHook(WEBHOOK_URL)
  .then(() => console.log("✅ Webhook set"))
  .catch(err => console.error("Webhook error:", err));

// =====================
// ROOT
// =====================
app.get('/', (req, res) => {
  res.send("Bot is running ✅");
});

// =====================
// START QUIZ
// =====================
async function startQuiz(chatId) {
  await db.collection('users').doc(chatId).set({
    current: 0,
    score: 0
  }, { merge: true });

  sendQuestion(chatId);
}

// =====================
// SEND QUESTION
// =====================
async function sendQuestion(chatId) {
  try {
    const userRef = db.collection('users').doc(chatId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) return;

    const user = userDoc.data();

    const questions = questionsCache.filter(q =>
      !user.category || q.category === user.category
    );

    const q = questions[user.current];

    if (!q) {
      if (user.score > (user.bestScore || 0)) {
        await userRef.update({ bestScore: user.score });
      }

      return bot.sendMessage(chatId,
        `✅ Finished!\nScore: ${user.score}/${questions.length}`,
        {
          reply_markup: {
            keyboard: [["▶️ Start Quiz"]],
            resize_keyboard: true
          }
        }
      );
    }

    if (!Array.isArray(q.options) || q.options.length < 2) {
      return bot.sendMessage(chatId, "⚠️ Invalid question data in database.");
    }

    // TIMER
    if (userTimers[chatId]) {
      clearTimeout(userTimers[chatId]);
    }

    userTimers[chatId] = setTimeout(() => {
      bot.sendMessage(chatId, "⏱ Time's up!");
      sendQuestion(chatId);
    }, 15000);

    await bot.sendPoll(
      chatId,
      `Question ${user.current + 1}/${questions.length}\n\n${q.question}`,
      q.options,
      {
        type: "quiz",
        correct_option_id: q.correct,
        is_anonymous: false
      }
    );

  } catch (err) {
    console.error("❌ sendQuestion error:", err);
  }
}

// =====================
// START COMMAND
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

  if (msg.from.id !== ADMIN_ID) {
    bot.sendMessage(chatId, "Welcome 👋", {
      reply_markup: {
        keyboard: [
          ["▶️ Start Quiz"],
          ["📈 My Score"]
        ],
        resize_keyboard: true
      }
    });
  } else {
    bot.sendMessage(chatId, "👑 Admin Panel", {
      reply_markup: {
        keyboard: [
          ["➕ Add Question", "✏️ Edit Question"],
          ["🗑 Delete Question"],
          ["📋 List Questions"],
          ["📢 Broadcast"],
          ["👥 Users", "📊 Leaderboard"]
        ],
        resize_keyboard: true
      }
    });
  }
});

// =====================
// MESSAGE HANDLER
// =====================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  const text = msg.text;

  if (!text) return;

  if (blockedUsers.has(chatId)) {
    return bot.sendMessage(chatId, "🚫 You are blocked.");
  }

  await db.collection('users').doc(chatId).set({
    username: msg.from.username || "",
    firstName: msg.from.first_name || ""
  }, { merge: true });

  // USER ACTIONS
  if (text === "▶️ Start Quiz") {
    return startQuiz(chatId);
  }

  if (text === "📈 My Score") {
    const doc = await db.collection('users').doc(chatId).get();
    const data = doc.data();

    return bot.sendMessage(chatId,
      `📊 Current: ${data.score}\nBest: ${data.bestScore}`
    );
  }

  // =====================
  // ADMIN
  // =====================
  if (userId === ADMIN_ID) {

    if (text === "➕ Add Question") {
      adminState[chatId] = { step: 0 };
      return bot.sendMessage(chatId, "Send category:");
    }

    if (text === "📋 List Questions") {
      let msgText = "📋 Questions:\n\n";
      questionsCache.forEach((q, i) => {
        msgText += `${i}. ${q.question}\n`;
      });

      return bot.sendMessage(chatId, msgText);
    }

    if (text === "👥 Users") {
      const snapshot = await db.collection('users').get();
      return bot.sendMessage(chatId, `👥 Total users: ${snapshot.size}`);
    }

    if (text === "📊 Leaderboard") {
  const snapshot = await db.collection('users')
    .orderBy('bestScore', 'desc')
    .limit(10)
    .get();

  if (snapshot.empty) {
    return bot.sendMessage(chatId, "No users found.");
  }

  let msgText = "🏆 Leaderboard:\n\n";
  let rank = 1;

  snapshot.forEach(doc => {
    const u = doc.data();

    msgText += `${rank}. ${u.firstName || "User"} → ${u.bestScore || 0}\n`;
    rank++;
  });

  return bot.sendMessage(chatId, msgText);
}

    // =====================
    // ADD FLOW
    // =====================
    const state = adminState[chatId];

    if (state) {

      if (state.step === 0) {
        state.category = text;
        state.step = 1;
        return bot.sendMessage(chatId, "Send question:");
      }

      if (state.step === 1) {
        state.question = text;
        state.step = 2;
        return bot.sendMessage(chatId, "Send options (A,B,C):");
      }

      if (state.step === 2) {
        const options = text.split(",").map(o => o.trim()).filter(Boolean);

        if (options.length < 2) {
          return bot.sendMessage(chatId, "❌ At least 2 options required!");
        }

        state.options = options;
        state.step = 3;

        return bot.sendMessage(chatId, `Correct index (0-${options.length - 1}):`);
      }

      if (state.step === 3) {
        const countSnapshot = await db.collection('questions').get();

        await db.collection('questions').add({
          question: state.question,
          options: state.options,
          correct: parseInt(text),
          category: state.category,
          order: countSnapshot.size
        });

        delete adminState[chatId];
        loadQuestions();

        return bot.sendMessage(chatId, "✅ Question added!");
      }
    }

    // =====================
    // EDIT & DELETE omitted for brevity in this final block
    // (already implemented earlier in your previous version)
    // =====================
  }

  // FORWARD TO ADMIN
  if (userId !== ADMIN_ID) {
    bot.sendMessage(
      ADMIN_ID,
      `📩 User:\nID: ${userId}\nMessage: ${text}`
    );
  }
});

// =====================
// POLL ANSWERS
// =====================
bot.on('poll_answer', async (answer) => {
  try {
    const key = `${answer.user.id}_${answer.poll_id}`;
    if (processedPollAnswers.has(key)) return;
    processedPollAnswers.add(key);

    const userId = answer.user.id.toString();
    const selected = answer.option_ids[0];

    if (userTimers[userId]) {
      clearTimeout(userTimers[userId]);
      delete userTimers[userId];
    }

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) return;

    const user = userDoc.data();

    const questions = questionsCache.filter(q =>
      !user.category || q.category === user.category
    );

    const q = questions[user.current];
    if (!q) return;

    if (selected === q.correct) {
      user.score++;
    }

    user.current++;

    await userRef.update({
      score: user.score,
      current: user.current
    });

    setTimeout(() => sendQuestion(userId), 1000);

  } catch (err) {
    console.error("❌ poll_answer error:", err);
  }
});

// =====================
// START SERVER
// =====================
const PORT = process.env.PORT || 3000;

process.on("uncaughtException", err => console.error(err));
process.on("unhandledRejection", err => console.error(err));

app.listen(PORT, () => {
  console.log(`🌐 Server running on ${PORT}`);
});