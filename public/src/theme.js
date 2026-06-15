export const THEMES = ["onebit", "gb"];
export const DEFAULT_THEME = "onebit";
export const STORAGE_KEY = "oblivion.theme";

export const LANDING_VIDEOS = {
  onebit: "/assets/oblivion-agent-pfp-video-onebit.mp4",
  gb: "/assets/oblivion-agent-pfp-video-gb.mp4",
};

export const AGENT_PFPS = {
  onebit: "/assets/oblivion-agent-pfp-onebit.jpg",
  gb: "/assets/oblivion-agent-pfp.jpg",
};

export function agentPfpForTheme(themeId) {
  return AGENT_PFPS[isValidTheme(themeId) ? themeId : DEFAULT_THEME];
}

export function isValidTheme(id) {
  return THEMES.includes(id);
}

export function readStoredTheme() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return isValidTheme(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

export function applyAgentAvatars(themeId) {
  const src = agentPfpForTheme(themeId);
  document.querySelectorAll(".chat-avatar-agent img").forEach((img) => {
    if (img.getAttribute("src") !== src) img.setAttribute("src", src);
  });
}

export function applyLandingVideo(themeId) {
  const video = document.querySelector(".cinematic-video");
  if (!video) return;
  const src = LANDING_VIDEOS[themeId] || LANDING_VIDEOS[DEFAULT_THEME];
  const source = video.querySelector("source");
  const current = source?.getAttribute("src") || video.getAttribute("src") || "";
  if (current === src) return;
  if (source) {
    source.setAttribute("src", src);
  } else {
    video.setAttribute("src", src);
  }
  video.load();
  video.play().catch(() => {});
}

export function applyTheme(id) {
  const themeId = isValidTheme(id) ? id : DEFAULT_THEME;
  document.documentElement.dataset.theme = themeId;
  document.documentElement.style.colorScheme = "dark";
  applyLandingVideo(themeId);
  applyAgentAvatars(themeId);
  return themeId;
}

export function setTheme(id) {
  const themeId = applyTheme(id);
  try {
    localStorage.setItem(STORAGE_KEY, themeId);
  } catch {
    /* ignore quota / private mode */
  }
  return themeId;
}