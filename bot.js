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
// TELEGRAM BOT (WEBHOOK MODE)
// =====================
const bot = new TelegramBot(token);

// =====================
// FIRESTORE SETUP
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
let blockedUsers = new Set();

// =====================
// WEBHOOK ROUTE
// =====================
app.post(`/bot${token}`, (req, res) => {
  bot.processUpdate(req.body);
  res.sendStatus(200);
});

// =====================
// SET WEBHOOK
// =====================
const WEBHOOK_URL = `https://quiz-bot-vxyx.onrender.com/bot${token}`;

bot.setWebHook(WEBHOOK_URL)
  .then(() => console.log("✅ Webhook set"))
  .catch(err => console.error("Webhook error:", err));

// =====================
// EXPRESS ROOT
// =====================
app.get('/', (req, res) => {
  res.send("Bot is running ✅");
});

// =====================
// START QUIZ FUNCTION
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

    const snapshot = await db.collection('questions')
      .orderBy(admin.firestore.FieldPath.documentId())
      .get();

    const questions = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

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

    if (!q.options || q.options.length < 2) {
      return bot.sendMessage(chatId, "⚠️ Invalid question data.");
    }

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
        keyboard: [["▶️ Start Quiz"]],
        resize_keyboard: true
      }
    });
  } else {
    bot.sendMessage(chatId, "👑 Admin Panel", {
      reply_markup: {
        keyboard: [
          ["➕ Add Question", "📋 List Questions"],
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

  // USER ACTION
  if (text === "▶️ Start Quiz") {
    return startQuiz(chatId);
  }

  // ADMIN ACTIONS
  if (userId === ADMIN_ID) {

    if (text === "➕ Add Question") {
      adminState[chatId] = { step: 1 };
      return bot.sendMessage(chatId, "Send question:");
    }

    if (text === "📋 List Questions") {
      const snapshot = await db.collection('questions').get();

      let textMsg = "📋 Questions:\n\n";
      snapshot.docs.forEach((doc, i) => {
        textMsg += `${i}. ${doc.data().question}\n`;
      });

      return bot.sendMessage(chatId, textMsg);
    }

    if (text === "👥 Users") {
      const snapshot = await db.collection('users').get();
      return bot.sendMessage(chatId, `👥 Total users: ${snapshot.size}`);
    }

    if (text === "📊 Leaderboard") {
      const snapshot = await db.collection('users').get();
      const users = snapshot.docs.map(doc => doc.data());

      const sorted = users
        .sort((a, b) => (b.bestScore || 0) - (a.bestScore || 0))
        .slice(0, 5);

      let textMsg = "🏆 Leaderboard:\n\n";
      sorted.forEach((u, i) => {
        textMsg += `${i + 1}. ${u.firstName || "User"} (@${u.username || ""}) → ${u.bestScore || 0}\n`;
      });

      return bot.sendMessage(chatId, textMsg);
    }

    const state = adminState[chatId];

    if (state) {
      if (state.step === 1) {
        state.question = text;
        state.step = 2;
        return bot.sendMessage(chatId, "Send options: A,B,C,D");
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
        await db.collection('questions').add({
          question: state.question,
          options: state.options,
          correct: parseInt(text)
        });

        delete adminState[chatId];
        return bot.sendMessage(chatId, "✅ Question added!");
      }
    }
  }

  // Forward user messages to admin
  if (userId !== ADMIN_ID) {
    bot.sendMessage(
      ADMIN_ID,
      `📩 User:\nID: ${userId}\nMessage: ${text}`
    );
  }
});

// =====================
// HANDLE POLL ANSWERS
// =====================
bot.on('poll_answer', async (answer) => {
  try {
    const userId = answer.user.id.toString();
    const selected = answer.option_ids[0];

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) return;

    const user = userDoc.data();

    const snapshot = await db.collection('questions')
      .orderBy(admin.firestore.FieldPath.documentId())
      .get();

    const questions = snapshot.docs.map(doc => doc.data());

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
app.listen(PORT, () => {
  console.log(`🌐 Server running on ${PORT}`);
});