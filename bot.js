const TelegramBot = require('node-telegram-bot-api');
const express = require('express');
const admin = require('firebase-admin');

// =====================
// CONFIG - MULTIPLE ADMINS
// =====================
const token = process.env.TOKEN;

// Add your admin IDs here (as many as you need)
const ADMIN_IDS = [
  1983262664,   // your ID
  6412454382
];

const adminSet = new Set(ADMIN_IDS);

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
console.log(`👥 Admins: ${ADMIN_IDS.join(', ')}`);

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
setInterval(loadQuestions, 1000 * 60 * 5);
setInterval(loadBlockedUsers, 1000 * 60);

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
// ADMIN KEYBOARD (3 COLUMNS)
// =====================
const getAdminKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ["➕ Add Question", "✏️ Edit Question", "🗑 Delete Question"],
      ["📋 List Questions", "📢 Broadcast", "👥 Users"],
      ["🚫 Block User", "✅ Unblock User", "📊 Leaderboard"],
      ["📈 Stats", "📩 View Messages", "🔙 Back"]
    ],
    resize_keyboard: true,
    input_field_placeholder: "Choose an option..."
  }
});

// =====================
// CATEGORY MANAGEMENT KEYBOARD (3 COLUMNS)
// =====================
const getCategoryManagementKeyboard = (categories, action) => {
  const rows = [];
  for (let i = 0; i < categories.length; i += 3) {
    rows.push(categories.slice(i, i + 3).map(cat => `📚 ${cat}`));
  }
  rows.push(["🔙 Back to Admin Menu"]);
  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      input_field_placeholder: "Select a category..."
    }
  };
};

// =====================
// PROFESSIONAL USER KEYBOARDS (3 COLUMNS)
// =====================
const getMainKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ["🎯 Start Quiz", "📊 My Stats", "ℹ️ About"],
      ["🔄 Change Category", "📩 Contact", "🔙 Main Menu"]
    ],
    resize_keyboard: true,
    persistent: true,
    input_field_placeholder: "Choose an option..."
  }
});

const getCategoryKeyboard = (categories) => {
  const rows = [];
  for (let i = 0; i < categories.length; i += 3) {
    rows.push(categories.slice(i, i + 3).map(c => `📚 ${c}`));
  }
  rows.push(["🔙 Back to Main Menu"]);
  return {
    reply_markup: {
      keyboard: rows,
      resize_keyboard: true,
      persistent: true,
      input_field_placeholder: "Select a category..."
    }
  };
};

const getQuizKeyboard = () => ({
  reply_markup: {
    keyboard: [["❌ End Quiz", "📊 Progress", "🔙 Main Menu"]],
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
  const userRef = db.collection('users').doc(chatId);
  const userDoc = await userRef.get();
  const user = userDoc.data();

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
    const userRef = db.collection('users').doc(chatId);
    const userDoc = await userRef.get();

    if (!userDoc.exists) return;

    const user = userDoc.data();
    
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
  const userRef = db.collection('users').doc(chatId);
  const userDoc = await userRef.get();
  
  if (!userDoc.exists) {
    return bot.sendMessage(chatId, "❌ No data found. Send /start to begin!");
  }
  
  const user = userDoc.data();
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
// REPLY TO USER (via message ID)
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
// FORWARD USER MESSAGE TO ADMIN (WITH INLINE REPLY & DELETE BUTTONS)
// =====================
async function forwardUserMessageToAdmin(userId, username, firstName, messageText, messageId) {
  const docId = await saveUserMessage(userId, username, firstName, messageText, messageId);
  
  const inlineKeyboard = {
    reply_markup: {
      inline_keyboard: [
        [{ text: "💬 Reply", callback_data: `reply_direct_${userId}_${docId}` }],
        [{ text: "🗑 Delete", callback_data: `delete_direct_${docId}` }]
      ]
    }
  };
  
  // Send to ALL admins
  for (const adminId of ADMIN_IDS) {
    try {
      const adminMessage = `📩 **New Message from User**\n\n` +
        `👤 User: ${firstName} (@${username || 'No username'})\n` +
        `🆔 ID: ${userId}\n` +
        `📝 Message: ${messageText}`;
      await bot.sendMessage(adminId, adminMessage, { 
        parse_mode: 'Markdown', 
        ...inlineKeyboard 
      });
    } catch (err) {
      console.error(`Failed to notify admin ${adminId}:`, err.message);
    }
  }
  
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

  if (blockedUsers.has(chatId) && !adminSet.has(userId)) {
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

  if (!adminSet.has(userId)) {
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
  
  if (!adminSet.has(userId)) return;
  
  const userIdToBlock = match[1];
  await blockUser(chatId, userIdToBlock);
});

bot.onText(/\/unblock (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  
  if (!adminSet.has(userId)) return;
  
  const userIdToUnblock = match[1];
  await unblockUser(chatId, userIdToUnblock);
});

bot.onText(/\/reply (.+?) (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  
  if (!adminSet.has(userId)) return;
  
  const messageId = match[1];
  const replyText = match[2];
  await replyToUser(chatId, messageId, replyText);
});

bot.onText(/\/viewmessage (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  
  if (!adminSet.has(userId)) return;
  
  const messageId = match[1];
  await viewMessage(chatId, messageId);
});

bot.onText(/\/deletemessage (.+)/, async (msg, match) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  
  if (!adminSet.has(userId)) return;
  
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
// CALLBACK QUERY HANDLER (includes direct reply and delete)
// =====================
bot.on('callback_query', async (callbackQuery) => {
  const chatId = callbackQuery.message.chat.id.toString();
  const userId = callbackQuery.from.id;
  const data = callbackQuery.data;
  
  if (!adminSet.has(userId)) {
    await bot.answerCallbackQuery(callbackQuery.id, { text: "Only admin can use this!" });
    return;
  }
  
  // Direct reply from user message notification
  if (data.startsWith("reply_direct_")) {
    const parts = data.split('_');
    const targetUserId = parts[2];
    const messageId = parts[3];
    await bot.answerCallbackQuery(callbackQuery.id);
    
    replyState[chatId] = { directUserId: targetUserId, messageId: messageId };
    await bot.sendMessage(chatId, 
      `💬 **Reply to user**\n\nSend your reply message below. The user will receive it immediately.\n\nTo cancel, send /cancel_reply`,
      { parse_mode: 'Markdown' }
    );
    return;
  }
  
  // Direct delete from user message notification
  if (data.startsWith("delete_direct_")) {
    const messageId = data.replace("delete_direct_", "");
    await bot.answerCallbackQuery(callbackQuery.id);
    await deleteMessage(messageId);
    await bot.editMessageText("✅ Message deleted", {
      chat_id: callbackQuery.message.chat.id,
      message_id: callbackQuery.message.message_id
    });
    return;
  }
  
  // Existing callbacks
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
      `💬 **Reply**\n\n` +
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
// MESSAGE HANDLER
// =====================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  const text = msg.text;

  if (!text) return;

  if (blockedUsers.has(chatId) && !adminSet.has(userId)) {
    return bot.sendMessage(chatId, "🚫 You are blocked from using this bot.");
  }

  await db.collection('users').doc(chatId).set({
    username: msg.from.username || "",
    firstName: msg.from.first_name || "",
    lastName: msg.from.last_name || ""
  }, { merge: true });

  // =====================
  // HANDLE REPLY STATE FOR ADMIN (direct reply from inline button)
  // =====================
  if (replyState[chatId] && adminSet.has(userId)) {
    if (text === '/cancel_reply') {
      delete replyState[chatId];
      return bot.sendMessage(chatId, "❌ Reply cancelled.", getAdminKeyboard());
    }
    
    if (replyState[chatId].directUserId) {
      const targetUserId = replyState[chatId].directUserId;
      const messageId = replyState[chatId].messageId;
      
      try {
        const replyMessage = `📩 **Reply from Admin**\n\n**Admin's response:**\n${text}`;
        await bot.sendMessage(targetUserId, replyMessage, { parse_mode: 'Markdown' });
        
        if (messageId) {
          await updateMessageStatus(messageId, "replied", text, chatId);
        }
        
        await bot.sendMessage(chatId, 
          `✅ **Reply sent successfully!**\n\nTo user ID: ${targetUserId}\nReply: ${text}`,
          getAdminKeyboard()
        );
      } catch (err) {
        console.error("Direct reply error:", err);
        await bot.sendMessage(chatId, 
          `❌ Failed to send reply. Error: ${err.message}`,
          getAdminKeyboard()
        );
      }
      delete replyState[chatId];
      return;
    }
    
    if (replyState[chatId].messageId) {
      await replyToUser(chatId, replyState[chatId].messageId, text);
      delete replyState[chatId];
      return;
    }
  }

  // =====================
  // ADMIN HANDLERS
  // =====================
  if (adminSet.has(userId)) {
    
    if (text === "🔙 Main Menu" || text === "🔙 Back to Admin Menu" || text === "🔙 Back") {
      delete adminState[chatId];
      delete editState[chatId];
      delete broadcastState[chatId];
      delete blockState[chatId];
      delete categoryManageState[chatId];
      delete replyState[chatId];
      return bot.sendMessage(chatId, "👑 **Admin Panel**\n\nSelect an option to manage the bot:", {
        parse_mode: 'Markdown',
        ...getAdminKeyboard()
      });
    }
    
    if (text === "📩 View Messages") {
      await showAdminMessages(chatId);
      return;
    }
    
    if (text === "📋 List Questions") {
      await showAdminCategoryList(chatId, "list");
      return;
    }
    
    if (text === "✏️ Edit Question") {
      await showAdminCategoryList(chatId, "edit");
      return;
    }
    
    if (text === "🗑 Delete Question") {
      await showAdminCategoryList(chatId, "delete");
      return;
    }
    
    if (categoryManageState[chatId]) {
      const cleanCategory = text.replace(/^📚 /, '');
      const categories = getUniqueCategories();
      
      if (categories.includes(cleanCategory)) {
        const questions = getQuestionsByCategory(cleanCategory);
        
        if (questions.length === 0) {
          await bot.sendMessage(chatId, `❌ No questions found in category: ${cleanCategory}`);
          delete categoryManageState[chatId];
          return bot.sendMessage(chatId, "Admin Panel:", getAdminKeyboard());
        }
        
        if (categoryManageState[chatId].action === "list") {
          let message = `📋 **Questions in ${cleanCategory}**\n\n`;
          questions.forEach((q, idx) => {
            message += `${idx + 1}. ${q.question}\n`;
            message += `   Options: ${q.options.join(', ')}\n`;
            message += `   Correct: ${q.options[q.correct]}\n\n`;
          });
          
          if (message.length > 4000) {
            await bot.sendMessage(chatId, `📋 Questions in ${cleanCategory}: ${questions.length} total`);
            for (let i = 0; i < questions.length; i += 5) {
              let chunk = `📋 **${cleanCategory}** (${i+1}-${Math.min(i+5, questions.length)})\n\n`;
              for (let j = i; j < Math.min(i+5, questions.length); j++) {
                chunk += `${j+1}. ${questions[j].question}\n`;
              }
              await bot.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
            }
          } else {
            await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
          }
          
          delete categoryManageState[chatId];
          return bot.sendMessage(chatId, "Admin Panel:", getAdminKeyboard());
        }
        
        if (categoryManageState[chatId].action === "edit") {
          let message = `✏️ **Edit Question - ${cleanCategory}**\n\n`;
          questions.forEach((q, idx) => {
            message += `${idx + 1}. ${q.question.substring(0, 50)}...\n`;
          });
          message += `\nSend the question number to edit (1-${questions.length}):`;
          
          adminState[chatId] = { 
            step: 'select_question', 
            category: cleanCategory,
            questions: questions 
          };
          delete categoryManageState[chatId];
          await bot.sendMessage(chatId, message);
          return;
        }
        
        if (categoryManageState[chatId].action === "delete") {
          let message = `🗑 **Delete Question - ${cleanCategory}**\n\n`;
          questions.forEach((q, idx) => {
            message += `${idx + 1}. ${q.question.substring(0, 50)}...\n`;
          });
          message += `\nSend the question number to delete (1-${questions.length}):`;
          
          adminState[chatId] = { 
            step: 'select_question_delete', 
            category: cleanCategory,
            questions: questions 
          };
          delete categoryManageState[chatId];
          await bot.sendMessage(chatId, message);
          return;
        }
      }
      
      if (text === "🔙 Back to Admin Menu") {
        delete categoryManageState[chatId];
        return bot.sendMessage(chatId, "Admin Panel:", getAdminKeyboard());
      }
    }
    
    if (adminState[chatId] && adminState[chatId].step === 'select_question') {
      const questionNumber = parseInt(text);
      if (isNaN(questionNumber) || questionNumber < 1 || questionNumber > adminState[chatId].questions.length) {
        return bot.sendMessage(chatId, `❌ Invalid number. Send a number between 1 and ${adminState[chatId].questions.length}`);
      }
      
      const selectedQuestion = adminState[chatId].questions[questionNumber - 1];
      adminState[chatId].questionData = selectedQuestion;
      adminState[chatId].step = 'choose_field';
      
      return bot.sendMessage(chatId, 
        `✏️ **Editing Question**\n\n` +
        `Category: ${selectedQuestion.category}\n` +
        `Question: ${selectedQuestion.question}\n\n` +
        `What do you want to edit?\n\n` +
        `1️⃣ Category\n` +
        `2️⃣ Question Text\n` +
        `3️⃣ Options\n` +
        `4️⃣ Correct Answer\n\n` +
        `Send the number (1-4):`
      );
    }
    
    if (adminState[chatId] && adminState[chatId].step === 'choose_field') {
      const choice = parseInt(text);
      if (isNaN(choice) || choice < 1 || choice > 4) {
        return bot.sendMessage(chatId, "❌ Send a number between 1 and 4.");
      }
      
      adminState[chatId].editField = choice;
      
      if (choice === 1) {
        adminState[chatId].step = 'edit_category';
        return bot.sendMessage(chatId, "📝 Send the new category name:");
      } else if (choice === 2) {
        adminState[chatId].step = 'edit_question_text';
        return bot.sendMessage(chatId, "📝 Send the new question text:");
      } else if (choice === 3) {
        adminState[chatId].step = 'edit_options';
        return bot.sendMessage(chatId, "📝 Send the new options (comma separated):\nExample: Option 1, Option 2, Option 3, Option 4");
      } else if (choice === 4) {
        adminState[chatId].step = 'edit_correct';
        return bot.sendMessage(chatId, `📝 Send the correct option number (1-${adminState[chatId].questionData.options.length}):`);
      }
    }
    
    if (adminState[chatId] && adminState[chatId].step === 'edit_category') {
      await db.collection('questions').doc(adminState[chatId].questionData.id).update({
        category: text
      });
      await loadQuestions();
      delete adminState[chatId];
      return bot.sendMessage(chatId, "✅ Category updated successfully!", getAdminKeyboard());
    }
    
    if (adminState[chatId] && adminState[chatId].step === 'edit_question_text') {
      await db.collection('questions').doc(adminState[chatId].questionData.id).update({
        question: text
      });
      await loadQuestions();
      delete adminState[chatId];
      return bot.sendMessage(chatId, "✅ Question text updated successfully!", getAdminKeyboard());
    }
    
    if (adminState[chatId] && adminState[chatId].step === 'edit_options') {
      const options = text.split(",").map(o => o.trim());
      if (options.length < 2) {
        return bot.sendMessage(chatId, "❌ Please provide at least 2 options separated by commas.");
      }
      await db.collection('questions').doc(adminState[chatId].questionData.id).update({
        options: options
      });
      await loadQuestions();
      delete adminState[chatId];
      return bot.sendMessage(chatId, "✅ Options updated successfully!", getAdminKeyboard());
    }
    
    if (adminState[chatId] && adminState[chatId].step === 'edit_correct') {
      const correctIndex = parseInt(text) - 1;
      if (isNaN(correctIndex) || correctIndex < 0 || correctIndex >= adminState[chatId].questionData.options.length) {
        return bot.sendMessage(chatId, `❌ Invalid. Send a number between 1 and ${adminState[chatId].questionData.options.length}`);
      }
      await db.collection('questions').doc(adminState[chatId].questionData.id).update({
        correct: correctIndex
      });
      await loadQuestions();
      delete adminState[chatId];
      return bot.sendMessage(chatId, "✅ Correct answer updated successfully!", getAdminKeyboard());
    }
    
    if (adminState[chatId] && adminState[chatId].step === 'select_question_delete') {
      const questionNumber = parseInt(text);
      if (isNaN(questionNumber) || questionNumber < 1 || questionNumber > adminState[chatId].questions.length) {
        return bot.sendMessage(chatId, `❌ Invalid number. Send a number between 1 and ${adminState[chatId].questions.length}`);
      }
      
      const questionToDelete = adminState[chatId].questions[questionNumber - 1];
      adminState[chatId].questionToDelete = questionToDelete;
      adminState[chatId].step = 'confirm_delete';
      
      return bot.sendMessage(chatId, 
        `⚠️ **Confirm Deletion**\n\n` +
        `Category: ${questionToDelete.category}\n` +
        `Question: ${questionToDelete.question}\n\n` +
        `Send "CONFIRM" to delete, or anything else to cancel.`
      );
    }
    
    if (adminState[chatId] && adminState[chatId].step === 'confirm_delete') {
      if (text === "CONFIRM") {
        await db.collection('questions').doc(adminState[chatId].questionToDelete.id).delete();
        await loadQuestions();
        delete adminState[chatId];
        return bot.sendMessage(chatId, "✅ Question deleted successfully!", getAdminKeyboard());
      } else {
        delete adminState[chatId];
        return bot.sendMessage(chatId, "❌ Deletion cancelled.", getAdminKeyboard());
      }
    }
    
    if (text === "📢 Broadcast") {
      broadcastState[chatId] = { step: 'message' };
      return bot.sendMessage(chatId, 
        "📢 *Broadcast Mode*\n\nSend the message you want to broadcast to all users.\n\n" +
        "You can send text, photo, video, or document.\n\nType /cancel to abort.",
        { parse_mode: 'Markdown' }
      );
    }
    
    if (broadcastState[chatId]) {
      if (text === '/cancel') {
        delete broadcastState[chatId];
        return bot.sendMessage(chatId, "❌ Broadcast cancelled.", getAdminKeyboard());
      }
      
      const usersSnapshot = await db.collection('users').get();
      const totalUsers = usersSnapshot.size;
      
      if (totalUsers === 0) {
        delete broadcastState[chatId];
        return bot.sendMessage(chatId, "❌ No users found to broadcast to.", getAdminKeyboard());
      }
      
      await bot.sendMessage(chatId, `📢 Broadcasting to ${totalUsers} users... This may take a while.`);
      
      let successCount = 0;
      let failCount = 0;
      
      for (const userDoc of usersSnapshot.docs) {
        const userData = userDoc.data();
        const userChatId = userData.chatId;
        
        if (blockedUsers.has(userChatId)) continue;
        
        try {
          if (msg.photo) {
            const photo = msg.photo[msg.photo.length - 1].file_id;
            await bot.sendPhoto(userChatId, photo, { caption: msg.caption || "" });
          } else if (msg.video) {
            await bot.sendVideo(userChatId, msg.video.file_id, { caption: msg.caption || "" });
          } else if (msg.document) {
            await bot.sendDocument(userChatId, msg.document.file_id, { caption: msg.caption || "" });
          } else if (text && text !== '/cancel') {
            await bot.sendMessage(userChatId, text);
          }
          successCount++;
        } catch (err) {
          console.error(`Failed to send to ${userChatId}:`, err.message);
          failCount++;
        }
        
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      
      delete broadcastState[chatId];
      
      return bot.sendMessage(chatId, 
        `✅ *Broadcast Complete!*\n\n` +
        `📨 Sent: ${successCount}\n` +
        `❌ Failed: ${failCount}\n` +
        `👥 Total: ${totalUsers}\n` +
        `🚫 Skipped (blocked): ${blockedUsers.size}`,
        { parse_mode: 'Markdown', ...getAdminKeyboard() }
      );
    }
    
    if (text === "👥 Users") {
      await showAllUsers(chatId);
      return;
    }
    
    if (text === "🚫 Block User") {
      blockState[chatId] = { step: 'block' };
      return bot.sendMessage(chatId, 
        "🚫 **Block User**\n\n" +
        "Send the User ID of the person you want to block.\n\n" +
        "You can find User IDs in the Users list.\n\n" +
        "Format: Send just the number (e.g., 123456789)\n\n" +
        "Send /cancel to abort.",
        { parse_mode: 'Markdown' }
      );
    }
    
    if (text === "✅ Unblock User") {
      blockState[chatId] = { step: 'unblock' };
      return bot.sendMessage(chatId, 
        "✅ **Unblock User**\n\n" +
        "Send the User ID of the person you want to unblock.\n\n" +
        "Format: Send just the number (e.g., 123456789)\n\n" +
        "Send /cancel to abort.",
        { parse_mode: 'Markdown' }
      );
    }
    
    if (blockState[chatId]) {
      if (text === '/cancel') {
        delete blockState[chatId];
        return bot.sendMessage(chatId, "Operation cancelled.", getAdminKeyboard());
      }
      
      const userIdToManage = text.trim();
      
      if (blockState[chatId].step === 'block') {
        await blockUser(chatId, userIdToManage);
        delete blockState[chatId];
      } else if (blockState[chatId].step === 'unblock') {
        await unblockUser(chatId, userIdToManage);
        delete blockState[chatId];
      }
      return;
    }
    
    if (text === "📊 Leaderboard") {
      await showAdminLeaderboard(chatId);
      return;
    }
    
    if (text === "📈 Stats") {
      const snapshot = await db.collection('users').get();
      const totalUsers = snapshot.size;
      const totalQuestions = questionsCache.length;
      const avgScore = snapshot.docs.reduce((acc, doc) => acc + (doc.data().bestScore || 0), 0) / totalUsers || 0;
      
      const messagesCount = (await db.collection('contact_messages').get()).size;
      
      const statsMessage = `📊 *Bot Statistics*\n\n` +
        `👥 Total Users: ${totalUsers}\n` +
        `🚫 Blocked Users: ${blockedUsers.size}\n` +
        `📚 Total Questions: ${totalQuestions}\n` +
        `📈 Average Score: ${avgScore.toFixed(1)}\n` +
        `🏆 Categories: ${getUniqueCategories().length}\n` +
        `📩 Contact Messages: ${messagesCount}\n\n` +
        `🟢 Status: Active ✅`;
      
      await bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown', ...getAdminKeyboard() });
      return;
    }
    
    // =====================
    // ADD QUESTION WITH CLICKABLE CATEGORIES
    // =====================
    if (text === "➕ Add Question") {
      const categories = getUniqueCategories();
      if (categories.length === 0) {
        adminState[chatId] = { step: 0 };
        return bot.sendMessage(chatId, "📝 No categories found. Please type a new category name:");
      }
      adminState[chatId] = { step: 'choose_category' };
      const rows = [];
      for (let i = 0; i < categories.length; i += 3) {
        rows.push(categories.slice(i, i + 3));
      }
      rows.push(["🔙 Cancel"]);
      const keyboard = {
        reply_markup: {
          keyboard: rows,
          resize_keyboard: true,
          one_time_keyboard: true
        }
      };
      return bot.sendMessage(chatId, "Select a category (or type a new one):", keyboard);
    }
    
    if (adminState[chatId]?.step === 'choose_category') {
      if (text === "🔙 Cancel") {
        delete adminState[chatId];
        return bot.sendMessage(chatId, "❌ Cancelled.", getAdminKeyboard());
      }
      adminState[chatId].category = text;
      adminState[chatId].step = 1;
      return bot.sendMessage(chatId, "📝 Send the question:");
    }
    
    const state = adminState[chatId];
    if (state && state.step !== 'select_question' && state.step !== 'select_question_delete' && 
        state.step !== 'choose_field' && state.step !== 'confirm_delete' &&
        state.step !== 'edit_category' && state.step !== 'edit_question_text' && 
        state.step !== 'edit_options' && state.step !== 'edit_correct' &&
        state.step !== 'choose_category') {
      if (state.step === 0) {
        state.category = text;
        state.step = 1;
        return bot.sendMessage(chatId, "📝 Send the question:");
      }
      
      if (state.step === 1) {
        state.question = text;
        state.step = 2;
        return bot.sendMessage(chatId, "📝 Send options (comma separated):\nExample: Option 1, Option 2, Option 3, Option 4");
      }
      
      if (state.step === 2) {
        const options = text.split(",").map(o => o.trim());
        if (options.length < 2) {
          return bot.sendMessage(chatId, "❌ Please provide at least 2 options separated by commas.");
        }
        state.options = options;
        state.step = 3;
        return bot.sendMessage(chatId, `📝 Send correct option number (1-${options.length}):`);
      }
      
      if (state.step === 3) {
        const correctIndex = parseInt(text) - 1;
        if (isNaN(correctIndex) || correctIndex < 0 || correctIndex >= state.options.length) {
          return bot.sendMessage(chatId, `❌ Invalid. Send a number between 1 and ${state.options.length}`);
        }
        
        await db.collection('questions').add({
          category: state.category,
          question: state.question,
          options: state.options,
          correct: correctIndex,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        delete adminState[chatId];
        await loadQuestions();
        
        return bot.sendMessage(chatId, "✅ Question added successfully!", getAdminKeyboard());
      }
    }
    
    return;
  }
  
  // =====================
  // PROFESSIONAL USER HANDLERS
  // =====================
  
  const categories = getUniqueCategories();
  const cleanCategory = text.replace(/^📚 /, '');
  
  if (userSessions[chatId]?.contactingAdmin) {
    if (text === '/cancel') {
      delete userSessions[chatId].contactingAdmin;
      return bot.sendMessage(chatId, "❌ Message cancelled.", getMainKeyboard());
    }
    
    const userData = await db.collection('users').doc(chatId).get();
    const user = userData.data();
    
    await saveUserMessage(
      chatId,
      msg.from.username,
      user.firstName,
      text,
      msg.message_id
    );
    
    delete userSessions[chatId].contactingAdmin;
    
    await bot.sendMessage(chatId, 
      "✅ **Message Sent!**\n\n" +
      "Your message has been sent to the administrator. You will receive a reply soon.\n\n" +
      "Thank you for reaching out! 🙏",
      { parse_mode: 'Markdown', ...getMainKeyboard() }
    );
    
    // Notify ALL admins
    for (const adminId of ADMIN_IDS) {
      try {
        await bot.sendMessage(adminId, 
          `📩 **New Message from User**\n\n` +
          `👤 User: ${user.firstName} (@${msg.from.username || 'No username'})\n` +
          `🆔 ID: ${chatId}\n` +
          `📝 Message: ${text}\n\n` +
          `Use /viewmessage to see all messages.`,
          { parse_mode: 'Markdown' }
        );
      } catch (err) {
        console.error(`Failed to notify admin ${adminId}:`, err.message);
      }
    }
    
    return;
  }
  
  if (text === "📩 Contact") {
    userSessions[chatId] = { ...userSessions[chatId], contactingAdmin: true };
    return bot.sendMessage(chatId, 
      "📩 **Contact**\n\n" +
      "Please send your message below. The administrator will respond as soon as possible.\n\n" +
      "You can ask questions, report issues, or give feedback.\n\n" +
      "Type /cancel to cancel.",
      { parse_mode: 'Markdown' }
    );
  }
  
  if (text === "🔙 Back to Main Menu") {
    delete userSessions[chatId];
    await db.collection('users').doc(chatId).update({
      quizActive: false
    });
    return bot.sendMessage(chatId, "🏠 **Main Menu**\n\nWhat would you like to do?", getMainKeyboard());
  }
  
  if (categories.includes(cleanCategory)) {
    await db.collection('users').doc(chatId).update({
      category: cleanCategory
    });
    
    const questions = getQuestionsByCategory(cleanCategory);
    const sampleQuestions = questions.slice(0, 3).map(q => `• ${q.question.substring(0, 50)}...`).join('\n');
    
    const categoryMessage = `✅ **Category Selected:** ${cleanCategory}\n\n` +
      `📚 **Questions available:** ${questions.length}\n` +
      `📝 **Sample questions:**\n${sampleQuestions}\n\n` +
      `🎯 **Ready to test your knowledge?**\n\n` +
      `Tap "Start Quiz" to begin! 🚀`;
    
    return bot.sendMessage(chatId, categoryMessage, {
      parse_mode: 'Markdown',
      ...getMainKeyboard()
    });
  }
  
  if (text === "🔄 Change Category") {
    if (userSessions[chatId]?.quizActive) {
      await bot.sendMessage(chatId, "⚠️ Please end your current quiz before changing category.\nTap 'End Quiz' to stop.",
        getQuizKeyboard());
    } else {
      await showCategoriesWithCount(chatId);
    }
    return;
  }
  
  switch(text) {
    case "🎯 Start Quiz":
      const userDoc = await db.collection('users').doc(chatId).get();
      const user = userDoc.data();
      
      if (!user || !user.category) {
        return bot.sendMessage(chatId, "⚠️ Please select a category first!", 
          getCategoryKeyboard(categories));
      }
      
      if (user.quizActive) {
        return bot.sendMessage(chatId, "⚠️ You already have an active quiz! Complete or end it first.",
          getQuizKeyboard());
      }
      
      await startQuiz(chatId);
      break;
      
    case "📊 My Stats":
      await showUserStats(chatId);
      break;
      
    case "ℹ️ About":
      await showAbout(chatId);
      break;
      
    case "❌ End Quiz":
      await endQuiz(chatId, "❌ Quiz ended. Ready for another challenge?");
      break;
      
    case "📊 Progress":
      const userData = await db.collection('users').doc(chatId).get();
      if (userData.exists && userData.data().quizActive) {
        const user = userData.data();
        const questions = getQuestionsByCategory(user.category);
        const percentage = Math.round((user.score / questions.length) * 100);
        await bot.sendMessage(chatId, 
          `📊 **Current Progress**\n\n` +
          `✅ Completed: ${user.current}/${questions.length}\n` +
          `🎯 Score: ${user.score}/${questions.length}\n` +
          `📈 Percentage: ${percentage}%\n\n` +
          `Keep going! 🚀`, 
          { parse_mode: 'Markdown' }
        );
      } else {
        await bot.sendMessage(chatId, "⚠️ No active quiz. Start a new quiz to see progress!",
          getMainKeyboard());
      }
      break;
      
    default:
      const currentUser = await db.collection('users').doc(chatId).get();
      if (currentUser.exists && currentUser.data().quizActive) {
        return;
      }
      
      const userDataDefault = currentUser.data();
      if (!userDataDefault || !userDataDefault.category) {
        const categoriesList = getUniqueCategories();
        if (categoriesList.length > 0) {
          await bot.sendMessage(chatId, "⚠️ Please select a category first by tapping one of the buttons below:", 
            getCategoryKeyboard(categoriesList));
        } else {
          await bot.sendMessage(chatId, "⚠️ No categories available. Please try again later.", getMainKeyboard());
        }
      } else {
        await forwardUserMessageToAdmin(
          chatId,
          msg.from.username,
          userDataDefault.firstName,
          text,
          msg.message_id
        );
      }
      break;
  }
});

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

    const userRef = db.collection('users').doc(userId);
    const userDoc = await userRef.get();

    if (!userDoc.exists || !userDoc.data().quizActive) return;

    const user = userDoc.data();
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

    await userRef.update({
      score: user.score,
      current: user.current
    });

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
