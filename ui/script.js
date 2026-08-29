function minimize() {
  window.electronAPI.minimize();
}

function maximize() {
  window.electronAPI.maximize();
}

function closeWindow() {
  window.electronAPI.closeWindow();
}

function toggleOverlay() {
  window.electronAPI.toggleOverlay();
}

function toggleMixer() {
  window.electronAPI.toggleMixer();
}

// Podswietlenie tabu gdy mikser jest otwarty
window.addEventListener("DOMContentLoaded", () => {
  const tab = document.getElementById("mixer-tab");
  if (tab && window.electronAPI && window.electronAPI.onMixerActive) {
    window.electronAPI.onMixerActive((active) => {
      if (active) tab.classList.add("active");
      else tab.classList.remove("active");
    });
  }
});