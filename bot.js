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
let broadcastState = {};
let blockState = {};
let blockedUsers = new Set();
let userTimers = {};
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
    .orderBy("order")
    .get();

  questionsCache = snapshot.docs.map(doc => ({
    id: doc.id,
    ...doc.data()
  }));
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
// ADMIN KEYBOARD
// =====================
const getAdminKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ["➕ Add Question", "✏️ Edit Question"],
      ["🗑 Delete Question", "📋 List Questions"],
      ["📢 Broadcast", "👥 Users"],
      ["🚫 Block User", "✅ Unblock User"],
      ["📊 Leaderboard", "📈 Stats"],
      ["🔙 Back to Main Menu"]
    ],
    resize_keyboard: true
  }
});

const getAdminMainKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ["➕ Add Question", "✏️ Edit Question"],
      ["🗑 Delete Question", "📋 List Questions"],
      ["📢 Broadcast", "👥 Users"],
      ["🚫 Block User", "✅ Unblock User"],
      ["📊 Leaderboard", "📈 Stats"],
      ["🔙 Back to Main Menu"]
    ],
    resize_keyboard: true
  }
});

// =====================
// PROFESSIONAL USER KEYBOARDS
// =====================
const getMainKeyboard = () => ({
  reply_markup: {
    keyboard: [
      ["🎯 Start Quiz", "📊 My Stats"],
      ["🏆 Leaderboard", "ℹ️ About"],
      ["🔄 Change Category"]
    ],
    resize_keyboard: true,
    persistent: true
  }
});

const getCategoryKeyboard = (categories) => ({
  reply_markup: {
    keyboard: categories.map(c => [`📚 ${c}`]),
    resize_keyboard: true,
    persistent: true
  }
});

const getQuizKeyboard = () => ({
  reply_markup: {
    keyboard: [["❌ End Quiz", "📊 Progress"]],
    resize_keyboard: true,
    persistent: true
  }
});

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

  await bot.sendMessage(chatId, "🎯 **Quiz Started!**\n\nYou have 15 seconds per question.\nGood luck! 🍀", {
    parse_mode: 'Markdown',
    ...getQuizKeyboard()
  });

  sendQuestion(chatId);
}

// =====================
// GET UNIQUE CATEGORIES
// =====================
function getUniqueCategories() {
  return [...new Set(questionsCache.map(q => q.category).filter(Boolean))];
}

// =====================
// GET QUESTIONS BY CATEGORY
// =====================
function getQuestionsByCategory(category) {
  return questionsCache.filter(q => q.category === category);
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

      await endQuiz(chatId, completionMessage);
      return;
    }

    if (!Array.isArray(currentQuestion.options) || currentQuestion.options.length < 2) {
      return endQuiz(chatId, "⚠️ Invalid question data. Quiz ended.");
    }

    if (userTimers[chatId]) {
      clearTimeout(userTimers[chatId]);
    }

    userTimers[chatId] = setTimeout(async () => {
      await bot.sendMessage(chatId, "⏱️ **Time's up!** Moving to next question...", {
        parse_mode: 'Markdown'
      });
      sendQuestion(chatId);
    }, 15000);

    await bot.sendPoll(
      chatId,
      `📌 **Question ${user.current + 1}/${questions.length}**\n\n${currentQuestion.question}`,
      currentQuestion.options,
      {
        type: "quiz",
        correct_option_id: currentQuestion.correct,
        is_anonymous: false,
        explanation: "Select the correct answer!",
        open_period: 15
      }
    );

  } catch (err) {
    console.error("❌ sendQuestion error:", err);
    await endQuiz(chatId, "⚠️ An error occurred. Quiz ended.");
  }
}

// =====================
// END QUIZ
// =====================
async function endQuiz(chatId, message) {
  if (userTimers[chatId]) {
    clearTimeout(userTimers[chatId]);
    delete userTimers[chatId];
  }

  delete userSessions[chatId];

  const userRef = db.collection('users').doc(chatId);
  const userDoc = await userRef.get();
  
  if (userDoc.exists) {
    const user = userDoc.data();
    
    if (user.score > (user.bestScore || 0)) {
      await userRef.update({ 
        bestScore: user.score,
        lastQuizScore: user.score,
        quizActive: false
      });
      
      if (message.includes("Quiz Complete")) {
        await bot.sendMessage(chatId, "🏆 **New Personal Best!** 🏆", {
          parse_mode: 'Markdown'
        });
      }
    } else {
      await userRef.update({ 
        lastQuizScore: user.score,
        quizActive: false 
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
// SHOW USER STATS
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
// SHOW LEADERBOARD
// =====================
async function showLeaderboard(chatId, isAdmin = false) {
  const snapshot = await db.collection('users')
    .where('bestScore', '>', 0)
    .orderBy('bestScore', 'desc')
    .limit(10)
    .get();
  
  if (snapshot.empty) {
    const message = "🏆 **Leaderboard**\n\nNo scores yet! Be the first!";
    if (isAdmin) {
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...getAdminKeyboard() });
    } else {
      await bot.sendMessage(chatId, message, { parse_mode: 'Markdown', ...getMainKeyboard() });
    }
    return;
  }
  
  let leaderboard = "🏆 **Global Leaderboard** 🏆\n\n";
  
  snapshot.docs.forEach((doc, index) => {
    const user = doc.data();
    const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "📌";
    const name = user.firstName || user.username || 'Anonymous';
    leaderboard += `${medal} ${index + 1}. ${name} - **${user.bestScore}** points\n`;
  });
  
  const userRef = db.collection('users').doc(chatId);
  const userDoc = await userRef.get();
  
  if (userDoc.exists) {
    const user = userDoc.data();
    const allUsers = await db.collection('users')
      .where('bestScore', '>', 0)
      .orderBy('bestScore', 'desc')
      .get();
    
    let userRank = 1;
    for (const doc of allUsers.docs) {
      if (doc.id === chatId) break;
      userRank++;
    }
    
    if (user.bestScore > 0) {
      leaderboard += `\n📊 **Your Rank:** #${userRank}\n` +
        `🎯 **Your Best:** ${user.bestScore} points`;
    }
  }
  
  if (isAdmin) {
    await bot.sendMessage(chatId, leaderboard, { parse_mode: 'Markdown', ...getAdminKeyboard() });
  } else {
    await bot.sendMessage(chatId, leaderboard, { parse_mode: 'Markdown', ...getMainKeyboard() });
  }
}

// =====================
// SHOW ABOUT INFO
// =====================
async function showAbout(chatId) {
  const aboutMessage = `ℹ️ **About This Quiz Bot**\n\n` +
    `🎯 **Features:**\n` +
    `• Multiple categories to choose from\n` +
    `• Timed questions (15 seconds each)\n` +
    `• Track your best scores\n` +
    `• Global leaderboard\n` +
    `• Real-time feedback\n\n` +
    `📊 **How to Play:**\n` +
    `1. Select a category\n` +
    `2. Tap "Start Quiz"\n` +
    `3. Answer within 15 seconds\n` +
    `4. Try to beat your best score!\n\n` +
    `🏅 **Ranks:**\n` +
    `• Expert (90%+) 👑\n` +
    `• Advanced (70%+) 🥇\n` +
    `• Intermediate (50%+) 🥈\n` +
    `• Beginner (<50%) 🥉\n\n` +
    `💡 **Tip:** Practice makes perfect! Keep playing to improve your rank.`;
  
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
  users.forEach((user, idx) => {
    const status = blockedUsers.has(user.id) ? "🚫 BLOCKED" : "✅ ACTIVE";
    message += `${idx + 1}. ${user.firstName || user.username || 'Unknown'}\n`;
    message += `   ID: \`${user.id}\`\n`;
    message += `   Score: ${user.bestScore || 0} | Status: ${status}\n\n`;
  });
  
  if (message.length > 4000) {
    await bot.sendMessage(chatId, `👥 Total users: ${users.length}\n\nBlocked: ${blockedUsers.size}\nActive: ${users.length - blockedUsers.size}`);
    await bot.sendMessage(chatId, "Use /block <user_id> or /unblock <user_id> to manage users.", { parse_mode: 'Markdown' });
  } else {
    await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
    await bot.sendMessage(chatId, "To block/unblock a user, send:\n`/block USER_ID`\n`/unblock USER_ID`", { parse_mode: 'Markdown' });
  }
}

// =====================
// BLOCK USER
// =====================
async function blockUser(adminChatId, userIdToBlock) {
  try {
    // Check if user exists
    const userRef = db.collection('users').doc(userIdToBlock);
    const userDoc = await userRef.get();
    
    if (!userDoc.exists) {
      return bot.sendMessage(adminChatId, `❌ User ${userIdToBlock} not found.`);
    }
    
    // Add to blocked collection
    await db.collection('blocked').doc(userIdToBlock).set({
      blockedAt: admin.firestore.FieldValue.serverTimestamp(),
      blockedBy: adminChatId
    });
    
    // Update local set
    blockedUsers.add(userIdToBlock);
    
    // Notify the blocked user
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
    await bot.sendMessage(adminChatId, "❌ Failed to block user. Please try again.");
  }
}

// =====================
// UNBLOCK USER
// =====================
async function unblockUser(adminChatId, userIdToUnblock) {
  try {
    // Check if user is blocked
    const blockedRef = db.collection('blocked').doc(userIdToUnblock);
    const blockedDoc = await blockedRef.get();
    
    if (!blockedDoc.exists) {
      return bot.sendMessage(adminChatId, `❌ User ${userIdToUnblock} is not blocked.`);
    }
    
    // Remove from blocked collection
    await blockedRef.delete();
    
    // Update local set
    blockedUsers.delete(userIdToUnblock);
    
    // Notify the unblocked user
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
    await bot.sendMessage(adminChatId, "❌ Failed to unblock user. Please try again.");
  }
}

// =====================
// SHOW CATEGORIES WITH QUESTIONS COUNT
// =====================
async function showCategoriesWithCount(chatId) {
  const categories = getUniqueCategories();
  let message = "📚 **Available Categories**\n\n";
  
  for (const category of categories) {
    const questions = getQuestionsByCategory(category);
    message += `📌 **${category}** - ${questions.length} questions\n`;
  }
  
  message += `\nSelect a category by tapping the button below.`;
  
  await bot.sendMessage(chatId, message, {
    parse_mode: 'Markdown',
    ...getCategoryKeyboard(categories)
  });
}

// =====================
// START COMMAND
// =====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;

  // Check if user is blocked
  if (blockedUsers.has(chatId)) {
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
    `I'm your personal quiz assistant. Test your knowledge across multiple categories and compete on the global leaderboard!\n\n` +
    `📚 **Ready to begin?**\n` +
    `• Select a category to start\n` +
    `• Answer questions within 15 seconds\n` +
    `• Earn points and climb the ranks!\n\n` +
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
    // Admin welcome
    await bot.sendMessage(chatId, "👑 **Admin Panel**", {
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

// =====================
// MESSAGE HANDLER
// =====================
bot.on('message', async (msg) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;
  const text = msg.text;

  if (!text) return;

  // Check if user is blocked
  if (blockedUsers.has(chatId) && userId !== ADMIN_ID) {
    return bot.sendMessage(chatId, "🚫 You are blocked from using this bot.");
  }

  // Ensure user exists
  await db.collection('users').doc(chatId).set({
    username: msg.from.username || "",
    firstName: msg.from.first_name || "",
    lastName: msg.from.last_name || ""
  }, { merge: true });

  // =====================
  // ADMIN HANDLERS
  // =====================
  if (userId === ADMIN_ID) {
    
    // Handle back to main menu
    if (text === "🔙 Back to Main Menu") {
      delete adminState[chatId];
      delete editState[chatId];
      delete broadcastState[chatId];
      delete blockState[chatId];
      return bot.sendMessage(chatId, "👑 **Admin Panel**", {
        parse_mode: 'Markdown',
        ...getAdminKeyboard()
      });
    }
    
    // Handle edit question
    if (text === "✏️ Edit Question") {
      if (questionsCache.length === 0) {
        return bot.sendMessage(chatId, "❌ No questions available to edit.", getAdminKeyboard());
      }

      const questionList = questionsCache.map((q, idx) => 
        `${idx + 1}. [${q.category}] ${q.question.substring(0, 50)}...`
      ).join('\n');

      await bot.sendMessage(chatId, `📝 Select question to edit by sending its number:\n\n${questionList}`);
      editState[chatId] = { step: 'select' };
      return;
    }

    // Handle edit question flow
    if (editState[chatId]) {
      const state = editState[chatId];

      if (state.step === 'select') {
        const questionNumber = parseInt(text);
        if (isNaN(questionNumber) || questionNumber < 1 || questionNumber > questionsCache.length) {
          return bot.sendMessage(chatId, "❌ Invalid number. Send a valid question number.");
        }

        state.questionIndex = questionNumber - 1;
        state.questionData = questionsCache[state.questionIndex];
        state.step = 'choose_field';

        return bot.sendMessage(chatId, 
          `✏️ Editing: ${state.questionData.question}\n\nWhat do you want to edit?\n\n` +
          `1️⃣ Category (current: ${state.questionData.category})\n` +
          `2️⃣ Question text\n` +
          `3️⃣ Options (current: ${state.questionData.options.join(', ')})\n` +
          `4️⃣ Correct answer (current: ${state.questionData.correct + 1})\n\n` +
          `Send the number (1-4) or "cancel" to abort.`
        );
      }

      if (state.step === 'choose_field') {
        const choice = parseInt(text);
        if (isNaN(choice) || choice < 1 || choice > 4) {
          return bot.sendMessage(chatId, "❌ Send a number between 1 and 4.");
        }

        state.editField = choice;
        
        if (choice === 1) {
          state.step = 'edit_category';
          return bot.sendMessage(chatId, "📝 Send the new category name:");
        } else if (choice === 2) {
          state.step = 'edit_question';
          return bot.sendMessage(chatId, "📝 Send the new question text:");
        } else if (choice === 3) {
          state.step = 'edit_options';
          return bot.sendMessage(chatId, "📝 Send the new options (comma separated):\nExample: Option 1, Option 2, Option 3, Option 4");
        } else if (choice === 4) {
          state.step = 'edit_correct';
          return bot.sendMessage(chatId, `📝 Send the correct option number (1-${state.questionData.options.length}):`);
        }
      }

      if (state.step === 'edit_category') {
        state.questionData.category = text;
        await db.collection('questions').doc(state.questionData.id).update({
          category: text
        });
        await loadQuestions();
        delete editState[chatId];
        return bot.sendMessage(chatId, "✅ Category updated successfully!", getAdminKeyboard());
      }

      if (state.step === 'edit_question') {
        state.questionData.question = text;
        await db.collection('questions').doc(state.questionData.id).update({
          question: text
        });
        await loadQuestions();
        delete editState[chatId];
        return bot.sendMessage(chatId, "✅ Question text updated successfully!", getAdminKeyboard());
      }

      if (state.step === 'edit_options') {
        const options = text.split(",").map(o => o.trim());
        if (options.length < 2) {
          return bot.sendMessage(chatId, "❌ Please provide at least 2 options separated by commas.");
        }
        state.questionData.options = options;
        await db.collection('questions').doc(state.questionData.id).update({
          options: options
        });
        await loadQuestions();
        delete editState[chatId];
        return bot.sendMessage(chatId, "✅ Options updated successfully!", getAdminKeyboard());
      }

      if (state.step === 'edit_correct') {
        const correctIndex = parseInt(text) - 1;
        if (isNaN(correctIndex) || correctIndex < 0 || correctIndex >= state.questionData.options.length) {
          return bot.sendMessage(chatId, `❌ Invalid. Send a number between 1 and ${state.questionData.options.length}`);
        }
        state.questionData.correct = correctIndex;
        await db.collection('questions').doc(state.questionData.id).update({
          correct: correctIndex
        });
        await loadQuestions();
        delete editState[chatId];
        return bot.sendMessage(chatId, "✅ Correct answer updated successfully!", getAdminKeyboard());
      }
    }

    // Handle broadcast
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
        
        // Skip blocked users
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

    // Handle delete question
    if (text === "🗑 Delete Question") {
      if (questionsCache.length === 0) {
        return bot.sendMessage(chatId, "❌ No questions available to delete.", getAdminKeyboard());
      }

      const questionList = questionsCache.map((q, idx) => 
        `${idx + 1}. [${q.category}] ${q.question.substring(0, 50)}...`
      ).join('\n');

      await bot.sendMessage(chatId, `🗑 Select question to delete by sending its number:\n\n${questionList}\n\nSend 0 to cancel.`);
      adminState[chatId] = { step: 'delete_question' };
      return;
    }

    if (adminState[chatId] && adminState[chatId].step === 'delete_question') {
      const questionNumber = parseInt(text);
      
      if (questionNumber === 0) {
        delete adminState[chatId];
        return bot.sendMessage(chatId, "❌ Deletion cancelled.", getAdminKeyboard());
      }
      
      if (isNaN(questionNumber) || questionNumber < 1 || questionNumber > questionsCache.length) {
        return bot.sendMessage(chatId, "❌ Invalid number. Send a valid question number or 0 to cancel.");
      }
      
      const questionToDelete = questionsCache[questionNumber - 1];
      
      await bot.sendMessage(chatId, 
        `⚠️ Are you sure you want to delete this question?\n\n` +
        `Category: ${questionToDelete.category}\n` +
        `Question: ${questionToDelete.question}\n\n` +
        `Send "CONFIRM" to delete, or anything else to cancel.`
      );
      
      adminState[chatId] = { step: 'confirm_delete', questionId: questionToDelete.id };
      return;
    }
    
    if (adminState[chatId] && adminState[chatId].step === 'confirm_delete') {
      if (text === "CONFIRM") {
        await db.collection('questions').doc(adminState[chatId].questionId).delete();
        await loadQuestions();
        delete adminState[chatId];
        return bot.sendMessage(chatId, "✅ Question deleted successfully!", getAdminKeyboard());
      } else {
        delete adminState[chatId];
        return bot.sendMessage(chatId, "❌ Deletion cancelled.", getAdminKeyboard());
      }
    }

    // Handle list questions
    if (text === "📋 List Questions") {
      if (questionsCache.length === 0) {
        return bot.sendMessage(chatId, "📋 No questions found.", getAdminKeyboard());
      }
      
      let message = "📋 *Question List*\n\n";
      let count = 0;
      
      for (let i = 0; i < questionsCache.length; i++) {
        const q = questionsCache[i];
        const newEntry = `${i + 1}. *[${q.category}]* ${q.question.substring(0, 40)}...\n`;
        
        if ((message + newEntry).length > 4000) {
          await bot.sendMessage(chatId, message, { parse