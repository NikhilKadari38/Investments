// ─── NK Trade Tracker — Claude Chatbot ───────────────────────────────────────
//
// IMPORTANT FOR GITHUB PAGES DEPLOYMENT:
// Add your Claude API key below. Without it the chatbot won't work on the live site.
// Get one at: https://console.anthropic.com
// Since this is a personal private site, storing it here is acceptable.
//
const CLAUDE_API_KEY = ""; // ← paste your key: "sk-ant-..."
const API_URL        = "https://api.anthropic.com/v1/messages";

let _getContext   = null;
let _chatHistory  = [];

// Called from app.js after trades are loaded
export function initChatbot(contextFn) {
  _getContext = contextFn;
  _bindEvents();
}

function _bindEvents() {
  const toggle   = document.getElementById("chatbotToggle");
  const panel    = document.getElementById("chatbotPanel");
  const closeBtn = document.getElementById("closeChatbot");
  const sendBtn  = document.getElementById("chatSend");
  const input    = document.getElementById("chatInput");

  toggle.addEventListener("click", () => {
    const opening = panel.classList.contains("hidden");
    panel.classList.toggle("hidden");
    if (opening) {
      const msgs = document.getElementById("chatMessages");
      if (msgs.children.length === 0) {
        _appendMsg("assistant", "Hey! Ask me anything about your portfolio or the market 📊");
      }
      input.focus();
    }
  });

  closeBtn.addEventListener("click", () => panel.classList.add("hidden"));
  sendBtn.addEventListener("click", _send);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") _send(); });
}

async function _send() {
  const input = document.getElementById("chatInput");
  const text  = input.value.trim();
  if (!text) return;
  input.value = "";

  _appendMsg("user", text);
  _chatHistory.push({ role: "user", content: text });

  const typingEl = _appendMsg("assistant", "●●●", true);

  try {
    const context = _getContext ? _getContext() : "No data.";
    const headers = {
      "Content-Type": "application/json",
      "anthropic-dangerous-allow-access-from-browser": "true",
    };
    if (CLAUDE_API_KEY) headers["x-api-key"] = CLAUDE_API_KEY;

    const res = await fetch(API_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        max_tokens: 1000,
        system:
          "You are NK's personal trading assistant for his Indian stock market swing trading tracker. " +
          "Current portfolio:\n" + context + "\n\n" +
          "Keep replies concise (2-4 sentences unless analysis needs more). " +
          "Use ₹ for currency. Be helpful, direct, and conversational.",
        messages: _chatHistory.slice(-12),
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err?.error?.message || "API error " + res.status);
    }

    const data  = await res.json();
    const reply = data.content?.[0]?.text ?? "Couldn't process that, sorry.";
    typingEl.textContent = reply;
    typingEl.classList.remove("typing");
    _chatHistory.push({ role: "assistant", content: reply });

    const msgs = document.getElementById("chatMessages");
    msgs.scrollTop = msgs.scrollHeight;
  } catch (e) {
    typingEl.textContent = "Error: " + e.message;
    typingEl.classList.remove("typing");
  }
}

function _appendMsg(role, text, typing = false) {
  const msgs = document.getElementById("chatMessages");
  const el   = document.createElement("div");
  el.className = "chat-msg " + role + (typing ? " typing" : "");
  el.textContent = text;
  msgs.appendChild(el);
  msgs.scrollTop = msgs.scrollHeight;
  return el;
}
