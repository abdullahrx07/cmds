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

/** Extract the URL of the first image attached to the message this event replies to. */
function getReplyImageUrl(event) {
  if (
    event.messageReply &&
    event.messageReply.attachments &&
    event.messageReply.attachments[0]
  ) {
    return event.messageReply.attachments[0].url;
  }
  return null;
}

/** Extract the URL of the first image attached to the current message (not the reply target). */
function getOwnImageUrl(event) {
  if (event.attachments && event.attachments[0]) {
    return event.attachments[0].url;
  }
  return null;
}

module.exports.run = async function ({ api, event, args }) {
  // `edit -a <prompt>` → two-image mode. `-a` / `--add` must be the first arg.
  const addMode = args.length > 0 && (args[0] === "-a" || args[0] === "--add");
  const promptArgs = addMode ? args.slice(1) : args;
  const prompt = promptArgs.join(" ").trim();

  if (!prompt) {
    return api.sendMessage(
      addMode
        ? "⚠️ Usage: edit -a <text> (reply to an image)"
        : "⚠️ Please provide some text for the image.",
      event.threadID,
      event.messageID
    );
  }

  const imgUrl = getReplyImageUrl(event);
  if (!imgUrl) {
    return api.sendMessage(
      "⚠️ Please reply to an image.",
      event.threadID,
      event.messageID
    );
  }

  api.setMessageReaction("🐣", event.messageID, () => {}, true);

  if (!addMode) {
    return runEditRequest({ api, event, prompt, imageUrls: [imgUrl], reactionMsgID: event.messageID });
  }

  // Two-image mode: ask for the second photo, then wait for a reply to the
  // bot's own message carrying that photo.
  api.sendMessage(
    "📷 𝐀𝐝𝐝 𝐚𝐧𝐨𝐭𝐡𝐞𝐫 𝐩𝐡𝐨𝐭𝐨 — reply to this message with the 2nd image.",
    event.threadID,
    (err, info) => {
      if (err || !info) {
        api.setMessageReaction("❌", event.messageID, () => {}, true);
        return;
      }

      // Register a pending reply so handleReply fires when the user replies
      // to the bot's "add another photo" message.
      const client = (global.client && global.client) || null;
      if (client && Array.isArray(client.handleReply)) {
        client.handleReply.push({
          name: module.exports.config.name,
          messageID: info.messageID,
          author: event.senderID,
          prompt,
          imageUrls: [imgUrl],
          reactionMsgID: event.messageID,
        });
      }
    },
    event.messageID
  );
};

/**
 * Mirai-style reply handler: catches the user replying to the bot's
 * "add another photo" message with the 2nd image and fires the edit request
 * with both images + the original prompt.
 */
module.exports.handleReply = async function ({ api, event, handleReply }) {
  if (event.senderID !== handleReply.author) {
    return;
  }

  // The 2nd photo is attached to the user's *own* reply message (not to the
  // bot message it replies to, which carries no image).
  const secondUrl = getOwnImageUrl(event);
  if (!secondUrl) {
    return api.sendMessage(
      "⚠️ Please reply to this message with a photo (image attachment).",
      event.threadID,
      event.messageID
    );
  }

  return runEditRequest({
    api,
    event,
    prompt: handleReply.prompt,
    imageUrls: [...handleReply.imageUrls, secondUrl],
    reactionMsgID: handleReply.reactionMsgID,
  });
};

/** Shared: build the backend request and send back the edited image. */
async function runEditRequest({ api, event, prompt, imageUrls, reactionMsgID }) {
  try {
    const params = new URLSearchParams();
    params.set("image", imageUrls[0]);
    if (imageUrls[1]) params.set("image2", imageUrls[1]);
    params.set("prompt", prompt);

    const requestURL = `${API_BASE}?${params.toString()}`;
    console.log("🔗 Request URL:", requestURL);

    const res = await axios.get(requestURL, { timeout: 120000 });
    console.log("📦 Full API response status:", res.status);
    console.log("📦 Full API response data:", JSON.stringify(res.data, null, 2));

    const data = res.data;
    const finalImageURL = data && data.success ? data.imageUrl : null;

    if (!finalImageURL) {
      const errMsg = (data && (data.error || data.message)) || "Unknown reason";
      console.log("❌ Failed. success:", data && data.success, "| reason:", errMsg);
      api.setMessageReaction("⚠️", reactionMsgID, () => {}, true);
      return api.sendMessage(
        `❌ API Error: ${errMsg}`,
        event.threadID,
        event.messageID
      );
    }

    const cacheDir = path.join(__dirname, "cache");
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
    const filePath = path.join(cacheDir, `${Date.now()}.png`);

    // Stream the image straight to disk instead of buffering the whole
    // thing in memory first — lighter on RAM for larger images.
    const imageResponse = await axios.get(finalImageURL, {
      responseType: "stream",
      timeout: 60000
    });

    const writer = fs.createWriteStream(filePath);
    imageResponse.data.pipe(writer);

    await new Promise((resolve, reject) => {
      writer.on("finish", resolve);
      writer.on("error", reject);
    });

    api.setMessageReaction("🧃", reactionMsgID, () => {}, true);
    api.sendMessage(
      {
        body: "> 🎀 𝐃𝐨𝐧𝐞",
        attachment: fs.createReadStream(filePath)
      },
      event.threadID,
      () => fs.unlinkSync(filePath)
    );
  } catch (err) {
    if (err.response) {
      // Request reached the server but it responded with an error status
      console.log("❌ ERROR status:", err.response.status);
      console.log("❌ ERROR data:", JSON.stringify(err.response.data, null, 2));
    } else if (err.request) {
      // Request was made but no response received (timeout, network, etc.)
      console.log("❌ ERROR: No response received —", err.message);
    } else {
      console.log("❌ ERROR:", err.message);
    }
    api.setMessageReaction("❌", reactionMsgID, () => {}, true);
    api.sendMessage(
      "❌ Error while processing the image.",
      event.threadID,
      event.messageID
    );
  }
}
