/*
 KINGBOT INTELLIGENCE — FRONTEND CLIENT
 The Gemini provider is never referenced from this browser client.
 The browser communicates only with /api/ai/query.
*/

(function () {
  "use strict";

  function init() {
    const form = document.getElementById("commandForm");
    const input = document.getElementById("commandInput");
    const responseEl = document.getElementById("consoleResponse");
    const history = document.getElementById("history");

    if (!form || !input || !responseEl) return;

    /*
      Replace the existing listener-bearing form so the old
      "backend pending" demo handler cannot also fire.
    */
    const cleanForm = form.cloneNode(true);
    form.replaceWith(cleanForm);

    const cleanInput = cleanForm.querySelector("#commandInput");
    const submitButton = cleanForm.querySelector("button");
    const cleanResponse = document.getElementById("consoleResponse");

    function addMessage(role, text) {
      if (!history) return;

      const empty = history.querySelector("#historyEmpty");
      if (empty) empty.remove();

      const item = document.createElement("div");
      item.className = "history-item";

      const time = document.createElement("div");
      time.className = "history-time";
      time.textContent = new Date().toLocaleTimeString();

      const label = document.createElement("strong");
      label.textContent = role === "user" ? "YOU" : "KINGBOT INTELLIGENCE";
      label.style.display = "block";
      label.style.marginBottom = "7px";
      label.style.color = role === "user" ? "var(--cyan)" : "var(--gold)";

      const body = document.createElement("div");
      body.textContent = text;

      item.appendChild(time);
      item.appendChild(label);
      item.appendChild(body);
      history.prepend(item);
    }

    cleanForm.addEventListener("submit", async function (event) {
      event.preventDefault();

      const message = cleanInput.value.trim();
      if (!message) return;

      cleanInput.disabled = true;
      if (submitButton) submitButton.disabled = true;
      cleanResponse.textContent = "KINGBOT Intelligence is processing your request…";
      addMessage("user", message);

      try {
        const response = await fetch("/api/ai/query", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          credentials: "include",
          body: JSON.stringify({ message })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok || !data.ok) {
          throw new Error(data.error || "AI service unavailable.");
        }

        cleanResponse.textContent = data.answer;
        addMessage("assistant", data.answer);
      } catch (error) {
        const messageText = error?.message || "KINGBOT Intelligence is temporarily unavailable.";
        cleanResponse.textContent = messageText;
        addMessage("assistant", messageText);
      } finally {
        cleanInput.disabled = false;
        if (submitButton) submitButton.disabled = false;
        cleanInput.value = "";
        cleanInput.focus();
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();