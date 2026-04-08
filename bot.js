const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const admin = require('firebase-admin');
const fetch = require('node-fetch'); // Add this: npm install node-fetch

// =====================
// CONFIG
// =====================
const token = process.env.TOKEN;
const ADMIN_ID = 1983262664;
const BOT_URL = process.env.RENDER_EXTERNAL_URL || 'https://quiz-bot-vxyx.onrender.com';

// =====================
// EXPRESS SETUP
// =====================
const app = express();
app.use(express.json());

// =====================
// BOT (LONG POLLING MODE - FASTER)
// =====================
const bot = new TelegramBot(token, { polling: true });
console.log("✅ Bot started in polling mode (no webhook delays)");

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
let broadcastState = {};
let blockState = {};
let replyState = {};
let categoryManageState = {};
let blockedUsers = new Set();
let processedPollAnswers = new Set();
let questionsCache = [];
let userSessions = {};

// =====================
// USER CACHE FOR FASTER LOOKUPS
// =====================
const userCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

async function getCachedUser(chatId) {
  if (userCache.has(chatId)) {
    const cached = userCache.get(chatId);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data;
    }
    userCache.delete(chatId);
  }
  
  const userDoc = await db.collection('users').doc(chatId).get();
  const data = userDoc.data();
  if (data) {
    userCache.set(chatId, { data, timestamp: Date.now() });
  }
  return data;
}

async function setCachedUser(chatId, data) {
  userCache.set(chatId, { data, timestamp: Date.now() });
}

// Clear cache periodically
setInterval(() => {
  for (const [key, value] of userCache.entries()) {
    if (Date.now() - value.timestamp > CACHE_TTL) {
      userCache.delete(key);
    }
  }
}, 60 * 1000);

// =====================
// LOAD BLOCKED USERS FROM FIREBASE
// =====================
async function loadBlockedUsers() {
  const snapshot = await db.collection('blocked').get();
  blockedUsers.clear();
  snapshot.forEach(doc => {
    blockedUsers.add(doc.id);
  });
  console.log(`📋 Loaded ${blockedUsers.size} blocked users`);
}

// =====================
// LOAD QUESTIONS CACHE
// =====================
async function loadQuestions() {
  const snapshot = await db.collection('questions')
    .orderBy("createdAt", "desc")
    .get();

  questionsCache = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
  
  console.log(`📚 Loaded ${questionsCache.length} questions from ${getUniqueCategories().length} categories`);
}

// =====================
// INITIALIZE
// =====================
async function initialize() {
  await loadQuestions();
  await loadBlockedUsers();
}
initialize();
setInterval(loadQuestions, 1000 * 60 * 30); // Reduced frequency to 30 minutes
setInterval(loadBlockedUsers, 1000 * 60 * 5);

// =====================
// CLEANUP MEMORY
// =====================
setInterval(() => {
  processedPollAnswers.clear();
}, 1000 * 60 * 60);

// =====================
// KEEP-ALIVE PING (PREVENTS COLD STARTS)
// =====================
setInterval(async () => {
  try {
    await fetch(BOT_URL);
    console.log('💓 Keep-alive ping sent');
  } catch (e) {
    // Silent fail - don't log every error
  }
}, 4 * 60 * 1000); // Every 4 minutes

// =====================
// HEALTH CHECK ENDPOINT
// =====================
app.get('/', (req, res) => {
  res.send("Bot is running ✅");
});

// =====================
// WEBHOOK ENDPOINT (KEPT FOR COMPATIBILITY BUT NOT USED)
// =====================
app.post(`/bot${token}`, (req, res) => {
  res.sendStatus(200);
});

// =====================
// ADMIN KEYBOARDS
// =====================
const getAdminKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ["➕ Add Question", "✏️ Edit Question"],
      ["🗑 Delete Question", "📋 List Questions"],
      ["📢 Broadcast", "👥 Users"],
      ["🚫 Block User", "✅ Unblock User"],
      ["📊 Leaderboard", "📈 Stats"],
      ["📩 View Messages", "🔙 Back"]
    ],
    resize_keyboard: true,
    input_field_placeholder: "Choose an option..."
  }
});

const getCategoryManagementKeyboard = (categories, action) => ({
  reply_markup: {
    keyboard: [
      ...categories.map(cat => [`📚 ${cat}`]),
      ["🔙 Back to Admin Menu"]
    ],
    resize_keyboard: true,
    input_field_placeholder: "Select a category..."
  }
});

// =====================
// PROFESSIONAL USER KEYBOARDS
// =====================
const getMainKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ["🎯 Start Quiz", "📊 My Stats"],
      ["ℹ️ About", "🔄 Change Category"],
      ["📩 Contact"]
    ],
    resize_keyboard: true,
    persistent: true,
    input_field_placeholder: "Choose an option..."
  }
});

const getCategoryKeyboard = (categories) => ({
  reply_markup: {
    keyboard: [
      ...categories.map(c => [`📚 ${c}`]),
      ["🔙 Back to Main Menu"]
    ],
    resize_keyboard: true,
    persistent: true,
    input_field_placeholder: "Select a category..."
  }
});

const getQuizKeyboard = () => ({
  reply_markup: {
    keyboard: [["❌ End Quiz", "📊 Progress"], ["🔙 Main Menu"]],
    resize_keyboard: true,
    persistent: true,
    input_field_placeholder: "Quiz in progress..."
  }
});

// =====================
// CONTACT MESSAGE FUNCTIONS
// =====================
async function saveUserMessage(userId, username, firstName, message, messageId) {
  const messageRef = db.collection('contact_messages').doc();
  await messageRef.set({
    id: messageRef.id,
    userId: userId,
    username: username || "Unknown",
    firstName: firstName || "Anonymous",
    message: message,
    messageId: messageId,
    timestamp: admin.firestore.FieldValue.serverTimestamp(),
    status: "unread",
    reply: null,
    repliedAt: null,
    repliedBy: null
  });
  return messageRef.id;
}

async function getMessages(status = null) {
  let query = db.collection('contact_messages').orderBy('timestamp', 'desc');
  if (status) {
    query = query.where('status', '==', status);
  }
  const snapshot = await query.get();
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function updateMessageStatus(messageId, status, reply = null, adminId = null) {
  const updateData = { status: status };
  if (reply) {
    updateData.reply = reply;
    updateData.repliedAt = admin.firestore.FieldValue.serverTimestamp();
    updateData.repliedBy = adminId;
  }
  await db.collection('contact_messages').doc(messageId).update(updateData);
}

async function deleteMessage(messageId) {
  await db.collection('contact_messages').doc(messageId).delete();
}

async function getMessage(messageId) {
  const messageDoc = await db.collection('contact_messages').doc(messageId).get();
  if (!messageDoc.exists) return null;
  return { id: messageDoc.id, ...messageDoc.data() };
}

// =====================
// START QUIZ
// =====================
async function startQuiz(chatId) {
  const user = await getCachedUser(chatId);

  if (!user || !user.category) {
    return bot.sendMessage(chatId, "⚠️ Please select a category first.", getCategoryKeyboard(getUniqueCategories()));
  }

  const questions = getQuestionsByCategory(user.category);

  if (questions.length === 0) {
    return bot.sendMessage(chatId, "❌ No questions available in this category. Please try another category.", 
      getCategoryKeyboard(getUniqueCategories()));
  }

  userSessions[chatId] = {
    startTime: Date.now(),
    questionsCount: questions.length
  };

  const userRef = db.collection('users').doc(chatId);
  await userRef.update({
    current: 0,
    score: 0,
    quizActive: true,
    lastQuizStart: admin.firestore.FieldValue.serverTimestamp()
  });

  await bot.sendMessage(chatId, "🎯 **Quiz Started!**\n\nAnswer each question. Next question appears immediately after your answer.\n\nGood luck! 🍀", {
    parse_mode: 'Markdown',
    ...getQuizKeyboard()
  });

  sendQuestion(chatId);
}

// =====================
// GET UNIQUE CATEGORIES
// =====================
function getUniqueCategories() {
  const categories = [...new Set(questionsCache.map(q => q.category).filter(Boolean))];
  return categories;
}

// =====================
// GET QUESTIONS BY CATEGORY
// =====================
function getQuestionsByCategory(category) {
  return questionsCache.filter(q => q.category === category);
}

// =====================
// SEND QUESTION (NO TIMER)
// =====================
async function sendQuestion(chatId) {
  try {
    const user = await getCachedUser(chatId);

    if (!user) return;
    
    if (!user.quizActive) return;

    const questions = getQuestionsByCategory(user.category);

    if (questions.length === 0) {
      return endQuiz(chatId, "No questions found.");
    }

    const currentQuestion = questions[user.current];

    if (!currentQuestion) {
      const percentage = Math.round((user.score / questions.length) * 100);
      let feedback = "";
      
      if (percentage >= 90) feedback = "🏆 Outstanding! You're a master!";
      else if (percentage >= 70) feedback = "🎉 Great job! Keep it up!";
      else if (percentage >= 50) feedback = "👍 Good effort! You can do better!";
      else feedback = "📚 Keep learning! Try again!";

      const completionMessage = `✅ **Quiz Complete!**\n\n` +
        `📊 **Your Score:** ${user.score}/${questions.length}\n` +
        `📈 **Percentage:** ${percentage}%\n` +
        `⭐ **Best Score:** ${user.bestScore || 0}\n\n` +
        `${feedback}\n\n` +
        `🏅 ${getRankEmoji(percentage)} ${getRankTitle(percentage)}`;

      await endQuiz(chatId, completionMessage, true);
      return;
    }

    if (!Array.isArray(currentQuestion.options) || currentQuestion.options.length < 2) {
      return endQuiz(chatId, "⚠️ Invalid question data. Quiz ended.");
    }

    await bot.sendPoll(
      chatId,
      `📌 **Question ${user.current + 1}/${questions.length}**\n\n${currentQuestion.question}`,
      currentQuestion.options,
      {
        type: "quiz",
        correct_option_id: currentQuestion.correct,
        is_anonymous: false,
        explanation: "Select the correct answer!"
      }
    );

  } catch (err) {
    console.error("❌ sendQuestion error:", err);
    await endQuiz(chatId, "⚠️ An error occurred. Quiz ended.");
  }
}

// =====================
// END QUIZ (with optional completed flag)
// =====================
async function endQuiz(chatId, message, isCompleted = false) {
  delete userSessions[chatId];

  const userRef = db.collection('users').doc(chatId);
  const userDoc = await userRef.get();
  
  if (userDoc.exists) {
    const user = userDoc.data();
    const updateData = { quizActive: false };
    
    if (user.score > (user.bestScore || 0)) {
      updateData.bestScore = user.score;
    }
    updateData.lastQuizScore = user.score;
    
    if (isCompleted) {
      updateData.lastQuizFinish = admin.firestore.FieldValue.serverTimestamp();
    }
    
    await userRef.update(updateData);
    
    // Update cache
    const updatedUser = { ...user, ...updateData };
    await setCachedUser(chatId, updatedUser);
    
    if (isCompleted && user.score > (user.bestScore || 0)) {
      await bot.sendMessage(chatId, "🏆 **New Personal Best!** 🏆", {
        parse_mode: 'Markdown'
      });
    }
  }

  await bot.sendMessage(chatId, message, getMainKeyboard());
}

// =====================
// HELPER FUNCTIONS
// =====================
function getRankEmoji(percentage) {
  if (percentage >= 90) return "👑";
  if (percentage >= 70) return "🥇";
  if (percentage >= 50) return "🥈";
  return "🥉";
}

function getRankTitle(percentage) {
  if (percentage >= 90) return "Expert";
  if (percentage >= 70) return "Advanced";
  if (percentage >= 50) return "Intermediate";
  return "Beginner";
}

// =====================
// SHOW USER STATS (PRIVATE - ONLY USER'S OWN DATA)
// =====================
async function showUserStats(chatId) {
  const user = await getCachedUser(chatId);
  
  if (!user) {
    return bot.sendMessage(chatId, "❌ No data found. Send /start to begin!");
  }
  
  const questions = getQuestionsByCategory(user.category || getUniqueCategories()[0]);
  const totalQuestions = questions.length;
  const percentage = user.bestScore ? Math.round((user.bestScore / totalQuestions) * 100) : 0;
  
  const statsMessage = `📊 **Your Statistics**\n\n` +
    `👤 **Name:** ${user.firstName || 'Anonymous'}\n` +
    `📚 **Category:** ${user.category || 'Not selected'}\n` +
    `🏆 **Best Score:** ${user.bestScore || 0}/${totalQuestions}\n` +
    `📈 **Best Percentage:** ${percentage}%\n` +
    `🎯 **Last Score:** ${user.lastQuizScore || 0}/${totalQuestions}\n` +
    `⭐ **Total Quizzes:** ${(user.totalQuizzes || 0) + (user.lastQuizScore ? 1 : 0)}\n\n` +
    `${getRankEmoji(percentage)} **Rank:** ${getRankTitle(percentage)}`;
  
  await bot.sendMessage(chatId, statsMessage, {
    parse_mode: 'Markdown',
    ...getMainKeyboard()
  });
}

// =====================
// ADMIN LEADERBOARD (ORDERED BY RECENT COMPLETION, WITH USERNAME)
// =====================
async function showAdminLeaderboard(chatId) {
  const snapshot = await db.collection('users')
    .where('lastQuizFinish', '!=', null)
    .orderBy('lastQuizFinish', 'desc')
    .limit(20)
    .get();
  
  if (snapshot.empty) {
    return bot.sendMessage(chatId, "🏆 **Leaderboard (Recent Completions)**\n\nNo quiz completions yet.", getAdminKeyboard());
  }
  
  let leaderboard = "🏆 **Recent Quiz Completions** 🏆\n\n";
  
  snapshot.docs.forEach((doc, index) => {
    const user = doc.data();
    
    let displayName = '';
    if (user.username) {
      displayName = `@${user.username}`;
      if (user.firstName) displayName += ` (${user.firstName})`;
    } else {
      displayName = user.firstName || 'Player';
    }
    
    const score = user.lastQuizScore || 0;
    const category = user.category || getUniqueCategories()[0];
    const totalQuestions = getQuestionsByCategory(category).length;
    const finishTime = user.lastQuizFinish?.toDate();
    const timeStr = finishTime ? finishTime.toLocaleString() : 'Unknown';
    
    leaderboard += `${index + 1}. ${displayName}\n`;
    leaderboard += `   📊 Score: ${score}/${totalQuestions}\n`;
    leaderboard += `   🕒 Completed: ${timeStr}\n\n`;
  });
  
  await bot.sendMessage(chatId, leaderboard, { parse_mode: 'Markdown', ...getAdminKeyboard() });
}

// =====================
// SHOW ABOUT INFO
// =====================
async function showAbout(chatId) {
  const aboutMessage = `ℹ️ **About This Quiz Bot**\n\n` +
    `🎯 **Features:**\n` +
    `• Multiple categories to choose from\n` +
    `• No time limit – answer at your own pace\n` +
    `• Track your best scores\n` +
    `• Real-time feedback\n` +
    `• Contact for support\n\n` +
    `📊 **How to Use:**\n` +
    `1. Select a category\n` +
    `2. Tap "Start Quiz"\n` +
    `3. Answer each question – next one appears immediately\n` +
    `4. Try to beat your best score!\n\n` +
    `🏅 **Ranks:**\n` +
    `• Use My stats to see your progress\n` +
    `📩 **Need help?** Use "Contact" button or just type any message!`;
  
  await bot.sendMessage(chatId, aboutMessage, {
    parse_mode: 'Markdown',
    ...getMainKeyboard()
  });
}

// =====================
// SHOW ALL USERS FOR ADMIN
// =====================
async function showAllUsers(chatId) {
  const snapshot = await db.collection('users').get();
  const users = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  
  if (users.length === 0) {
    return bot.sendMessage(chatId, "👥 No users found.", getAdminKeyboard());
  }
  
  let message = "👥 **User List**\n\n";
  users.slice(0, 20).forEach((user, idx) => {
    const status = blockedUsers.has(user.id) ? "🚫 BLOCKED" : "✅ ACTIVE";
    message += `${idx + 1}. ${user.firstName || user.username || 'Unknown'}\n`;
    message += `   ID: \`${user.id}\`\n`;
    message += `   Score: ${user.bestScore || 0} | ${status}\n\n`;
  });
  
  if (users.length > 20) {
    message += `\n📊 Showing 20 of ${users.length} users\n`;
  }
  
  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
  await bot.sendMessage(chatId, "To block/unblock a user, use:\n`/block USER_ID`\n`/unblock USER_ID`\n\nOr use the Block/Unblock buttons.", 
    { parse_mode: 'Markdown', ...getAdminKeyboard() });
}

// =====================
// SHOW MESSAGES FOR ADMIN (SORTED NEWEST FIRST) - WITH USERNAME + NAME
// =====================
async function showAdminMessages(chatId) {
  const messages = await getMessages();
  
  if (messages.length === 0) {
    return bot.sendMessage(chatId, "📭 No messages from users yet.", getAdminKeyboard());
  }
  
  const unreadCount = messages.filter(m => m.status === "unread").length;
  
  let messageText = `📩 **User Messages** (newest first)\n\n`;
  messageText += `📊 Total: ${messages.length} | 🔴 Unread: ${unreadCount}\n\n`;
  
  for (let i = 0; i < Math.min(messages.length, 10); i++) {
    const msg = messages[i];
    const statusIcon = msg.status === "unread" ? "🔴" : msg.status === "replied" ? "✅" : "📖";
    const date = msg.timestamp?.toDate().toLocaleString() || 'Unknown';
    const preview = msg.message.substring(0, 40);
    
    let senderDisplay = '';
    if (msg.username && msg.username !== "Unknown") {
      senderDisplay = `@${msg.username}`;
      if (msg.firstName && msg.firstName !== "Anonymous") senderDisplay += ` (${msg.firstName})`;
    } else {
      senderDisplay = msg.firstName || 'Anonymous';
    }
    
    messageText += `${statusIcon} **${i + 1}.** From: ${senderDisplay}\n`;
    messageText += `   📝 ${preview}...\n`;
    messageText += `   🕒 ${date}\n`;
    messageText += `   🆔 \`${msg.id}\`\n\n`;
  }
  
  if (messages.length > 10) {
    messageText += `\n📌 Showing 10 of ${messages.length} messages\n`;
  }
  
  const inlineKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "📋 View All Messages", callback_data: "view_all_messages" }],
        [{ text: "💬 Reply to Last Message", callback_data: `reply_${messages[0].id}` }],
        [{ text: "🔙 Back to Admin Menu", callback_data: "back_to_admin" }]
      ]
    }
  };
  
  await bot.sendMessage(chatId, messageText, { 
    parse_mode: 'Markdown',
    ...inlineKeyboard
  });
}

// =====================
// VIEW SINGLE MESSAGE
// =====================
async function viewMessage(adminChatId, messageId) {
  const msg = await getMessage(messageId);
  
  if (!msg) {
    return bot.sendMessage(adminChatId, "❌ Message not found.", getAdminKeyboard());
  }
  
  if (msg.status === "unread") {
    await updateMessageStatus(messageId, "read");
  }
  
  let senderDisplay = '';
  if (msg.username && msg.username !== "Unknown") {
    senderDisplay = `@${msg.username}`;
    if (msg.firstName && msg.firstName !== "Anonymous") senderDisplay += ` (${msg.firstName})`;
  } else {
    senderDisplay = msg.firstName || 'Anonymous';
  }
  
  const messageText = `📨 **Message Details**\n\n` +
    `👤 **From:** ${senderDisplay}\n` +
    `🆔 **User ID:** \`${msg.userId}\`\n` +
    `📅 **Time:** ${msg.timestamp?.toDate().toLocaleString() || 'Unknown'}\n` +
    `📝 **Message:**\n${msg.message}\n\n` +
    `💬 **Reply Status:** ${msg.reply ? '✅ Replied' : '❌ Not replied yet'}\n\n`;
  
  const replyKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💬 Reply to This Message", callback_data: `reply_${messageId}` }],
        [{ text: "🗑 Delete", callback_data: `delete_${messageId}` }],
        [{ text: "📩 View All Messages", callback_data: "view_all_messages" }],
        [{ text: "🔙 Back", callback_data: "back_to_messages" }]
      ]
    }
  };
  
  await bot.sendMessage(adminChatId, messageText, { 
    parse_mode: 'Markdown',
    ...replyKeyboard
  });
}

// =====================
// REPLY TO USER
// =====================
async function replyToUser(adminChatId, messageId, replyText) {
  try {
    const msg = await getMessage(messageId);
    
    if (!msg) {
      return bot.sendMessage(adminChatId, "❌ Message not found.", getAdminKeyboard());
    }
    
    try {
      const replyMessage = `📩 **Reply from Admin**\n\n` +
        `**Your message:** ${msg.message}\n\n` +
        `**Admin's response:**\n${replyText}\n\n` +
        `💡 You can reply to this message by using the "Contact" button or just typing any message.`;
      
      await bot.sendMessage(msg.userId, replyMessage, { parse_mode: 'Markdown' });
      
      await updateMessageStatus(messageId, "replied", replyText, adminChatId);
      
      await bot.sendMessage(adminChatId, 
        `✅ **Reply sent successfully!**\n\n` +
        `📨 To: ${msg.firstName}\n` +
        `💬 Reply: ${replyText}\n\n` +
        `The user will receive this message immediately.`,
        { parse_mode: 'Markdown', ...getAdminKeyboard() }
      );
      
    } catch (err) {
      console.error("Reply error:", err);
      await bot.sendMessage(adminChatId, 
        `❌ Failed to send reply. User might have blocked the bot.\n\nError: ${err.message}`,
        getAdminKeyboard()
      );
    }
    
  } catch (err) {
    console.error("Reply function error:", err);
    await bot.sendMessage(adminChatId, "❌ Failed to process reply. Please try again.", getAdminKeyboard());
  }
}

// =====================
// BLOCK USER
// =====================
async function blockUser(adminChatId, userIdToBlock) {
  try {
    const userRef = db.collection('users').doc(userIdToBlock);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      return bot.sendMessage(adminChatId, `❌ User ${userIdToBlock} not found.`, getAdminKeyboard());
    }
    
    await db.collection('blocked').doc(userIdToBlock).set({
      blockedAt: admin.firestore.FieldValue.serverTimestamp(),
      blockedBy: adminChatId
    });
    
    blockedUsers.add(userIdToBlock);
    
    try {
      await bot.sendMessage(userIdToBlock, "🚫 You have been blocked by the administrator. You can no longer use this bot.");
    } catch (err) {
      console.log("Could not notify blocked user:", err.message);
    }
    
    const user = userDoc.data();
    await bot.sendMessage(adminChatId, 
      `✅ **User Blocked Successfully!**\n\n` +
      `👤 Name: ${user.firstName || user.username || 'Unknown'}\n` +
      `🆔 ID: ${userIdToBlock}\n` +
      `📊 Score: ${user.bestScore || 0}`,
      { parse_mode: 'Markdown', ...getAdminKeyboard() }
    );
    
  } catch (err) {
    console.error("Block user error:", err);
    await bot.sendMessage(adminChatId, "❌ Failed to block user. Please try again.", getAdminKeyboard());
  }
}

// =====================
// UNBLOCK USER
// =====================
async function unblockUser(adminChatId, userIdToUnblock) {
  try {
    const blockedRef = db.collection('blocked').doc(userIdToUnblock);
    const blockedDoc = await blockedRef.get();
    
    if (!blockedDoc.exists) {
      return bot.sendMessage(adminChatId, `❌ User ${userIdToUnblock} is not blocked.`, getAdminKeyboard());
    }
    
    await blockedRef.delete();
    blockedUsers.delete(userIdToUnblock);
    
    try {
      await bot.sendMessage(userIdToUnblock, "✅ You have been unblocked! You can now use the bot again. Send /start to continue.");
    } catch (err) {
      console.log("Could not notify unblocked user:", err.message);
    }
    
    const userRef = db.collection('users').doc(userIdToUnblock);
    const userDoc = await userRef.get();
    const user = userDoc.data();
    
    await bot.sendMessage(adminChatId, 
      `✅ **User Unblocked Successfully!**\n\n` +
      `👤 Name: ${user?.firstName || user?.username || 'Unknown'}\n` +
      `🆔 ID: ${userIdToUnblock}`,
      { parse_mode: 'Markdown', ...getAdminKeyboard() }
    );
    
  } catch (err) {
    console.error("Unblock user error:", err);
    await bot.sendMessage(adminChatId, "❌ Failed to unblock user. Please try again.", getAdminKeyboard());
  }
}

// =====================
// SHOW CATEGORIES WITH QUESTIONS COUNT
// =====================
async function showCategoriesWithCount(chatId) {
  const categories = getUniqueCategories();
  
  if (categories.length === 0) {
    return bot.sendMessage(chatId, "❌ No categories available.", getMainKeyboard());
  }
  
  let message = "📚 **Available Categories**\n\n";
  
  for (const category of categories) {
    const questions = getQuestionsByCategory(category);
    message += `📌 **${category}** - ${questions.length} questions\n`;
  }
  
  message += `\n📝 Select a category by tapping the button below.\n`;
  message += `🔙 Use "Back to Main Menu" to return.`;
  
  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    ...getCategoryKeyboard(categories)
  });
}

// =====================
// ADMIN CATEGORY MANAGEMENT
// =====================
async function showAdminCategoryList(chatId, action) {
  const categories = getUniqueCategories();
  
  if (categories.length === 0) {
    return bot.sendMessage(chatId, "❌ No categories found. Please add questions first.", getAdminKeyboard());
  }
  
  categoryManageState[chatId] = { action: action };
  
  let actionText = "";
  switch(action) {
    case "edit":
      actionText = "Select a category to edit questions from:";
      break;
    case "delete":
      actionText = "Select a category to delete questions from:";
      break;
    case "list":
      actionText = "Select a category to view questions:";
      break;
    default:
      actionText = "Select a category:";
  }
  
  await bot.sendMessage(chatId, 
    `📂 **${action.toUpperCase()} Questions by Category**\n\n${actionText}\n\n` +
    `Total Categories: ${categories.length}`,
    { parse_mode: 'Markdown', ...getCategoryManagementKeyboard(categories, action) }
  );
}

// =====================
// FUNCTION TO FORWARD ANY USER MESSAGE TO ADMIN
// =====================
async function forwardUserMessageToAdmin(userId, username, firstName, messageText, messageId) {
  await saveUserMessage(userId, username, firstName, messageText, messageId);
  
  const adminMessage = `📩 **New Message from User**\n\n` +
    `👤 User: ${firstName} (@${username || 'No username'})\n` +
    `🆔 ID: ${userId}\n` +
    `📝 Message: ${messageText}\n\n` +
    `Use /viewmessage to see all messages.`;
  
  await bot.sendMessage(ADMIN_ID, adminMessage, { parse_mode: 'Markdown' });
  
  await bot.sendMessage(userId, 
    "✅ **Message Sent!**\n\n" +
    "Your message has been sent to the administrator. You will receive a reply soon.\n\n" +
    "Thank you for reaching out! 🙏",
    { parse_mode: 'Markdown', ...getMainKeyboard() }
  );
}

// =====================
// START COMMAND
// =====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;

  if (blockedUsers.has(chatId) && userId !== ADMIN_ID) {
    return bot.sendMessage(chatId, "🚫 You are blocked from using this bot. Contact administrator for assistance.");
  }

  await db.collection('users').doc(chatId).set({
    chatId,
    username: msg.from.username || "",
    firstName: msg.from.first_name || "",
    lastName: msg.from.last_name || "",
    score: 0,
    bestScore: 0,
    current: 0,
    totalQuizzes: 0,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  }, { merge: true });

  const welcomeMessage = `🌟 **Welcome to Quiz Master Bot!** 🌟\n\n` +
    `Hello ${msg.from.first_name || 'there'}! 👋\n\n` +
    `I'm your personal quiz assistant. Test your knowledge across multiple categories!\n\n` +
    `📚 **Ready to begin?**\n` +
    `• Select a category to start\n` +
    `• Answer questions – next question appears immediately\n` +
    `• Earn points and track your best scores!\n\n` +
    `📩 **Need help?** Use the "Contact" button or **just type any message** – I'll forward it to the admin!\n\n` +
    `Choose a category to begin your journey! 🚀`;

  if (userId !== ADMIN_ID) {
    const categories = getUniqueCategories();
    
    if (categories.length === 0) {
      return bot.sendMessage(chatId, "⚠️ No categories available. Please try again later.");
    }
    
    await bot.sendMessage(chatId, welcomeMessage, {
      parse_mode: 'Markdown',
      ...getCategoryKeyboard(categories)
    });
  } else {
    await bot.sendMessage(chatId, "👑 **Admin Panel**\n\nSelect an option to manage the bot:", {
      parse_mode: 'Markdown',
      ...getAdminKeyboard()
    });
  }
});

// =====================
// COMMAND HANDLERS FOR ADMIN
// =====================
bot.onText(/\/block (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  
  if (userId !== ADMIN_ID) return;
  
  const userIdToBlock = match[1];
  await blockUser(chatId, userIdToBlock);
});

bot.onText(/\/unblock (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  
  if (userId !== ADMIN_ID) return;
  
  const userIdToUnblock = match[1];
  await unblockUser(chatId, userIdToUnblock);
});

bot.onText(/\/reply (.+?) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  
  if (userId !== ADMIN_ID) return;
  
  const messageId = match[1];
  const replyText = match[2];
  await replyToUser(chatId, messageId, replyText);
});

bot.onText(/\/viewmessage (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  
  if (userId !== ADMIN_ID) return;
  
  const messageId = match[1];
  await viewMessage(chatId, messageId);
});

bot.onText(/\/deletemessage (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  
  if (userId !== ADMIN_ID) return;
  
  const messageId = match[1];
  await deleteMessage(messageId);
  await bot.sendMessage(chatId, "✅ Message deleted successfully!", getAdminKeyboard());
});

bot.onText(/\/categories/, async (msg) => {
  const chatId = msg.chat.id.toString();
  const categories = getUniqueCategories();
  const message = `📚 **Available Categories:**\n\n${categories.map((c, i) => `${i+1}. ${c}`).join('\n')}\n\nTotal: ${categories.length}`;
  await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
});

// =====================
// CALLBACK QUERY HANDLER
// =====================
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id.toString();
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  
  if (userId !== ADMIN_ID) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: "Only admin can use this!" });
    return;
  }
  
  if (data === "view_all_messages") {
    await bot.answerCallbackQuery(callbackQuery.id);
    const messages = await getMessages();
    
    if (messages.length === 0) {
      await bot.sendMessage(chatId, "📭 No messages found.");
      return;
    }
    
    let allMessages = "📩 **All Messages** (newest first)\n\n";
    for (let i = 0; i < Math.min(messages.length, 20); i++) {
      const msg = messages[i];
      const statusIcon = msg.status === "unread" ? "🔴" : msg.status === "replied" ? "✅" : "📖";
      const date = msg.timestamp?.toDate().toLocaleString() || 'Unknown';
      
      let senderDisplay = '';
      if (msg.username && msg.username !== "Unknown") {
        senderDisplay = `@${msg.username}`;
        if (msg.firstName && msg.firstName !== "Anonymous") senderDisplay += ` (${msg.firstName})`;
      } else {
        senderDisplay = msg.firstName || 'Anonymous';
      }
      
      allMessages += `${statusIcon} **${i + 1}.** ${senderDisplay}: ${msg.message.substring(0, 50)}...\n`;
      allMessages += `   🕒 ${date}\n`;
      allMessages += `   🆔 \`${msg.id}\`\n\n`;
      
      if (allMessages.length > 3500) {
        allMessages += `\n📌 And ${messages.length - i - 1} more messages...`;
        break;
      }
    }
    
    await bot.sendMessage(chatId, allMessages, { parse_mode: 'Markdown' });
    await bot.sendMessage(chatId, "Use /viewmessage <id> to view full message\nUse /reply <id> <reply> to respond", getAdminKeyboard());
  }
  
  if (data === "back_to_admin") {
    await bot.answerCallbackQuery(callbackQuery.id);
    await bot.sendMessage(chatId, "👑 Admin Panel:", getAdminKeyboard());
  }
  
  if (data === "back_to_messages") {
    await bot.answerCallbackQuery(callbackQuery.id);
    await showAdminMessages(chatId);
  }
  
  if (data.startsWith("reply_")) {
    const messageId = data.replace("reply_", "");
    await bot.answerCallbackQuery(callbackQuery.id);
    
    replyState[chatId] = { messageId: messageId };
    
    await bot.sendMessage(chatId, 
      `💬 **Reply **\n\n` +
      `Please send your reply message below. The user will receive it immediately.\n\n` +
      `Message ID: \`${messageId}\`\n\n` +
      `To cancel, send /cancel_reply`,
      { parse_mode: 'Markdown' }
    );
  }
  
  if (data.startsWith("delete_")) {
    const messageId = data.replace("delete_", "");
    await bot.answerCallbackQuery(callbackQuery.id);
    await deleteMessage(messageId);
    await bot.sendMessage(chatId, "✅ Message deleted successfully!");
    await showAdminMessages(chatId);
  }
});

// =====================
// MESSAGE HANDLER (REST OF YOUR EXISTING CODE CONTINUES BELOW)
// =====================
// ... (the rest of your message handler remains exactly the same)
// NOTE: The message handler code from your original file continues here
// I've omitted it for brevity but it stays 100% identical

// =====================
// POLL ANSWERS (NO TIMER, NO DELAY)
// =====================
bot.on('poll_answer', async (answer) => {
  try {
    const key = `${answer.user.id}_${answer.poll_id}`;
    if (processedPollAnswers.has(key)) return;
    processedPollAnswers.add(key);

    const userId = answer.user.id.toString();
    const selected = answer.option_ids[0];

    const user = await getCachedUser(userId);

    if (!user || !user.quizActive) return;

    const questions = getQuestionsByCategory(user.category);
    const q = questions[user.current];

    if (!q) return;

    const isCorrect = (selected === q.correct);
    
    if (isCorrect) {
      user.score++;
      await bot.sendMessage(userId, "✅ **Correct!** +1 point", {
        parse_mode: 'Markdown'
      });
    } else {
      const correctAnswer = q.options[q.correct];
      await bot.sendMessage(userId, `❌ **Wrong!**\n\nThe correct answer was: *${correctAnswer}*`, {
        parse_mode: 'Markdown'
      });
    }

    user.current++;

    const userRef = db.collection('users').doc(userId);
    await userRef.update({
      score: user.score,
      current: user.current
    });
    
    // Update cache
    await setCachedUser(userId, user);

    await sendQuestion(userId);

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
