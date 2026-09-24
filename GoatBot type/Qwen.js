const axios = require("axios");
const fs = require("fs-extra");
const path = require("path");

const API_BASE = "https://qwen-api-gq76.onrender.com/edit";
const PENDING_TIMEOUT = 5 * 60 * 1000; // 5 min

module.exports = {
  config: {
    name: "qwen",
    aliases: ["edit"],
    version: "2.0.0",
    author: "rX",
    countDown: 10,
    role: 0,
    description: {
      en: "Edit image using Qwen API (supports 1 or 2 source images)"
    },
    category: "ai",
    guide: {
      en:
        "{pn} <text> (reply to an image)\n" +
        "{pn} -a <text> (reply to an image, then reply to the bot's message with a 2nd photo)"
    }
  },

  onStart: async function ({ api, event, args, message }) {
    const addMode = args.length > 0 && (args[0] === "-a" || args[0] === "--add");
    const promptArgs = addMode ? args.slice(1) : args;
    const prompt = promptArgs.join(" ").trim();

    if (!prompt) {
      return message.reply(
        addMode
          ? "⚠️ Usage: qwen -a <text> (reply to an image)"
          : "⚠️ Please provide some text for the image."
      );
    }

    const imgUrl = getReplyImageUrl(event);
    if (!imgUrl) {
      return message.reply("⚠️ Please reply to an image.");
    }

    api.setMessageReaction("🐣", event.messageID, () => {}, true);

    if (!addMode) {
      return runEditRequest({
        api,
        event,
        message,
        prompt,
        imageUrls: [imgUrl],
        reactionMsgID: event.messageID
      });
    }

    // Two-image mode: ask for 2nd photo, then wait for reply
    message.reply(
      "📷 𝐀𝐝𝐝 𝐚𝐧𝐨𝐭𝐡𝐞𝐫 𝐩𝐡𝐨𝐭𝐨 — reply to this message with the 2nd image.",
      (err, info) => {
        if (err || !info) {
          api.setMessageReaction("❌", event.messageID, () => {}, true);
          return;
        }

        global.GoatBot.onReply.set(info.messageID, {
          commandName: this.config.name,
          messageID: info.messageID,
          author: event.senderID,
          prompt,
          imageUrls: [imgUrl],
          reactionMsgID: event.messageID
        });

        // Auto-expire so it doesn't leak
        setTimeout(() => {
          global.GoatBot.onReply.delete(info.messageID);
        }, PENDING_TIMEOUT);
      }
    );
  },

  onReply: async function ({ api, event, message, Reply }) {
    if (event.senderID !== Reply.author) return;

    const secondUrl = getOwnImageUrl(event);
    if (!secondUrl) {
      return message.reply("⚠️ Please reply to this message with a photo (image attachment).");
    }

    // Remove pending entry so a 2nd reply can't trigger another API call
    global.GoatBot.onReply.delete(Reply.messageID);

    return runEditRequest({
      api,
      event,
      message,
      prompt: Reply.prompt,
      imageUrls: [...Reply.imageUrls, secondUrl],
      reactionMsgID: Reply.reactionMsgID
    });
  }
};

/** Return the first photo attachment URL from a list of attachments. */
function pickPhotoUrl(attachments) {
  if (!Array.isArray(attachments)) return null;
  const a = attachments.find(
    (x) => x && x.url && (!x.type || x.type === "photo" || x.type === "animated_image")
  );
  return a ? a.url : null;
}

function getReplyImageUrl(event) {
  return pickPhotoUrl(event.messageReply && event.messageReply.attachments);
}

function getOwnImageUrl(event) {
  return pickPhotoUrl(event.attachments);
}

/** Shared: call the API and send back the edited image. */
async function runEditRequest({ api, event, message, prompt, imageUrls, reactionMsgID }) {
  let filePath = null;

  try {
    const params = new URLSearchParams();
    params.set("image", imageUrls[0]);
    if (imageUrls[1]) params.set("image2", imageUrls[1]);
    params.set("prompt", prompt);

    const requestURL = `${API_BASE}?${params.toString()}`;
    console.log("🔗 Request URL:", requestURL);

    const res = await axios.get(requestURL, { timeout: 120000 });
    console.log("📦 API status:", res.status);
    console.log("📦 API data:", JSON.stringify(res.data, null, 2));

    const data = res.data;
    const finalImageURL =
      data && data.success && typeof data.imageUrl === "string" ? data.imageUrl : null;

    if (!finalImageURL) {
      const errMsg = (data && (data.error || data.message)) || "Unknown reason";
      console.log("❌ Failed. success:", data && data.success, "| reason:", errMsg);
      api.setMessageReaction("⚠️", reactionMsgID, () => {}, true);
      return message.reply(`❌ API Error: ${errMsg}`);
    }

    const cacheDir = path.join(__dirname, "cache");
    fs.ensureDirSync(cacheDir);
    filePath = path.join(
      cacheDir,
      `${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`
    );

    const imageResponse = await axios.get(finalImageURL, {
      responseType: "stream",
      timeout: 60000
    });

    const writer = fs.createWriteStream(filePath);

    await new Promise((resolve, reject) => {
      imageResponse.data.on("error", reject);
      writer.on("finish", resolve);
      writer.on("error", reject);
      imageResponse.data.pipe(writer);
    });

    const sentPath = filePath;
    filePath = null; // ownership goes to the send callback

    api.setMessageReaction("🧃", reactionMsgID, () => {}, true);
    message.reply(
      {
        body: "> 🎀 𝐃𝐨𝐧𝐞",
        attachment: fs.createReadStream(sentPath)
      },
      () => fs.unlink(sentPath, () => {})
    );
  } catch (err) {
    if (err.response) {
      console.log("❌ ERROR status:", err.response.status);
      try {
        console.log("❌ ERROR data:", JSON.stringify(err.response.data, null, 2));
      } catch (_) {}
    } else if (err.request) {
      console.log("❌ ERROR: No response received —", err.message);
    } else {
      console.log("❌ ERROR:", err.message);
    }

    if (filePath) fs.unlink(filePath, () => {});

    api.setMessageReaction("❌", reactionMsgID, () => {}, true);
    message.reply("❌ Error while processing the image.");
  }
  }
