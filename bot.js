const TelegramBot = require('node-telegram-bot-api');
const fs = require('fs');
const USERS_FILE = './users.json';

let users = {};

// Check if file exists
if (fs.existsSync(USERS_FILE)) {
  users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf-8'));
} else {
  fs.writeFileSync(USERS_FILE, JSON.stringify({}));
}
// Save users to file
function saveUsers() {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
}
const token = process.env.TOKEN;
const bot = new TelegramBot(token, { polling: true });

console.log("✅ Bot is running...");

const questions = JSON.parse(fs.readFileSync('./questions.json'));

users = {};

// 🔹 START

bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;

  // Register user if not exists
  if (!users[chatId]) {
    users[chatId] = {
      current: 0,
      score: 0
    };

    saveUsers(); // ✅ persist new user
  }

  bot.sendMessage(chatId, "Welcome!\nType /quiz to start.");
});

// 🔹 QUIZ START

bot.onText(/\/quiz/, (msg) => {
  const chatId = msg.chat.id;

  if (!users[chatId]) {
    users[chatId] = {
      current: 0,
      score: 0
    };
  }

  saveUsers();

  sendQuestion(chatId);
});

// 🔹 SEND QUESTION
function sendQuestion(chatId) {
  const user = users[chatId];
  const q = questions[user.current];

  if (!q) {
    bot.sendMessage(chatId, `✅ Finished!\nScore: ${user.score}/${questions.length}`);
    return;
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

// 🔹 HANDLE ANSWER
bot.on('poll_answer', (answer) => {
  const userId = answer.user.id;
  const selected = answer.option_ids[0];

  if (!users[userId]) return;
const user = users[userId];
  if (!user) return;

  const q = questions[user.current];

  if (selected === q.correct) {
    user.score++;
  }

  user.current++;
saveUsers();
  setTimeout(() => {
    sendQuestion(userId);
  }, 1000);
});


bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const text = msg.text;

  // Ignore admin messages (optional)
  if (userId === ADMIN_ID) return;

  // Forward message to admin
  bot.sendMessage(
    ADMIN_ID,
    `📩 New message from user:\n\n👤 ID: ${userId}\n💬 Message: ${text}`
  );
});
// 🔹 LOG USER MESSAGES
bot.on('message', (msg) => {
  if (msg.text) {
    bot.sendMessage(msg.chat.id, `You sent: "${msg.text}"`);
  } else {
    bot.sendMessage(msg.chat.id, "I can only process text messages right now.");
  }
});

// 🔹 MESSAGE CONTROL (ONLY ONE HANDLER)
bot.on('message', (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text;

  // ignore commands
  if (text.startsWith('/')) return;

  const user = users[chatId];

  if (!user) {
    bot.sendMessage(chatId, "👉 Type /quiz to start.");
    return;
  }

  bot.sendMessage(chatId, "✅ Please answer using the options.");
});

// 🔹 Admin ID
const ADMIN_ID =  1983262664; // Replace with the actual admin's Telegram user ID

bot.onText(/\/users/, (msg) => {
  if (msg.from.id !== ADMIN_ID) {
    bot.sendMessage(msg.chat.id, "❌ Unauthorized");
    return;
  }

  const totalUsers = Object.keys(users).length;

  bot.sendMessage(msg.chat.id, `👥 Total users: ${totalUsers}`);
});


// 🔹 BROADCAST COMMAND
bot.onText(/\/broadcast (.+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) {
    bot.sendMessage(msg.chat.id, "❌ You are not authorized to use this command.");
    return;
  }

  const message = match[1];
  Object.keys(users).forEach((chatId) => {
    bot.sendMessage(chatId, `📢 Admin Broadcast: ${message}`);
  });

  bot.sendMessage(msg.chat.id, "✅ Broadcast sent to all users.");
});
bot.on('message', (msg) => {
  const userId = msg.from.id;

  // Only allow admin to reply using a format
  if (userId === ADMIN_ID && msg.reply_to_message) {
    const repliedText = msg.reply_to_message.text;

    // Extract user ID from forwarded message
    const match = repliedText.match(/ID: (\d+)/);

    if (match) {
      const targetUserId = match[1];

      const replyText = msg.text;

      bot.sendMessage(targetUserId, `📢 Admin reply:\n\n${replyText}`);
    }
  }
});
bot.onText(/\/listusers/, (msg) => {
  if (msg.from.id !== ADMIN_ID) {
    bot.sendMessage(msg.chat.id, "❌ Unauthorized");
    return;
  }

  const userIds = Object.keys(users);

  if (userIds.length === 0) {
    bot.sendMessage(msg.chat.id, "No users found.");
    return;
  }

  const list = userIds.join('\n');

  bot.sendMessage(msg.chat.id, `👥 Users:\n\n${list}`);
});
bot.onText(/\/block (\d+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;

  const userId = match[1];
  blockedUsers.add(userId);

  bot.sendMessage(msg.chat.id, `🚫 User ${userId} blocked`);
});
bot.onText(/\/unblock (\d+)/, (msg, match) => {
  if (msg.from.id !== ADMIN_ID) return;

  const userId = match[1];
  blockedUsers.delete(userId);

  bot.sendMessage(msg.chat.id, `✅ User ${userId} unblocked`);
});