function closeTwitch() {
  if (window.electronAPI && window.electronAPI.closeTwitch) {
    window.electronAPI.closeTwitch();
  }
}

// Wskaznik "na zywo" z maina
window.addEventListener("DOMContentLoaded", () => {
  if (window.electronAPI && window.electronAPI.onTwitchLive) {
    window.electronAPI.onTwitchLive((live) => {
      const dot = document.getElementById("live-dot");
      const badge = document.getElementById("live-badge");
      if (dot) dot.classList.toggle("live", !!live);
      if (badge) badge.classList.toggle("visible", !!live);
    });
  }
});
