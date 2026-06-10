import { createObjectUrl } from "@phantasy/vn-tts";

const STORAGE_KEY = "oblivion.agentVoice";

let activeAudios = [];

export function isAgentVoiceEnabled() {
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return false;
  return localStorage.getItem(STORAGE_KEY) !== "0";
}

export function setAgentVoiceEnabled(enabled) {
  localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
  if (!enabled) stopAgentVoice();
}

export function playCharBeep(char) {
  if (!isAgentVoiceEnabled()) return;
  if (!char || !/[a-zA-Z]/.test(char)) return;

  const url = createObjectUrl({ text: char });
  const audio = new Audio(url);
  audio.volume = 0.35;
  activeAudios.push(audio);
  audio.play().catch(() => {});
  audio.addEventListener(
    "ended",
    () => {
      URL.revokeObjectURL(url);
      activeAudios = activeAudios.filter((item) => item !== audio);
    },
    { once: true }
  );
}

export function stopAgentVoice() {
  for (const audio of activeAudios) {
    audio.pause();
    if (audio.src.startsWith("blob:")) URL.revokeObjectURL(audio.src);
  }
  activeAudios = [];
}