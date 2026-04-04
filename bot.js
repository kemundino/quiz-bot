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
  const userRef = db.collection('users').doc(chatId);
  const userDoc = await userRef.get();
  const user = userDoc.data();

  const category = user.category;

  if (!category) {
    return bot.sendMessage(chatId, "⚠️ Please select a category first.");
  }

  const questions = questionsCache.filter(q =>
    q.category === category
  );

  if (questions.length === 0) {
    return bot.sendMessage(chatId, "❌ No questions available in this category.");
  }

  await userRef.set({
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

    if (questions.length === 0) {
      return bot.sendMessage(chatId, "❌ No questions in this category.");
    }

    const q = questions[user.current];

    if (!q) {
      if (user.score > (user.bestScore || 0)) {
        await userRef.update({ bestScore: user.score });
      }

      return bot.sendMessage(chatId,
        `✅ Finished!\nScore: ${user.score}/${questions.length}`,
        {
          reply_markup: {
            keyboard: [["▶️ Start Quiz"], ["🔄 Change Category"], ["📈 My Score"]],
            resize_keyboard: true
          }
        }
      );
    }

    if (!Array.isArray(q.options) || q.options.length < 2) {
      return bot.sendMessage(chatId, "⚠️ Invalid question data in database.");
    }

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

    const categories = [...new Set(questionsCache.map(q => q.category).filter(Boolean))];

    return bot.sendMessage(chatId, "Choose a category:", {
      reply_markup: {
        keyboard: categories.map(c => [c]),
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
          ["👥 Users", "📊 Leaderboard"],
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
    return bot.sendMessage(chatId, "🚫 You are blocked.");
  }

  await db.collection('users').doc(chatId).set({
    username: msg.from.username || "",
    firstName: msg.from.first_name || ""
  }, { merge: true });

  // =====================
  // CATEGORY SELECTION
  // =====================
  const categories = [...new Set(questionsCache.map(q => q.category).filter(Boolean))];

  if (categories.includes(text)) {
    await db.collection('users').doc(chatId).set({
      category: text
    }, { merge: true });

    return bot.sendMessage(chatId, `✅ Category selected: ${text}`, {
      reply_markup: {
        keyboard: [
          ["▶️ Start Quiz"],
          ["🔄 Change Category"],
          ["📈 My Score"]
        ],
        resize_keyboard: true
      }
    });
  }

  // =====================
  // USER ACTIONS
  // =====================
  if (text === "▶️ Start Quiz") {
    return startQuiz(chatId);
  }

  if (text === "🔄 Change Category") {
    return bot.sendMessage(chatId, "Choose a category:", {
      reply_markup: {
        keyboard: categories.map(c => [c]),
        resize_keyboard: true
      }
    });
  }

  if (text === "📈 My Score") {
    const doc = await db.collection('users').doc(chatId).get();
    const data = doc.data();

    return bot.sendMessage(chatId,
      `📊 Current: ${data.score}\nBest: ${data.bestScore}`
    );
  }

  if (text === "🔙 Cancel") {
    delete adminState[chatId];
    delete editState[chatId];
    delete broadcastState[chatId];

    return bot.sendMessage(chatId, "↩️ Cancelled.", {
      reply_markup: {
        keyboard: [
          ["➕ Add Question", "✏️ Edit Question"],
          ["🗑 Delete Question"],
          ["📋 List Questions"],
          ["📢 Broadcast"],
          ["👥 Users", "📊 Leaderboard"],
          ["🔙 Cancel"]
        ],
        resize_keyboard: true
      }
    });
  }

  // =====================
  // ADMIN BUTTON HANDLERS
  // =====================
  if (userId === ADMIN_ID) {

    // =====================
    // EDIT QUESTION HANDLER
    // =====================
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
              ["🗑 Delete Question"],
              ["📋 List Questions"],
              ["📢 Broadcast"],
              ["👥 Users", "📊 Leaderboard"],
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
              ["🗑 Delete Question"],
              ["📋 List Questions"],
              ["📢 Broadcast"],
              ["👥 Users", "📊 Leaderboard"],
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
              ["🗑 Delete Question"],
              ["📋 List Questions"],
              ["📢 Broadcast"],
              ["👥 Users", "📊 Leaderboard"],
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
              ["🗑 Delete Question"],
              ["📋 List Questions"],
              ["📢 Broadcast"],
              ["👥 Users", "📊 Leaderboard"],
              ["🔙 Cancel"]
            ],
            resize_keyboard: true
          }
        });
      }
    }

    // =====================
    // BROADCAST HANDLER
    // =====================
    if (text === "📢 Broadcast") {
      broadcastState[chatId] = { step: 'message' };
      return bot.sendMessage(chatId, 
        "📢 *Broadcast Mode*\n\nSend the message you want to broadcast to all users.\n\n" +
        "You can send text, photo, video, or document.\n\nType /cancel to abort.",
        { parse_mode: 'Markdown' }
      );
    }

    // Handle broadcast flow
    if (broadcastState[chatId]) {
      if (text === '/cancel') {
        delete broadcastState[chatId];
        return bot.sendMessage(chatId, "❌ Broadcast cancelled.", {
          reply_markup: {
            keyboard: [
              ["➕ Add Question", "✏️ Edit Question"],
              ["🗑 Delete Question"],
              ["📋 List Questions"],
              ["📢 Broadcast"],
              ["👥 Users", "📊 Leaderboard"],
              ["🔙 Cancel"]
            ],
            resize_keyboard: true
          }
        });
      }

      // Get all users
      const usersSnapshot = await db.collection('users').get();
      const totalUsers = usersSnapshot.size;
      
      if (totalUsers === 0) {
        delete broadcastState[chatId];
        return bot.sendMessage(chatId, "❌ No users found to broadcast to.");
      }

      await bot.sendMessage(chatId, `📢 Broadcasting to ${totalUsers} users... This may take a while.`);
      
      let successCount = 0;
      let failCount = 0;
      
      // Send to each user
      for (const userDoc of usersSnapshot.docs) {
        const userData = userDoc.data();
        const userChatId = userData.chatId;
        
        try {
          // Check if message has photo, video, or document
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
        
        // Add small delay to avoid rate limiting
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

    // Handle delete question
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
              ["🗑 Delete Question"],
              ["📋 List Questions"],
              ["📢 Broadcast"],
              ["👥 Users", "📊 Leaderboard"],
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
      
      // Send in chunks to avoid message length limits
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
        // Send first 50 users
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

    if (text === "📊 Leaderboard") {
      const snapshot = await db.collection('users')
        .orderBy("bestScore", "desc")
        .limit(10)
        .get();

      if (snapshot.empty) {
        return bot.sendMessage(chatId, "📊 No scores yet.");
      }

      let board = "🏆 *Leaderboard Top 10*\n\n";
      snapshot.docs.forEach((doc, i) => {
        const d = doc.data();
        board += `${i + 1}. ${d.firstName || d.username || 'Anonymous'} - ${d.bestScore || 0} points\n`;
      });

      return bot.sendMessage(chatId, board, { parse_mode: 'Markdown' });
    }
  }

  // =====================
  // ADMIN ADD QUESTION (UNCHANGED)
  // =====================
  if (userId === ADMIN_ID) {

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
              ["🗑 Delete Question"],
              ["📋 List Questions"],
              ["📢 Broadcast"],
              ["👥 Users", "📊 Leaderboard"],
              ["🔙 Cancel"]
            ],
            resize_keyboard: true
          }
        });
      }
    }
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