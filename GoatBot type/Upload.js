const axios = require("axios");
const fs = require("fs-extra");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");

// Where the imo bot lives. Override without editing this file by exporting
// IMO_UPLOAD_URL in the environment (or set an "imo"/"upload" key in the
// shared baseApiUrl.json config).
const DEFAULT_UPLOAD_URL = "https://imochat-bot.onrender.com";

const CONFIG_URL =
  "https://raw.githubusercontent.com/abdullahrx07/X-api/refs/heads/main/MaRiA/baseApiUrl.json";

// A chat video is often tens of MB, so download to a temp file and stream it
// back up rather than buffering the whole thing in memory.
const MAX_BYTES = 64 * 1024 * 1024;

let cachedUploadUrl = null;

async function getUploadUrl() {
  if (cachedUploadUrl) return cachedUploadUrl;
  if (process.env.IMO_UPLOAD_URL) {
    cachedUploadUrl = process.env.IMO_UPLOAD_URL.replace(/\/+$/, "");
    return cachedUploadUrl;
  }
  try {
    const res = await axios.get(CONFIG_URL, { timeout: 10000 });
    const parsed = typeof res.data === "object" ? res.data : JSON.parse(res.data);
    const fromConfig = parsed.imo || parsed.upload;
    if (fromConfig) {
      cachedUploadUrl = String(fromConfig).replace(/\/+$/, "");
      return cachedUploadUrl;
    }
  } catch {
    // config is optional; fall through to the default
  }
  cachedUploadUrl = DEFAULT_UPLOAD_URL.replace(/\/+$/, "");
  return cachedUploadUrl;
}

function pickAttachment(event) {
  const list =
    (event.messageReply && event.messageReply.attachments) ||
    event.attachments ||
    [];
  return list.find((a) => a.type === "video" || a.type === "audio") || list[0];
}

function extensionFor(attachment, contentType) {
  const fromName = (attachment.filename || "").match(/\.([a-z0-9]{2,5})$/i);
  if (fromName) return fromName[1].toLowerCase();
  const fromUrl = (attachment.url || "").split("?")[0].match(/\.([a-z0-9]{2,5})$/i);
  if (fromUrl) return fromUrl[1].toLowerCase();
  if (contentType && contentType.includes("mp4")) return "mp4";
  if (contentType && contentType.includes("webm")) return "webm";
  if (contentType && contentType.includes("mpeg")) return "mp3";
  return attachment.type === "audio" ? "mp3" : "mp4";
}

async function downloadToFile(url, dest) {
  const res = await axios.get(url, {
    responseType: "stream",
    timeout: 120000,
    maxContentLength: MAX_BYTES,
    maxBodyLength: Infinity
  });
  const contentType = res.headers["content-type"] || "";
  const declared = parseInt(res.headers["content-length"] || "0", 10);
  if (declared && declared > MAX_BYTES) {
    res.data.destroy();
    throw new Error(`file is too large (${Math.round(declared / 1048576)} MB)`);
  }
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(dest);
    res.data.pipe(out);
    res.data.on("error", reject);
    out.on("error", reject);
    out.on("finish", resolve);
  });
  return { contentType, size: (await fs.stat(dest)).size };
}

async function uploadFile(baseUrl, file, filename, contentType) {
  const { size } = await fs.stat(file);
  // The endpoint reads the raw body using Content-Length, so send it
  // explicitly instead of letting axios pick chunked transfer encoding.
  const res = await axios.post(`${baseUrl}/upload`, fs.createReadStream(file), {
    headers: {
      "Content-Type": contentType || "application/octet-stream",
      "X-Filename": encodeURIComponent(filename),
      "Content-Length": size
    },
    timeout: 180000,
    maxBodyLength: Infinity,
    maxContentLength: Infinity
  });
  if (!res.data || !res.data.ok || !res.data.url) {
    throw new Error((res.data && res.data.error) || "upload returned no url");
  }
  return res.data.url;
}

function readErrorBody(err) {
  const body = err.response && err.response.data;
  if (body && typeof body === "object") {
    return body.error || JSON.stringify(body);
  }
  return err.message;
}

module.exports = {
  config: {
    name: "upload",
    aliases: ["imoup", "imoupload"],
    version: "1.0.0",
    author: "rX",
    countDown: 5,
    role: 0,
    shortDescription: "Upload a video/audio to imo and get a direct link",
    longDescription:
      "Replies to a video (or audio) with a direct download link on the imo CDN. " +
      "Also works when the video is attached to the !upload message itself.",
    category: "media",
    guide: {
      en: "{pn}                (reply to a video)\n{pn} <caption>    (reply to a video)"
    }
  },

  onStart: async function ({ api, event, message }) {
    const attachment = pickAttachment(event);
    if (!attachment || !attachment.url) {
      return message.reply(
        "⚠️ Reply to a video with !upload (or attach a video to the !upload message)."
      );
    }

    const waitMsg = await message.reply("⬆️ Uploading to imo...");
    const tmp = path.join(os.tmpdir(), `imoup-${randomUUID()}.bin`);

    try {
      const baseUrl = await getUploadUrl();
      const sourceUrl = attachment.playableUrl || attachment.url;
      const { contentType, size } = await downloadToFile(sourceUrl, tmp);

      if (size > MAX_BYTES) {
        throw new Error(`file is too large (${Math.round(size / 1048576)} MB)`);
      }

      const ext = extensionFor(attachment, contentType);
      const filename = `${Date.now()}.${ext}`;
      const url = await uploadFile(baseUrl, tmp, filename, contentType);

      const sizeText = `${(size / 1048576).toFixed(2)} MB`;
      await message.reply(`✅ Uploaded (${sizeText})\n🔗 ${url}`);
    } catch (err) {
      const reason = readErrorBody(err);
      await message.reply(`❌ Upload failed.\nReason: ${reason}`);
    } finally {
      await fs.remove(tmp).catch(() => {});
      if (waitMsg && waitMsg.messageID) {
        try {
          api.unsendMessage(waitMsg.messageID);
        } catch {}
      }
    }
  }
};
