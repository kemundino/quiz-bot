const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const admin = require('firebase-admin');

// =====================
// CONFIG
// =====================
const token = process.env.TOKEN;
const ADMIN_ID = 1983262664;

const bot = new TelegramBot(token);
bot.setWebHook(`https://quiz-bot-vxyx.onrender.com/bot${token}`);

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

  // 👤 USER MENU
  if (msg.from.id !== ADMIN_ID) {
    bot.sendMessage(chatId, "Welcome 👋", {
      reply_markup: {
        keyboard: [
          ["▶️ Start Quiz"],
          ["🔙 Back"]
        ],
        resize_keyboard: true
      }
    });
  } else {
    // 👑 ADMIN MENU
    bot.sendMessage(chatId, "👑 Admin Panel", {
      reply_markup: {
        keyboard: [
          ["➕ Add Question", "📋 List Questions"],
          ["✏️ Edit Question", "🗑 Delete Question"],
          ["👥 Users", "📊 Leaderboard"]
        ],
        resize_keyboard: true
      }
    });
  }
});
// SEND QUESTION
// =====================
async function sendQuestion(chatId) {
  const userDoc = await db.collection('users').doc(chatId).get();
  const user = userDoc.data();

  const snapshot = await db.collection('questions').get();
  const questions = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));

     if (!user || user.current === undefined) {
  await db.collection('users').doc(chatId).set({
    current: 0,
    score: 0
  }, { merge: true });

  return sendQuestion(chatId);
}

  const q = questions[user.current];

  if (!q) {
    // finished
    if (user.score > (user.bestScore || 0)) {
      await db.collection('users').doc(chatId).update({
        bestScore: user.score
      });
    }

    return bot.sendMessage(chatId,
      `✅ Finished!\nScore: ${user.score}/${questions.length}`,
      {
        reply_markup: {
          keyboard: [
            ["▶️ Start Quiz"],
            ["🔙 Back"]
          ],
          resize_keyboard: true
        }
      }
    );
  }

  bot.sendPoll(
    chatId,
    `Question ${user.current + 1}/${questions.length}\n\n${q.question}`,
    q.options,
    {
      type: "quiz",
      correct_option_id: q.correct,
      is_anonymous: false
    }
  );
}

// =====================
// HANDLE ANSWER
// =====================
bot.on('poll_answer', async (answer) => {
  const userId = answer.user.id.toString();
  const selected = answer.option_ids[0];

  const userRef = db.collection('users').doc(userId);
  const userDoc = await userRef.get();
  const user = userDoc.data();

  const snapshot = await db.collection('questions').get();
  const questions = snapshot.docs.map(doc => doc.data());

  const q = questions[user.current];

  if (selected === q.correct) {
    user.score++;
  }

  user.current++;

  await userRef.update({
    score: user.score,
    current: user.current
  });

  setTimeout(() => sendQuestion(userId), 1000);
});

// =====================
// ADMIN ADD QUESTION
// =====================


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

  if (!text) return;

  if (blockedUsers.has(chatId)) {
    return bot.sendMessage(chatId, "🚫 You are blocked.");
  }
  // ================= USER BUTTONS =================
if (text === "▶️ Start Quiz") {
  await db.collection('users').doc(chatId).set({
    current: 0,
    score: 0
  }, { merge: true });

  return sendQuestion(chatId);
}

if (text === "🔙 Back") {
  return bot.sendMessage(chatId, "Main Menu:", {
    reply_markup: {
      keyboard: [
        ["▶️ Start Quiz"],
        ["🔙 Back"]
      ],
      resize_keyboard: true
    }
  });
}
if (userId === ADMIN_ID) {

  if (text === "➕ Add Question") {
    adminState[chatId] = { step: 1 };
    return bot.sendMessage(chatId, "Send question:");
  }

if (text === "📋 List Questions") {
  const snapshot = await db.collection('questions').get();

  const keyboard = snapshot.docs.map((doc, i) => {
    return [{
      text: `${i}. ${doc.data().question}`,
      callback_data: `q_${doc.id}`
    }];
  });

  return bot.sendMessage(chatId, "Select a question:", {
    reply_markup: {
      inline_keyboard: keyboard
    }
  });
}

  if (text === "👥 Users") {
    const snapshot = await db.collection('users').get();
    return bot.sendMessage(chatId, `👥 Total users: ${snapshot.size}`);
  }

  if (text === "📊 Leaderboard") {
  const snapshot = await db.collection('users').get();
  const users = snapshot.docs.map(doc => doc.data());

  const sorted = users.sort((a, b) => (b.bestScore || 0) - (a.bestScore || 0)).slice(0, 5);

  let textMsg = "🏆 Leaderboard:\n\n";
  sorted.forEach((u, i) => {
    textMsg += `${i + 1}. ${u.firstName || "User"} (@${u.username || ""}) → ${u.bestScore || 0}\n`;
  });

  return bot.sendMessage(chatId, textMsg);
}

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
bot.onText(/\/admin/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;

  bot.sendMessage(msg.chat.id, "👑 Admin Panel:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "➕ Add Question", callback_data: "add_q" }],
        [{ text: "📋 List Questions", callback_data: "list_q" }],
        [{ text: "✏️ Edit Question", callback_data: "edit_q" }],
        [{ text: "🗑 Delete Question", callback_data: "delete_q" }],
        [{ text: "👥 Users", callback_data: "users" }],
        [{ text: "📊 Leaderboard", callback_data: "leaderboard" }]
      ]
    }
  });
});
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id.toString();
  const data = query.data;

  if (data === "leaderboard") {
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map(doc => doc.data());

    const sorted = users.sort((a, b) => (b.bestScore || 0) - (a.bestScore || 0)).slice(0, 5);

    let text = "🏆 Leaderboard:\n\n";
    sorted.forEach((u, i) => {
      text += `${i + 1}. ${u.firstName || "User"} (@${u.username || ""}) → ${u.bestScore || 0}\n`;
    });

    bot.sendMessage(chatId, text);
  }

  // ADMIN ACTIONS
  if (query.from.id === ADMIN_ID) {
    if (data === "add_q") {
      adminState[chatId] = { step: 1 };
      bot.sendMessage(chatId, "📝 Send question:");
    }

    if (data === "list_q") {
      const snapshot = await db.collection('questions').orderBy(admin.firestore.FieldPath.documentId()).get();

      let text = "📋 Questions:\n\n";
      snapshot.docs.forEach((doc, i) => {
        text += `${i}. ${doc.data().question}\n`;
      });

      bot.sendMessage(chatId, text);
    }

    if (data === "users") {
      const snapshot = await db.collection('users').get();
      bot.sendMessage(chatId, `👥 Total users: ${snapshot.size}`);
    }

    if (data === "edit_q") {
      bot.sendMessage(chatId, "Send:\n/editquestion 0");
    }

    if (data === "delete_q") {
      bot.sendMessage(chatId, "Send:\n/deletequestion 0");
    }
  }

if (data.startsWith("q_")) {
  const id = data.split("_")[1];

  bot.sendMessage(chatId, "Choose action:", {
    reply_markup: {
      inline_keyboard: [
        [{ text: "✏️ Edit", callback_data: `edit_${id}` }],
        [{ text: "🗑 Delete", callback_data: `del_${id}` }]
      ]
    }
  });
}
if (data.startsWith("del_")) {
  const id = data.split("_")[1];

  await db.collection('questions').doc(id).delete();

  bot.sendMessage(chatId, "🗑 Question deleted!");
}

if (data.startsWith("edit_")) {
  const id = data.split("_")[1];

  adminState[chatId] = {
    step: 1,
    editId: id
  };

  bot.sendMessage(chatId, "✏️ Send new question:");
}
  // LEADERBOARD
  if (data === "leaderboard") {
    const snapshot = await db.collection('users').get();
    const users = snapshot.docs.map(doc => doc.data());

    const sorted = users.sort((a, b) => (b.bestScore || 0) - (a.bestScore || 0)).slice(0, 5);

    let text = "🏆 Leaderboard:\n\n";
    sorted.forEach((u, i) => {
      text += `${i + 1}. ${u.firstName || "User"} (@${u.username || ""}) → ${u.bestScore || 0}\n`;
    });

    bot.sendMessage(chatId, text);
  }

  // ✅ BACK MENU (ADD HERE)
  if (data === "back_menu") {
    bot.sendMessage(chatId, "Main Menu:", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "▶️ Start Quiz", callback_data: "start_quiz" }],
          [{ text: "📊 Leaderboard", callback_data: "leaderboard" }]
        ]
      }
    });
  }

  // IMPORTANT: always at the end
  bot.answerCallbackQuery(query.id);
 
});