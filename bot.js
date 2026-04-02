const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const express = require('express');

// =====================
// CONFIG
// =====================
const token = process.env.TOKEN;
const ADMIN_ID = 1983262664;

const bot = new TelegramBot(token, { polling: true });

console.log("✅ Bot is running...");

// =====================
// FILES
// =====================
const USERS_FILE = './users.json';
const QUESTIONS_FILE = './questions.json';

// Load users
let users = {};
if (fs.existsSync(USERS_FILE)) {
  users = JSON.parse(fs.readFileSync(USERS_FILE));
} else {
  fs.writeFileSync(USERS_FILE, JSON.stringify({}));
}

// Load questions
let questions = [];
if (fs.existsSync(QUESTIONS_FILE)) {
  questions = JSON.parse(fs.readFileSync(QUESTIONS_FILE));
}

// Save users
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}

// Save questions
function saveQuestions() {
  fs.writeFileSync(QUESTIONS_FILE, JSON.stringify(questions, null, 2));
}

// =====================
// ADMIN STATE
// =====================
let adminState = {};
let blockedUsers = new Set();

// =====================
// START
// =====================
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  if (!users[chatId]) {
    users[chatId] = {
      current: 0,
      score: 0,
      bestScore: 0,
      username: msg.from.username || "",
      firstName: msg.from.first_name || ""
    };
  }

  saveUsers();

  bot.sendMessage(chatId, "Welcome!\nType /quiz to start.");
});

// =====================
// QUIZ
// =====================
bot.onText(/\/quiz/, (msg) => {
  const chatId = msg.chat.id;

  if (!users[chatId]) return;

  users[chatId].current = 0;
  users[chatId].score = 0;

  sendQuestion(chatId);
});

function sendQuestion(chatId) {
  const user = users[chatId];
  const q = questions[user.current];

  if (!q) {
    if (user.score > (user.bestScore || 0)) {
      user.bestScore = user.score;
    }

    saveUsers();

    bot.sendMessage(
      chatId,
      `✅ Finished!\nScore: ${user.score}/${questions.length}\n🏆 Best: ${user.bestScore}`
    );
    return;
  }

  bot.sendPoll(chatId, q.question, q.options, {
    type: "quiz",
    correct_option_id: q.correct,
    is_anonymous: false
  });
}

bot.on('poll_answer', (answer) => {
  const userId = answer.user.id;

  if (!users[userId]) return;

  const user = users[userId];
  const selected = answer.option_ids[0];
  const q = questions[user.current];

  if (selected === q.correct) user.score++;

  user.current++;
  saveUsers();

  setTimeout(() => sendQuestion(userId), 1000);
});

// =====================
// ADMIN COMMANDS
// =====================
bot.onText(/\/addquestion/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;

  adminState[msg.chat.id] = { step: 1 };
  bot.sendMessage(msg.chat.id, "📝 Send the question:");
});

bot.onText(/\/editquestion (\d+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;

  const index = parseInt(match[1]);
  if (!questions[index]) return bot.sendMessage(msg.chat.id, "Invalid index");

  adminState[msg.chat.id] = { step: 1, editIndex: index };
  bot.sendMessage(msg.chat.id, "✏️ Send new question:");
});

bot.onText(/\/deletequestion (\d+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;

  const index = parseInt(match[1]);
  if (!questions[index]) return bot.sendMessage(msg.chat.id, "Invalid index");

  const deleted = questions.splice(index, 1);
  saveQuestions();

  bot.sendMessage(msg.chat.id, `Deleted: ${deleted[0].question}`);
});

bot.onText(/\/listquestions/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;

  let text = "📋 Questions:\n\n";
  questions.forEach((q, i) => text += `${i}. ${q.question}\n`);

  bot.sendMessage(msg.chat.id, text);
});

// =====================
// LEADERBOARD
// =====================
bot.onText(/\/leaderboard/, (msg) => {
  const sorted = Object.entries(users)
    .sort((a, b) => (b[1].bestScore || 0) - (a[1].bestScore || 0))
    .slice(0, 5);

  let text = "🏆 Leaderboard:\n\n";

  sorted.forEach((u, i) => {
    const data = u[1];
    const name = data.firstName || "User";
    const username = data.username ? `(@${data.username})` : "";

    text += `${i + 1}. ${name} ${username} → ${data.bestScore}\n`;
  });

  bot.sendMessage(msg.chat.id, text);
});

// =====================
// USERS
// =====================
bot.onText(/\/users/, (msg) => {
  if (msg.from.id !== ADMIN_ID) return;

  bot.sendMessage(msg.chat.id, `👥 Total users: ${Object.keys(users).length}`);
});

// =====================
// MESSAGE HANDLER (ONLY ONE)
// =====================
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  if (!text || text.startsWith('/')) return;

  if (blockedUsers.has(userId.toString())) {
    return bot.sendMessage(chatId, "🚫 You are blocked.");
  }

  // Ensure user exists
  if (!users[chatId]) {
    users[chatId] = { current: 0, score: 0, bestScore: 0 };
  }

  // Update user info
  users[chatId].username = msg.from.username || "";
  users[chatId].firstName = msg.from.first_name || "";
  saveUsers();

  const state = adminState[chatId];

  // ===== ADD QUESTION =====
  if (userId === ADMIN_ID && state && !state.editIndex) {
    if (state.step === 1) {
      state.question = text;
      state.step = 2;
      return bot.sendMessage(chatId, "Send options: A,B,C,D");
    }

    if (state.step === 2) {
      state.options = text.split(",");
      state.step = 3;
      return bot.sendMessage(chatId, "Correct option index (0-3):");
    }

    if (state.step === 3) {
      state.correct = parseInt(text);

      questions.push({
        question: state.question,
        options: state.options,
        correct: state.correct
      });

      saveQuestions();
      delete adminState[chatId];

      return bot.sendMessage(chatId, "✅ Question added!");
    }
  }

  // ===== EDIT QUESTION =====
  if (userId === ADMIN_ID && state && state.editIndex !== undefined) {
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
      questions[state.editIndex] = {
        question: state.question,
        options: state.options,
        correct: parseInt(text)
      };

      saveQuestions();
      delete adminState[chatId];

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
// EXPRESS SERVER
// =====================
const app = express();

app.get('/', (req, res) => {
  res.send("Bot is running ✅");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌐 Server running on ${PORT}`);
});