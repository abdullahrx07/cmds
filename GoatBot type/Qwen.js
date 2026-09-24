const axios = require("axios");
const fs = require("fs");
const path = require("path");

module.exports.config = {
  name: "qwen",
  version: "2.0.0",
  hasPermssion: 0,
  credits: "rX",
  description: "Edit image using Qwen API (supports 1 or 2 source images)",
  commandCategory: "AI",
  usages: "<text> (reply to an image) | -a <text> (reply to an image, then reply to the bot's message with a 2nd photo)",
  cooldowns: 10
};

const API_BASE = "https://qwen-api-gq76.onrender.com/edit";
const PENDING_TIMEOUT = 5 * 60 * 1000; // 5 min

/** Return the first *photo* attachment URL from a list of attachments. */
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

/** Safe file delete (never throws). */
function safeUnlink(p) {
  fs.unlink(p, () => {});
}

module.exports.run = async function ({ api, event, args }) {
  const addMode = args.length > 0 && (args[0] === "-a" || args[0] === "--add");
  const promptArgs = addMode ? args.slice(1) : args;
  const prompt = promptArgs.join(" ").trim();

  if (!prompt) {
    return api.sendMessage(
      addMode
        ? "⚠️ Usage: qwen -a <text> (reply to an image)"
        : "⚠️ Please provide some text for the image.",
      event.threadID,
      event.messageID
    );
  }

  const imgUrl = getReplyImageUrl(event);
  if (!imgUrl) {
    return api.sendMessage("⚠️ Please reply to an image.", event.threadID, event.messageID);
  }

  api.setMessageReaction("🐣", event.messageID, () => {}, true);

  if (!addMode) {
    return runEditRequest({
      api,
      event,
      prompt,
      imageUrls: [imgUrl],
      reactionMsgID: event.messageID
    });
  }

  // Two-image mode
  api.sendMessage(
    "📷 𝐀𝐝𝐝 𝐚𝐧𝐨𝐭𝐡𝐞𝐫 𝐩𝐡𝐨𝐭𝐨 — reply to this message with the 2nd image.",
    event.threadID,
    (err, info) => {
      if (err || !info) {
        api.setMessageReaction("❌", event.messageID, () => {}, true);
        return;
      }

      const client = global.client;
      if (!client || !Array.isArray(client.handleReply)) {
        api.setMessageReaction("❌", event.messageID, () => {}, true);
        return api.sendMessage(
          "❌ handleReply is not supported by this bot framework.",
          event.threadID,
          event.messageID
        );
      }

      client.handleReply.push({
        name: module.exports.config.name,
        messageID: info.messageID,
        author: event.senderID,
        prompt,
        imageUrls: [imgUrl],
        reactionMsgID: event.messageID
      });

      // Auto-expire pending reply so it doesn't leak forever
      setTimeout(() => {
        const i = client.handleReply.findIndex((h) => h.messageID === info.messageID);
        if (i !== -1) client.handleReply.splice(i, 1);
      }, PENDING_TIMEOUT);
    },
    event.messageID
  );
};

module.exports.handleReply = async function ({ api, event, handleReply }) {
  if (event.senderID !== handleReply.author) return;

  const secondUrl = getOwnImageUrl(event);
  if (!secondUrl) {
    return api.sendMessage(
      "⚠️ Please reply to this message with a photo (image attachment).",
      event.threadID,
      event.messageID
    );
  }

  // Remove pending entry so a 2nd reply can't trigger another API call
  const client = global.client;
  if (client && Array.isArray(client.handleReply)) {
    const i = client.handleReply.findIndex((h) => h.messageID === handleReply.messageID);
    if (i !== -1) client.handleReply.splice(i, 1);
  }

  return runEditRequest({
    api,
    event,
    prompt: handleReply.prompt,
    imageUrls: [...handleReply.imageUrls, secondUrl],
    reactionMsgID: handleReply.reactionMsgID
  });
};

async function runEditRequest({ api, event, prompt, imageUrls, reactionMsgID }) {
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
      return api.sendMessage(`❌ API Error: ${errMsg}`, event.threadID, event.messageID);
    }

    const cacheDir = path.join(__dirname, "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
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
      imageResponse.data.on("error", reject); // stream error handle
      writer.on("finish", resolve);
      writer.on("error", reject);
      imageResponse.data.pipe(writer);
    });

    const sentPath = filePath;
    filePath = null; // ownership goes to the send callback

    api.setMessageReaction("🧃", reactionMsgID, () => {}, true);
    api.sendMessage(
      {
        body: "> 🎀 𝐃𝐨𝐧𝐞",
        attachment: fs.createReadStream(sentPath)
      },
      event.threadID,
      () => safeUnlink(sentPath),
      event.messageID
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

    if (filePath) safeUnlink(filePath); // partial file cleanup

    api.setMessageReaction("❌", reactionMsgID, () => {}, true);
    api.sendMessage("❌ Error while processing the image.", event.threadID, event.messageID);
  }
}
