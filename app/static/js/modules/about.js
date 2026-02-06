/**
 * About modal functionality.
 */
import state from "./state.js";

/**
 * Load version info from the API and populate header badge.
 */
export function loadHeaderVersion() {
  fetch("/api/settings/version")
    .then((r) => r.json())
    .then((data) => {
      state.appVersionData = data;
      const version = data.version || "0.0.0";

      const headerVersion = document.getElementById("header-version");
      if (headerVersion) {
        headerVersion.textContent = version;
      }
    })
    .catch(() => {
      const headerVersion = document.getElementById("header-version");
      if (headerVersion) {
        headerVersion.textContent = "?";
      }
    });
}

export function openAboutModal() {
  const modal = document.getElementById("about-modal");
  if (modal) {
    modal.classList.remove("hidden");
    document.body.style.overflow = "hidden";

    if (state.appVersionData) {
      const aboutVersion = document.getElementById("about-version");
      const aboutCommit = document.getElementById("about-commit");
      const aboutBranch = document.getElementById("about-branch");

      if (aboutVersion)
        aboutVersion.textContent = state.appVersionData.version || "0.0.0";
      if (aboutCommit)
        aboutCommit.textContent = state.appVersionData.commit || "-";
      if (aboutBranch)
        aboutBranch.textContent = state.appVersionData.branch || "-";
    }
  }
}

export function closeAboutModal() {
  const modal = document.getElementById("about-modal");
  if (modal) {
    modal.classList.add("hidden");
    document.body.style.overflow = "";
  }
}

/**
 * Initialize about modal event listeners.
 */
export function initAboutModal() {
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closeAboutModal();
    }
  });

  const modal = document.getElementById("about-modal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) {
        closeAboutModal();
      }
    });
  }
}
