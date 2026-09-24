const axios = require("axios");
const fs = require("fs");
const path = require("path");

module.exports.config = {
  name: "text2img",
  version: "1.0.0",
  hasPermssion: 0,
  credits: "rX",
  description: "Generate an image from a text prompt (Qwen API)",
  commandCategory: "AI",
  usages: "<prompt>",
  cooldowns: 30
};

const API_BASE = "https://qwen-api-gq76.onrender.com/text2img";

module.exports.run = async function ({ api, event, args }) {
  const prompt = args.join(" ").trim();

  if (!prompt) {
    return api.sendMessage(
      "⚠️ Please provide a prompt. Example: text2img a cat flying over Dhaka at sunset",
      event.threadID,
      event.messageID
    );
  }

  api.setMessageReaction("🐣", event.messageID, () => {}, true);

  try {
    const params = new URLSearchParams();
    params.set("prompt", prompt);

    const requestURL = `${API_BASE}?${params.toString()}`;
    console.log("🔗 Request URL:", requestURL);

    const res = await axios.get(requestURL, { timeout: 120000 });
    const data = res.data;
    const finalImageURL = data && data.success ? data.imageUrl : null;

    if (!finalImageURL) {
      const errMsg = (data && (data.error || data.message)) || "Unknown reason";
      console.log("❌ Failed. success:", data && data.success, "| reason:", errMsg);
      api.setMessageReaction("⚠️", event.messageID, () => {}, true);
      return api.sendMessage(`❌ API Error: ${errMsg}`, event.threadID, event.messageID);
    }

    const cacheDir = path.join(__dirname, "cache");
    if (!fs.existsSync(cacheDir)) fs.mkdirSync(cacheDir);
    const filePath = path.join(cacheDir, `${Date.now()}.png`);

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

    api.setMessageReaction("🧃", event.messageID, () => {}, true);
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
      console.log("❌ ERROR status:", err.response.status);
      console.log("❌ ERROR data:", JSON.stringify(err.response.data, null, 2));
    } else if (err.request) {
      console.log("❌ ERROR: No response received —", err.message);
    } else {
      console.log("❌ ERROR:", err.message);
    }
    api.setMessageReaction("❌", event.messageID, () => {}, true);
    api.sendMessage("❌ Error while generating the image.", event.threadID, event.messageID);
  }
};
