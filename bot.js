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
let blockedUsers = new Set();
let userTimers = {};
let processedPollAnswers = new Set();
let questionsCache = [];
let userSessions = {}; // Track user quiz state

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

  // Initialize quiz session
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
      // Quiz completed
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

    // Clear existing timer
    if (userTimers[chatId]) {
      clearTimeout(userTimers[chatId]);
    }

    // Set timeout for this question
    userTimers[chatId] = setTimeout(async () => {
      await bot.sendMessage(chatId, "⏱️ **Time's up!** Moving to next question...", {
        parse_mode: 'Markdown'
      });
      sendQuestion(chatId);
    }, 15000);

    // Send question as poll
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
    
    // Update best score if needed
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
async function showLeaderboard(chatId) {
  const snapshot = await db.collection('users')
    .where('bestScore', '>', 0)
    .orderBy('bestScore', 'desc')
    .limit(10)
    .get();
  
  if (snapshot.empty) {
    return bot.sendMessage(chatId, "🏆 **Leaderboard**\n\nNo scores yet! Be the first!", {
      parse_mode: 'Markdown',
      ...getMainKeyboard()
    });
  }
  
  let leaderboard = "🏆 **Global Leaderboard** 🏆\n\n";
  
  snapshot.docs.forEach((doc, index) => {
    const user = doc.data();
    const medal = index === 0 ? "🥇" : index === 1 ? "🥈" : index === 2 ? "🥉" : "📌";
    const name = user.firstName || user.username || 'Anonymous';
    leaderboard += `${medal} ${index + 1}. ${name} - **${user.bestScore}** points\n`;
  });
  
  // Add user's rank
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
  
  await bot.sendMessage(chatId, leaderboard, {
    parse_mode: 'Markdown',
    ...getMainKeyboard()
  });
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
// START COMMAND
// =====================
bot.onText(/\/start/, async (msg) => {
  const chatId = msg.chat.id.toString();
  const userId = msg.from.id;

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
      reply_markup: {
        keyboard: [
          ["➕ Add Question", "✏️ Edit Question"],
          ["🗑 Delete Question", "📋 List Questions"],
          ["📢 Broadcast", "👥 Users"],
          ["📊 Leaderboard", "📈 Stats"],
          ["🔙 Cancel"]
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
    return bot.sendMessage(chatId, "🚫 You are blocked from using this bot.");
  }

  // Ensure user exists
  await db.collection('users').doc(chatId).set({
    username: msg.from.username || "",
    firstName: msg.from.first_name || "",
    lastName: msg.from.last_name || ""
  }, { merge: true });

  // =====================
  // ADMIN HANDLERS (Keep existing functionality)
  // =====================
  if (userId === ADMIN_ID) {
    // Handle admin actions (keeping all original admin functionality)
    if (text === "✏️ Edit Question") {
      if (questionsCache.length === 0) {
        return bot.sendMessage(chatId, "❌ No questions available to edit.");
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
        return bot.sendMessage(chatId, "✅ Category updated successfully!", {
          reply_markup: {
            keyboard: [
              ["➕ Add Question", "✏️ Edit Question"],
              ["🗑 Delete Question", "📋 List Questions"],
              ["📢 Broadcast", "👥 Users"],
              ["📊 Leaderboard", "📈 Stats"],
              ["🔙 Cancel"]
            ],
            resize_keyboard: true
          }
        });
      }

      if (state.step === 'edit_question') {
        state.questionData.question = text;
        await db.collection('questions').doc(state.questionData.id).update({
          question: text
        });
        await loadQuestions();
        delete editState[chatId];
        return bot.sendMessage(chatId, "✅ Question text updated successfully!", {
          reply_markup: {
            keyboard: [
              ["➕ Add Question", "✏️ Edit Question"],
              ["🗑 Delete Question", "📋 List Questions"],
              ["📢 Broadcast", "👥 Users"],
              ["📊 Leaderboard", "📈 Stats"],
              ["🔙 Cancel"]
            ],
            resize_keyboard: true
          }
        });
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
        return bot.sendMessage(chatId, "✅ Options updated successfully!", {
          reply_markup: {
            keyboard: [
              ["➕ Add Question", "✏️ Edit Question"],
              ["🗑 Delete Question", "📋 List Questions"],
              ["📢 Broadcast", "👥 Users"],
              ["📊 Leaderboard", "📈 Stats"],
              ["🔙 Cancel"]
            ],
            resize_keyboard: true
          }
        });
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
        return bot.sendMessage(chatId, "✅ Correct answer updated successfully!", {
          reply_markup: {
            keyboard: [
              ["➕ Add Question", "✏️ Edit Question"],
              ["🗑 Delete Question", "📋 List Questions"],
              ["📢 Broadcast", "👥 Users"],
              ["📊 Leaderboard", "📈 Stats"],
              ["🔙 Cancel"]
            ],
            resize_keyboard: true
          }
        });
      }
    }

    // Broadcast handler
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
        return bot.sendMessage(chatId, "❌ Broadcast cancelled.", {
          reply_markup: {
            keyboard: [
              ["➕ Add Question", "✏️ Edit Question"],
              ["🗑 Delete Question", "📋 List Questions"],
              ["📢 Broadcast", "👥 Users"],
              ["📊 Leaderboard", "📈 Stats"],
              ["🔙 Cancel"]
            ],
            resize_keyboard: true
          }
        });
      }

      const usersSnapshot = await db.collection('users').get();
      const totalUsers = usersSnapshot.size;
      
      if (totalUsers === 0) {
        delete broadcastState[chatId];
        return bot.sendMessage(chatId, "❌ No users found to broadcast to.");
      }

      await bot.sendMessage(chatId, `📢 Broadcasting to ${totalUsers} users... This may take a while.`);
      
      let successCount = 0;
      let failCount = 0;
      
      for (const userDoc of usersSnapshot.docs) {
        const userData = userDoc.data();
        const userChatId = userData.chatId;
        
        try {
          if (msg.photo) {
            const photo = msg.photo[msg.photo.length - 1].file_id;
            await bot.sendPhoto(userChatId, photo, { caption: msg.caption || "" });
          } else if (msg.video) {
            await bot.sendVideo(userChatId, msg.video.file_id, { caption: msg.caption || "" });
          } else if (msg.document) {
            await bot.sendDocument(userChatId, msg.document.file_id, { caption: msg.caption || "" });
          } else if (text) {
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
        `👥 Total: ${totalUsers}`,
        { parse_mode: 'Markdown' }
      );
    }

    if (text === "🗑 Delete Question") {
      if (questionsCache.length === 0) {
        return bot.sendMessage(chatId, "❌ No questions available to delete.");
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
        return bot.sendMessage(chatId, "❌ Deletion cancelled.");
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
      
      adminState[chatId] = { step: 'confirm_delete', questionId: questionToDelete.id, questionNumber: questionNumber };
      return;
    }
    
    if (adminState[chatId] && adminState[chatId].step === 'confirm_delete') {
      if (text === "CONFIRM") {
        await db.collection('questions').doc(adminState[chatId].questionId).delete();
        await loadQuestions();
        delete adminState[chatId];
        return bot.sendMessage(chatId, "✅ Question deleted successfully!", {
          reply_markup: {
            keyboard: [
              ["➕ Add Question", "✏️ Edit Question"],
              ["🗑 Delete Question", "📋 List Questions"],
              ["📢 Broadcast", "👥 Users"],
              ["📊 Leaderboard", "📈 Stats"],
              ["🔙 Cancel"]
            ],
            resize_keyboard: true
          }
        });
      } else {
        delete adminState[chatId];
        return bot.sendMessage(chatId, "❌ Deletion cancelled.");
      }
    }

    if (text === "📋 List Questions") {
      if (questionsCache.length === 0) {
        return bot.sendMessage(chatId, "📋 No questions found.");
      }
      
      let message = "📋 *Question List*\n\n";
      let count = 0;
      
      for (let i = 0; i < questionsCache.length; i++) {
        const q = questionsCache[i];
        const newEntry = `${i + 1}. *[${q.category}]* ${q.question.substring(0, 40)}...\n`;
        
        if ((message + newEntry).length > 4000) {
          await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
          message = newEntry;
        } else {
          message += newEntry;
        }
        count++;
      }
      
      if (message !== "📋 *Question List*\n\n") {
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      }
      
      await bot.sendMessage(chatId, `📊 Total questions: ${count}`);
      return;
    }

    if (text === "👥 Users") {
      const snapshot = await db.collection('users').get();
      const users = snapshot.docs.map(doc => doc.data());
      
      let message = "👥 *User List*\n\n";
      users.forEach((user, idx) => {
        message += `${idx + 1}. ${user.firstName || user.username || 'Unknown'} - Score: ${user.bestScore || 0}\n`;
      });
      
      if (message.length > 4000) {
        await bot.sendMessage(chatId, `👥 Total users: ${users.length}`);
        const limitedUsers = users.slice(0, 50);
        let limitedMessage = "👥 *Recent Users*\n\n";
        limitedUsers.forEach((user, idx) => {
          limitedMessage += `${idx + 1}. ${user.firstName || user.username || 'Unknown'} - Score: ${user.bestScore || 0}\n`;
        });
        await bot.sendMessage(chatId, limitedMessage, { parse_mode: 'Markdown' });
      } else {
        await bot.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      }
      return;
    }

    if (text === "📈 Stats") {
      const snapshot = await db.collection('users').get();
      const totalUsers = snapshot.size;
      const totalQuestions = questionsCache.length;
      const avgScore = snapshot.docs.reduce((acc, doc) => acc + (doc.data().bestScore || 0), 0) / totalUsers || 0;
      
      const statsMessage = `📊 *Bot Statistics*\n\n` +
        `👥 Total Users: ${totalUsers}\n` +
        `📚 Total Questions: ${totalQuestions}\n` +
        `📈 Average Score: ${avgScore.toFixed(1)}\n` +
        `🏆 Categories: ${getUniqueCategories().length}\n\n` +
        `🟢 Status: Active ✅`;
      
      await bot.sendMessage(chatId, statsMessage, { parse_mode: 'Markdown' });
      return;
    }

    if (text === "➕ Add Question") {
      adminState[chatId] = { step: 0 };
      return bot.sendMessage(chatId, "Send category:");
    }

    const state = adminState[chatId];
    if (state && state.step !== 'delete_question' && state.step !== 'confirm_delete') {
      if (state.step === 0) {
        state.category = text;
        state.step = 1;
        return bot.sendMessage(chatId, "Send question:");
      }

      if (state.step === 1) {
        state.question = text;
        state.step = 2;
        return bot.sendMessage(chatId, "Send options (comma separated):\nExample: Option 1, Option 2, Option 3, Option 4");
      }

      if (state.step === 2) {
        const options = text.split(",").map(o => o.trim());
        if (options.length < 2) {
          return bot.sendMessage(chatId, "❌ Please provide at least 2 options separated by commas.");
        }
        state.options = options;
        state.step = 3;
        return bot.sendMessage(chatId, `Send correct option number (1-${options.length}):`);
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

        return bot.sendMessage(chatId, "✅ Question added successfully!", {
          reply_markup: {
            keyboard: [
              ["➕ Add Question", "✏️ Edit Question"],
              ["🗑 Delete Question", "📋 List Questions"],
              ["📢 Broadcast", "👥 Users"],
              ["📊 Leaderboard", "📈 Stats"],
              ["🔙 Cancel"]
            ],
            resize_keyboard: true
          }
        });
      }
    }

    if (text === "📊 Leaderboard") {
      return showLeaderboard(chatId);
    }

    if (text === "🔙 Cancel") {
      delete adminState[chatId];
      delete editState[chatId];
      delete broadcastState[chatId];
      return bot.sendMessage(chatId, "↩️ Cancelled.", {
        reply_markup: {
          keyboard: [
            ["➕ Add Question", "✏️ Edit Question"],
            ["🗑 Delete Question", "📋 List Questions"],
            ["📢 Broadcast", "👥 Users"],
            ["📊 Leaderboard", "📈 Stats"],
            ["🔙 Cancel"]
          ],
          resize_keyboard: true
        }
      });
    }

    return;
  }

  // =====================
  // PROFESSIONAL USER HANDLERS
  // =====================
  
  const categories = getUniqueCategories();
  const cleanCategory = text.replace(/^📚 /, '');
  
  // Handle category selection
  if (categories.includes(cleanCategory)) {
    await db.collection('users').doc(chatId).update({
      category: cleanCategory
    });
    
    const questions = getQuestionsByCategory(cleanCategory);
    const categoryMessage = `✅ **Category Selected:** ${cleanCategory}\n\n` +
      `📚 **Questions available:** ${questions.length}\n` +
      `🎯 **Ready to test your knowledge?**\n\n` +
      `Tap "Start Quiz" to begin! 🚀`;
    
    return bot.sendMessage(chatId, categoryMessage, {
      parse_mode: 'Markdown',
      ...getMainKeyboard()
    });
  }
  
  // Handle main menu actions
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
      
    case "🏆 Leaderboard":
      await showLeaderboard(chatId);
      break;
      
    case "ℹ️ About":
      await showAbout(chatId);
      break;
      
    case "🔄 Change Category":
      if (userSessions[chatId]) {
        await bot.sendMessage(chatId, "⚠️ Please end your current quiz before changing category.\nTap 'End Quiz' to stop.",
          getQuizKeyboard());
      } else {
        await bot.sendMessage(chatId, "📚 **Select a Category**\n\nChoose the topic you want to practice:", 
          getCategoryKeyboard(categories));
      }
      break;
      
    case "❌ End Quiz":
      if (userTimers[chatId]) {
        clearTimeout(userTimers[chatId]);
        delete userTimers[chatId];
      }
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
      // Check if user is in quiz and trying to answer
      const currentUser = await db.collection('users').doc(chatId).get();
      if (currentUser.exists && currentUser.data().quizActive) {
        // User is in quiz, but we handle answers via poll_answer event
        // Just ignore text messages during quiz
        return;
      }
      
      // Unknown command
      await bot.sendMessage(chatId, "❓ **Unknown Command**\n\nUse the buttons below to navigate:", 
        getMainKeyboard());
      break;
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

    // Small delay before next question for better UX
    setTimeout(() => sendQuestion(userId), 2000);

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